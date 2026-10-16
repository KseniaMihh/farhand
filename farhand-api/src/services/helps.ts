import { Prisma } from "@prisma/client";
import type { Help, HelpStatus, User } from "@prisma/client";
import { prisma } from "../db.js";
import { HttpError } from "../errors.js";
import {
  acknowledgementFields,
  checkAcknowledgement,
  needsAcknowledgement,
} from "./prohibited.js";
import {
  afterCursor,
  NEWEST_FIRST,
  type CursorPosition,
  onlyProvided,
  type Page,
  toPage,
} from "./shared.js";

/**
 * Helps: what someone offers to carry.
 *
 * The mirror of a need. Somebody in Japan says "I live here, I can buy things
 * and post them to Estonia and Finland" — and the same rules as needs apply
 * about who may touch it (docs/02-roles-and-permissions.md).
 *
 * Two things work differently from needs, and both are in issue #17:
 *
 *   CATEGORIES ARE MANY-TO-MANY. A need is filed under one category; a helper
 *   offers to shop across several, so a help has a list. Prisma calls the
 *   operations `connect` (add these) and `set` (replace with exactly these).
 *
 *   shipsTo IS A LIST OF COUNTRIES, AND EMPTY MEANS ANYWHERE. Not "nowhere" —
 *   the schema says so (prisma/schema.prisma) and the browse filter in #18
 *   depends on it.
 */

/** The most categories one offer may claim. */
export const MAX_HELP_CATEGORIES = 10;

/** The most countries one offer may list. Empty still means anywhere. */
export const MAX_SHIPS_TO = 50;

/** The fields a caller may set when creating an offer. */
export interface CreateHelpInput {
  country: string;
  shipsTo: string[];
  description: string;
  categoryIds: string[];
  status: Extract<HelpStatus, "ACTIVE" | "PAUSED">;
  /** As on a need (#87): optional here, required when going public. */
  prohibitedVersion?: string | undefined;
}

/** The fields a caller may change afterwards. All optional. */
export type UpdateHelpInput = {
  [K in keyof CreateHelpInput]?: CreateHelpInput[K] | undefined;
};

/** An offer with its categories, which is how callers want to read one. */
export type HelpWithCategories = Help & {
  categories: { id: string; slug: string; name: string }[];
};

/** Always return categories with an offer: an offer without them is half a listing. */
const withCategories = {
  categories: { select: { id: true, slug: true, name: true } },
} as const;

/**
 * Loads an offer this user is allowed to change, or explains why not.
 *
 * The same shape as loadOwnNeed in ./needs.js, and the same reasoning: the
 * ownership rule belongs in one place per service, not in each function.
 */
async function loadOwnHelp(
  actor: User,
  helpId: string,
): Promise<HelpWithCategories> {
  const help = await prisma.help.findUnique({
    where: { id: helpId },
    include: withCategories,
  });

  if (!help) {
    throw HttpError.notFound("Help not found");
  }

  if (help.helperId !== actor.id) {
    throw HttpError.forbidden("This offer belongs to someone else");
  }

  return help;
}

/**
 * Posts an offer.
 */
export async function createHelp(
  actor: User,
  input: CreateHelpInput,
): Promise<HelpWithCategories> {
  try {
    // One transaction, so the list cannot be reworded between the check and
    // the row (#87). The version is named field by field here rather than
    // spread, which is also why nothing a client sends can reach the column
    // that records what it agreed to.
    return await prisma.$transaction(async (tx) => {
      const acknowledged = needsAcknowledgement(
        false,
        input.status === "ACTIVE",
      )
        ? acknowledgementFields(
            await checkAcknowledgement(input.prohibitedVersion, tx),
          )
        : {};

      return tx.help.create({
        data: {
          helperId: actor.id,
          country: input.country,
          shipsTo: input.shipsTo,
          description: input.description,
          status: input.status,
          ...acknowledged,
          categories: {
            connect: input.categoryIds.map((id) => ({ id })),
          },
        },
        include: withCategories,
      });
    });
  } catch (error) {
    if (isMissingRelated(error)) {
      throw HttpError.badRequest("Unknown category");
    }
    throw error;
  }
}

/**
 * Changes an offer the user owns.
 */
export async function updateHelp(
  actor: User,
  helpId: string,
  input: UpdateHelpInput,
): Promise<HelpWithCategories> {
  const help = await loadOwnHelp(actor, helpId);

  if (help.status === "REMOVED") {
    throw HttpError.conflict("This offer can no longer be edited");
  }

  const { categoryIds, prohibitedVersion, ...rest } = input;

  // Activating a paused offer is publishing it, and is asked the same question
  // as posting one (#87) — the `PAUSED` twin of a need's draft.
  const goingPublic = needsAcknowledgement(
    help.status === "ACTIVE",
    (rest.status ?? help.status) === "ACTIVE",
  );

  try {
    return await prisma.$transaction(async (tx) => {
      const acknowledged = goingPublic
        ? acknowledgementFields(
            await checkAcknowledgement(prohibitedVersion, tx),
          )
        : {};

      return tx.help.update({
        where: { id: helpId },
        data: {
          ...onlyProvided(rest),
          ...acknowledged,
          ...(categoryIds
            ? { categories: { set: categoryIds.map((id) => ({ id })) } }
            : {}),
        },
        include: withCategories,
      });
    });
  } catch (error) {
    if (isMissingRelated(error)) {
      throw HttpError.badRequest("Unknown category");
    }
    throw error;
  }
}

/**
 * Takes an offer down.
 */
export async function deleteHelp(actor: User, helpId: string): Promise<void> {
  const help = await loadOwnHelp(actor, helpId);

  if (help.status === "REMOVED") {
    return;
  }

  await prisma.help.update({
    where: { id: helpId },
    data: { status: "REMOVED" },
  });
}

/**
 * Prisma's "the rows you asked me to connect are not there" error.
 *
 * Different from the foreign key error a need gets for the same mistake, which
 * is why needs and helps each recognise their own.
 */
function isMissingRelated(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2025"
  );
}

/* ───────────────────────────── browsing (#18) ───────────────────────────── */

/** What a caller may narrow the public list of offers by. */
export interface HelpFilters {
  /** Where the helper is: an exact match. */
  country?: string | undefined;
  /** "I need it sent to EE" — see the note in listActiveHelps. */
  shipsTo?: string | undefined;
  categoryId?: string | undefined;
}

/**
 * The public list: active offers, newest first.
 */
export async function listActiveHelps(
  filters: HelpFilters,
  position: CursorPosition | undefined,
  limit: number,
): Promise<Page<HelpWithCategories>> {
  const rows = await prisma.help.findMany({
    where: {
      status: "ACTIVE",
      ...(filters.country ? { country: filters.country } : {}),
      ...(filters.categoryId
        ? { categories: { some: { id: filters.categoryId } } }
        : {}),
      AND: [
        afterCursor(position),
        filters.shipsTo
          ? {
              OR: [
                { shipsTo: { isEmpty: true } },
                { shipsTo: { has: filters.shipsTo } },
              ],
            }
          : {},
      ],
    },
    include: withCategories,
    orderBy: NEWEST_FIRST,
    take: limit + 1,
  });

  return toPage(rows, limit);
}

/**
 * One offer, if this caller may see it.
 */
export async function getVisibleHelp(
  helpId: string,
  viewerId: string | undefined,
): Promise<HelpWithCategories> {
  const help = await prisma.help.findUnique({
    where: { id: helpId },
    include: withCategories,
  });

  if (!help) {
    throw HttpError.notFound("Help not found");
  }

  const isOwner = help.helperId === viewerId;
  const isPubliclyVisible = help.status === "ACTIVE";

  if (!isOwner && !isPubliclyVisible) {
    throw HttpError.notFound("Help not found");
  }

  return help;
}
