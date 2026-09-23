import { Prisma } from "@prisma/client";
import type { Need, NeedStatus, User } from "@prisma/client";
import { prisma } from "../db.js";
import { HttpError } from "../errors.js";

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

/** The same fields with the undefineds gone: what Prisma's update accepts. */
type Provided<T> = { [K in keyof T]?: Exclude<T[K], undefined> };

/**
 * Drops the keys whose value is undefined.
 *
 * Prisma wants a field it should not change to be absent, while the parsed
 * PATCH body is typed as if every key might be present and undefined. At
 * runtime the two already agree — a parsed body only carries the keys it
 * mentioned — so this states that in the type system, in one place.
 */
export function onlyProvided<T extends object>(input: T): Provided<T> {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined),
  ) as Provided<T>;
}

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

  try {
    return await prisma.need.create({
      data: {
        requesterId: actor.id,
        ...input,
      },
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
  const need = await loadOwnNeed(actor, needId);

  if (need.status !== "DRAFT" && need.status !== "OPEN") {
    throw HttpError.conflict("This need can no longer be edited");
  }

  const isPublishing = need.status === "DRAFT" && input.status === "OPEN";
  if (isPublishing) {
    await assertUnderOpenNeedsLimit(actor.id);
  }

  try {
    return await prisma.need.update({
      where: { id: needId },
      data: onlyProvided(input),
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

/** How many needs a page holds when the caller does not say. */
export const DEFAULT_PAGE_SIZE = 20;

/** The most a caller may ask for in one page. */
export const MAX_PAGE_SIZE = 50;

/** What a caller may narrow the public list by. */
export interface NeedFilters {
  buyCountry?: string | undefined;
  deliverCountry?: string | undefined;
  categoryId?: string | undefined;
  /** Free text, matched against the title and the description. */
  q?: string | undefined;
}

/** One page of anything, in the shape docs/06-api-contract.md defines. */
export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

/**
 * Where a page starts: the createdAt and id of the last row of the page
 * before it.
 *
 * Both, not just the id, because several needs can share a createdAt — a
 * seeded database or a busy second. Sorting by createdAt alone leaves their
 * order undefined, so a row can appear on two pages, or on none
 * (docs/11-risks.md).
 */
interface CursorPosition {
  createdAt: Date;
  id: string;
}

/**
 * Packs a position into one opaque string for the client to send back.
 *
 * base64url of "<iso date>|<id>". Opaque on purpose: a client that takes it
 * apart and builds its own would be relying on a shape we want to stay free to
 * change. It is not a secret — anyone can decode it — it is simply not an API.
 */
export function encodeCursor(position: CursorPosition): string {
  const raw = `${position.createdAt.toISOString()}|${position.id}`;
  return Buffer.from(raw, "utf8").toString("base64url");
}

/** Unpacks a cursor, or refuses it. */
export function decodeCursor(cursor: string): CursorPosition {
  const [date, id] = Buffer.from(cursor, "base64url")
    .toString("utf8")
    .split("|");
  const createdAt = date === undefined ? new Date(NaN) : new Date(date);

  if (!id || Number.isNaN(createdAt.getTime())) {
    throw new HttpError(422, "VALIDATION_FAILED", "Invalid cursor");
  }

  return { createdAt, id };
}

/**
 * The "everything after this position" condition, in the order the list is
 * sorted: newest first, and for a tie, the larger id first.
 */
function afterCursor(position?: CursorPosition): Prisma.NeedWhereInput {
  if (!position) return {};

  return {
    OR: [
      { createdAt: { lt: position.createdAt } },
      { createdAt: position.createdAt, id: { lt: position.id } },
    ],
  };
}

/**
 * Turns the rows of a keyset query into a page.
 *
 * Every list asks for one row more than it needs. If that extra row came back
 * there is another page, and the last row being returned becomes the cursor
 * for it — which is cheaper than a second query counting the rest.
 */
function toPage(rows: Need[], limit: number): Page<Need> {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items.at(-1);

  return { items, nextCursor: hasMore && last ? encodeCursor(last) : null };
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
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
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
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
  });

  return toPage(rows, limit);
}
