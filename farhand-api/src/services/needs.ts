import { Prisma } from "@prisma/client";
import type { Need, NeedStatus, User } from "@prisma/client";
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
 * Needs: the rules about who may do what to a listing.
 *
 * This is the first file in src/services/, and the reason it exists is issue
 * #15's first line: "ownership enforced in the service layer, not only in
 * routes". A route's job is to read the request and write the response. If the
 * rule "only the requester may edit this" lives in the route, then the day a
 * second caller appears — an admin screen, a background job, a second endpoint
 * that touches needs — the rule has to be remembered and copied. Rules that
 * are copied are rules that drift.
 *
 * So: routes validate input and turn results into JSON. Everything below
 * decides what is allowed, and answers with HttpError when it is not.
 *
 * The rules themselves are not invented here. They are in
 * docs/02-roles-and-permissions.md and docs/06-api-contract.md:
 *
 *   edit or delete   only the requester, and only while DRAFT or OPEN
 *   delete           not while a live deal exists
 *   create           limited to a few open needs per account
 */

/**
 * How many OPEN needs one account may have at once.
 *
 * docs/07-trust-and-safety.md lists "limit on open listings" as one of the
 * three defences against spam listings, alongside email confirmation and rate
 * limits. Drafts do not count: they are private, and nobody can be spammed by
 * a draft. Closed, expired and matched needs do not count either — the limit
 * is about how much of the public list one person can occupy right now.
 */
export const MAX_OPEN_NEEDS = 5;

/**
 * The fields a caller may set when creating a need.
 *
 * The three that may be empty are "string | null", never undefined: they
 * match the nullable columns in prisma/schema.prisma, and the schema in
 * ../routes/needs.js has already turned a missing value into null.
 */
export interface CreateNeedInput {
  categoryId: string;
  title: string;
  description: string;
  productUrl: string | null;
  storeName: string | null;
  buyCountry: string;
  deliverCountry: string;
  currency: string;
  estimatedPrice: number;
  thankYouAmount: number;
  status: Extract<NeedStatus, "DRAFT" | "OPEN">;
  expiresAt: Date | null;
  /**
   * The prohibited list this is being posted against (#87). Optional in the
   * type because a draft needs none; required by the service when the thing
   * is going public, which is the one place that knows.
   */
  prohibitedVersion?: string | undefined;
}

/**
 * The fields a caller may change afterwards: all of them, all optional.
 *
 * Written out rather than Partial<CreateNeedInput> because Zod's .partial()
 * types every key as possibly undefined, and tsconfig's
 * exactOptionalPropertyTypes treats "absent" and "present and undefined" as
 * different things.
 */
export type UpdateNeedInput = {
  [K in keyof CreateNeedInput]?: CreateNeedInput[K] | undefined;
};

/**
 * Enforces MAX_OPEN_NEEDS. Shared by create and by publishing a draft — the
 * limit applies the same way whichever path reaches OPEN.
 */
async function assertUnderOpenNeedsLimit(requesterId: string): Promise<void> {
  const openCount = await prisma.need.count({
    where: { requesterId, status: "OPEN" },
  });

  if (openCount >= MAX_OPEN_NEEDS) {
    throw HttpError.conflict(
      `You already have ${String(MAX_OPEN_NEEDS)} open needs. Close one first.`,
    );
  }
}

/**
 * Loads a need that this user is allowed to change, or explains why not.
 *
 * The ownership rule lives here rather than in each function, which is what
 * issue #15 means by enforcing it in the service layer: one place to read, one
 * place to change, and nothing for #16's /me/needs or #19's proposals to copy.
 *
 * 403 rather than 404 for someone else's need, unlike most of this API: a need
 * is public (GET /needs/:id is open to anyone), so refusing tells the caller
 * nothing they could not already read. The 404-instead-of-403 rule in
 * docs/06-api-contract.md is about things you may not know exist.
 */
async function loadOwnNeed(actor: User, needId: string): Promise<Need> {
  const need = await prisma.need.findUnique({ where: { id: needId } });

  if (!need) {
    throw HttpError.notFound("Need not found");
  }

  if (need.requesterId !== actor.id) {
    throw HttpError.forbidden("This need belongs to someone else");
  }

  return need;
}

/**
 * The statuses a need may still be changed in — its words and its photos.
 *
 * Once it is MATCHED somebody has agreed to shop for exactly what it said, and
 * changing it afterwards would change the deal under their feet. Listed rather
 * than written as "not MATCHED and not CLOSED and…", so a status added one day
 * is refused until somebody decides otherwise.
 */
const EDITABLE_STATUSES: readonly NeedStatus[] = ["DRAFT", "OPEN"];

/**
 * Loads a need this user may change, or explains why not: the owner check
 * above plus the two statuses it may be changed in.
 *
 * Exported because #81's photos are the second caller. A photo is part of what
 * a need says, so "who may change this need" has to be one answer, in one
 * place — including the 403, which is the unusual half (see `loadOwnNeed`) and
 * exactly the kind of thing a second copy would get wrong.
 */
export async function loadEditableOwnNeed(
  actor: User,
  needId: string,
): Promise<Need> {
  const need = await loadOwnNeed(actor, needId);

  if (!EDITABLE_STATUSES.includes(need.status)) {
    throw HttpError.conflict("This need can no longer be edited");
  }

  return need;
}

/**
 * Creates a need for this user. A draft skips the open-needs limit: nobody can
 * be spammed by something only its author can see.
 */
export async function createNeed(
  actor: User,
  input: CreateNeedInput,
): Promise<Need> {
  if (input.status === "OPEN") {
    await assertUnderOpenNeedsLimit(actor.id);
  }

  // PULLED OUT OF THE SPREAD, and that is the forgery guard (#87). Everything
  // else in `input` is copied onto the row as the caller sent it; the version
  // must not be, or a client could write whatever it liked into the column
  // that records what it agreed to. What lands there is the version this
  // service checked, written by `acknowledgementFields`.
  const { prohibitedVersion, ...fields } = input;

  try {
    // One transaction, so the list cannot be reworded between the check and
    // the row: the version recorded is the version that was verified.
    return await prisma.$transaction(async (tx) => {
      const acknowledged = needsAcknowledgement(false, fields.status === "OPEN")
        ? acknowledgementFields(
            await checkAcknowledgement(prohibitedVersion, tx),
          )
        : {};

      return tx.need.create({
        data: {
          requesterId: actor.id,
          ...fields,
          ...acknowledged,
        },
      });
    });
  } catch (error) {
    if (isForeignKeyError(error)) {
      throw HttpError.badRequest("Unknown category");
    }
    throw error;
  }
}

/**
 * Changes a need the user owns.
 *
 * Only while the need is a draft or open. Once it is MATCHED someone has
 * agreed to shop for exactly what it said, and editing it afterwards would
 * change the deal under their feet.
 */
export async function updateNeed(
  actor: User,
  needId: string,
  input: UpdateNeedInput,
): Promise<Need> {
  const need = await loadEditableOwnNeed(actor, needId);

  const isPublishing = need.status === "DRAFT" && input.status === "OPEN";
  if (isPublishing) {
    await assertUnderOpenNeedsLimit(actor.id);
  }

  const { prohibitedVersion, ...fields } = input;

  // The hole #87 exists to close: `updateNeedSchema` is
  // `createNeedSchema.partial()`, so the tick that is required on create is
  // optional here — and a draft was created without one. Publishing is asked
  // the same question as posting, because it is the same event.
  const goingPublic = needsAcknowledgement(
    need.status === "OPEN",
    (fields.status ?? need.status) === "OPEN",
  );

  try {
    return await prisma.$transaction(async (tx) => {
      const acknowledged = goingPublic
        ? acknowledgementFields(
            await checkAcknowledgement(prohibitedVersion, tx),
          )
        : {};

      return tx.need.update({
        where: { id: needId },
        data: { ...onlyProvided(fields), ...acknowledged },
      });
    });
  } catch (error) {
    if (isForeignKeyError(error)) {
      throw HttpError.badRequest("Unknown category");
    }
    throw error;
  }
}

/**
 * Takes a need down — by closing it, not by erasing it. Proposals and messages
 * point at this need, and "soft deletion everywhere" is a deliberate choice in
 * docs/05-data-model.md: the history has to survive. CLOSED is the requester
 * taking it down; REMOVED is a moderator doing it (#27).
 *
 * Refused while a deal is live, meaning any deal that is not CANCELLED — the
 * same definition the database's one_active_deal_per_need index uses. Someone
 * is shopping for this; it cannot vanish from under them.
 *
 * Closing an already closed need is not an error: the second request wants the
 * state the first one already reached.
 */
export async function deleteNeed(actor: User, needId: string): Promise<void> {
  const need = await loadOwnNeed(actor, needId);

  if (need.status === "CLOSED") {
    return;
  }

  const liveDeal = await prisma.deal.findFirst({
    where: { needId, status: { not: "CANCELLED" } },
  });

  if (liveDeal) {
    throw HttpError.conflict(
      "This need has an active deal and cannot be closed",
    );
  }

  await prisma.need.update({
    where: { id: needId },
    data: { status: "CLOSED" },
  });
}

/**
 * Prisma's "you referenced a row that does not exist" error — here, a
 * categoryId that matches no category.
 */
function isForeignKeyError(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2003"
  );
}

/* ───────────────────────────── browsing (#16) ───────────────────────────── */

/** What a caller may narrow the public list by. */
export interface NeedFilters {
  buyCountry?: string | undefined;
  deliverCountry?: string | undefined;
  categoryId?: string | undefined;
  /** Free text, matched against the title and the description. */
  q?: string | undefined;
}

/**
 * The public list: open needs, newest first.
 */
export async function listOpenNeeds(
  filters: NeedFilters,
  position: CursorPosition | undefined,
  limit: number,
): Promise<Page<Need>> {
  const rows = await prisma.need.findMany({
    where: {
      status: "OPEN",
      ...(filters.buyCountry ? { buyCountry: filters.buyCountry } : {}),
      ...(filters.deliverCountry
        ? { deliverCountry: filters.deliverCountry }
        : {}),
      ...(filters.categoryId ? { categoryId: filters.categoryId } : {}),
      AND: [
        afterCursor(position),
        filters.q
          ? {
              OR: [
                { title: { contains: filters.q, mode: "insensitive" } },
                { description: { contains: filters.q, mode: "insensitive" } },
              ],
            }
          : {},
      ],
    },
    orderBy: NEWEST_FIRST,
    take: limit + 1,
  });

  return toPage(rows, limit);
}

/**
 * One need, if this caller may see it.
 */
export async function getVisibleNeed(
  needId: string,
  viewerId: string | undefined,
): Promise<Need> {
  const need = await prisma.need.findUnique({ where: { id: needId } });

  if (!need) {
    throw HttpError.notFound("Need not found");
  }

  const isOwner = need.requesterId === viewerId;
  const isPubliclyVisible = need.status === "OPEN" || need.status === "MATCHED";

  if (!isOwner && !isPubliclyVisible) {
    throw HttpError.notFound("Need not found");
  }

  return need;
}

/**
 * The caller's own needs, every status, newest first.
 */
export async function listMyNeeds(
  actor: User,
  position: CursorPosition | undefined,
  limit: number,
): Promise<Page<Need>> {
  const rows = await prisma.need.findMany({
    // AND rather than a spread, for the reason listOpenNeeds needs it: the
    // day this list gains a filter of its own that uses OR, a spread would
    // silently replace the cursor's condition instead of adding to it.
    where: { requesterId: actor.id, AND: [afterCursor(position)] },
    orderBy: NEWEST_FIRST,
    take: limit + 1,
  });

  return toPage(rows, limit);
}
