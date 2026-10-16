import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { HttpError } from "../errors.js";

/**
 * The prohibited list, and the tick that says somebody read it (#87).
 *
 * docs/07-trust-and-safety.md puts this FIRST among the defences against
 * prohibited or illegal items, ahead of reports and moderation — because
 * those two happen after something has been posted, and this is the only one
 * that happens before.
 *
 * It is also the weakest-looking defence here, and worth being honest about:
 * a checkbox stops nobody determined. What it does is remove "I didn't know",
 * give a moderator something to point at, and put the rules in front of
 * somebody at the one moment they are deciding what to post. There is no
 * automatic detection, and docs/11-risks.md says so rather than implying
 * otherwise.
 *
 * prohibited list: see docs/07-trust-and-safety.md
 * what is recorded: see docs/10-decisions/0021-a-tick-against-wording.md
 */

/** How long a fingerprint is. Enough to be unique, short enough to read. */
const VERSION_LENGTH = 16;

/** One line of the list, as a person reads it. */
export interface ProhibitedLine {
  slug: string;
  text: string;
}

/** The list as it stands, with the fingerprint of this exact wording. */
export interface ProhibitedList {
  version: string;
  items: ProhibitedLine[];
}

/**
 * The published list, in order, and its fingerprint.
 *
 * THE FINGERPRINT IS COMPUTED, NOT STORED, and that is the point of it. A
 * `version` column would be a number somebody has to remember to bump after
 * rewording a line in Neon — and the one time they forget, every
 * acknowledgement afterwards records agreement to wording nobody agreed to.
 * A hash of the rows cannot be forgotten.
 *
 * It covers the slug, the text and the order, because all three are what a
 * person saw. Retired lines are left out: they are not shown, so they are not
 * part of what was read (their rows stay for the sake of old acknowledgements
 * that mention them).
 */
export async function publishedList(
  client: Prisma.TransactionClient = prisma,
): Promise<ProhibitedList> {
  const rows = await client.prohibitedItem.findMany({
    where: { retiredAt: null },
    orderBy: [{ position: "asc" }, { slug: "asc" }],
    select: { slug: true, text: true },
  });

  return { version: fingerprint(rows), items: rows };
}

/**
 * The fingerprint of a list.
 *
 * `\u0000` as the separator, which no text can contain: joining on a comma
 * would make ["a,b"] and ["a", "b"] the same list, and a fingerprint that two
 * different lists share is a fingerprint that can be ticked against the wrong
 * wording.
 */
function fingerprint(items: ProhibitedLine[]): string {
  const canonical = items
    .map((item) => `${item.slug}\u0000${item.text}`)
    .join("\u0000\u0000");

  return createHash("sha256")
    .update(canonical)
    .digest("hex")
    .slice(0, VERSION_LENGTH);
}

/**
 * Whether a change needs a tick.
 *
 * "Posting a need or a help requires acknowledging it" sounds like a rule
 * about `POST /needs`. It is not, quite: both a need and a help can be created
 * in a state nobody else can see — `DRAFT` for a need, `PAUSED` for a help —
 * and both can be made public later with a PATCH whose schema is
 * `create…Schema.partial()`, where every field is optional.
 *
 * Put together, that is a way in: save a draft with no tick, then publish it.
 * The listing becomes public having acknowledged nothing, and a client would
 * do it without meaning to, because that is simply what publishing a draft
 * looks like.
 *
 * So the rule is about BECOMING PUBLIC, and nothing else:
 *
 *   not public → public     required
 *   public → public         already ticked; asking again on every edit would
 *                           teach people to tick without reading
 *   anything → not public   nothing to acknowledge; nobody can see it
 */
export function needsAcknowledgement(
  wasPublic: boolean,
  willBePublic: boolean,
): boolean {
  return willBePublic && !wasPublic;
}

/**
 * Checks a tick against the list as it is right now, and gives back the
 * version to record.
 *
 *   missing          422, naming the field. Never "they probably meant yes"
 *   not the current  409 PROHIBITED_LIST_CHANGED, carrying today's list
 *   the current one  allowed
 *
 * Read inside the caller's transaction, so the list cannot be reworded
 * between the check and the row being written: the version recorded is the
 * version that was verified.
 */
export async function checkAcknowledgement(
  acknowledgedVersion: string | undefined,
  client: Prisma.TransactionClient = prisma,
): Promise<string> {
  const list = await publishedList(client);

  // AN EMPTY LIST IS OUR BUG, NOT THE CALLER'S, and it must not be allowed to
  // pass quietly. The table is seeded by hand after a migration, like the
  // categories (docs/14-deployment.md) — and if somebody forgets, every
  // posting would otherwise tick the fingerprint of nothing and be recorded as
  // having acknowledged a list with no lines in it. That is worse than a
  // failure, because it looks like success.
  //
  // A plain Error rather than an HttpError: 500, the real reason in the log
  // and in Sentry (#29), and nothing about our configuration in the answer.
  if (list.items.length === 0) {
    throw new Error(
      "The prohibited list is empty, so nothing can be published against it. " +
        "Run `npm run seed` against this database (docs/14-deployment.md).",
    );
  }

  if (acknowledgedVersion === undefined) {
    // The same shape a failed Zod parse produces, because to a client this is
    // the same kind of mistake: a required field that is not there. It is
    // thrown here rather than demanded by the schema because whether it is
    // required depends on the status being asked for, which a schema for one
    // body cannot know (the same settlement as a deal transition's fields).
    throw HttpError.validationFailed(
      "Acknowledging the prohibited items is required to post this publicly",
      [
        {
          field: "prohibitedVersion",
          message: `Send the version from GET /prohibited-items (currently ${list.version})`,
        },
      ],
    );
  }

  if (acknowledgedVersion !== list.version) {
    // 409 rather than 422: the request was right when it was written, and the
    // world moved. The answer carries the current list so a client can show
    // what changed and ask again, rather than guessing what it missed.
    throw HttpError.prohibitedListChanged(list);
  }

  return list.version;
}

/** What to write on a row that has just been acknowledged. */
export function acknowledgementFields(version: string): {
  prohibitedVersion: string;
  prohibitedAckAt: Date;
} {
  return { prohibitedVersion: version, prohibitedAckAt: new Date() };
}
