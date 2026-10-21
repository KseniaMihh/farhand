import { Prisma } from "@prisma/client";
import { HttpError } from "../errors.js";

/**
 * Small pieces shared by the listing services.
 *
 * Needs (#15, #16) and helps (#17, #18) are different products with the same
 * shape underneath: rows someone owns, paged the same way. What genuinely
 * repeats lives here; what differs stays in each service.
 */

/**
 * Prisma's "you referenced a row that does not exist" error — a categoryId
 * that matches no category, whether it arrived on a need (#15), an offer
 * (#17) or a saved search (#90).
 *
 * Here rather than in one of them since #90, because the third caller is the
 * point at which a copy becomes a copy: a need importing it from a saved
 * search, which imports the need service back, is a cycle nobody needs.
 */
export function isForeignKeyError(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2003"
  );
}

/** The same fields with the undefineds gone: what Prisma's update accepts. */
type Provided<T> = { [K in keyof T]?: Exclude<T[K], undefined> };

/**
 * Drops the keys whose value is undefined.
 *
 * Prisma wants a field it should not change to be absent, while a parsed PATCH
 * body is typed as if every key might be present and undefined. At runtime the
 * two already agree — a parsed body only carries the keys it mentioned — so
 * this states that in the type system, in one place.
 */
export function onlyProvided<T extends object>(input: T): Provided<T> {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined),
  ) as Provided<T>;
}

/* ────────────────────────────── paging ────────────────────────────── */

/** How many rows a page holds when the caller does not say. */
export const DEFAULT_PAGE_SIZE = 20;

/** The most a caller may ask for in one page. */
export const MAX_PAGE_SIZE = 50;

/** One page of anything, in the shape docs/06-api-contract.md defines. */
export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

/**
 * Where a page starts: the createdAt and id of the last row of the page
 * before it.
 *
 * Both, not just the id, because several rows can share a createdAt — a seeded
 * database, or a busy second. Sorting by createdAt alone leaves their order
 * undefined, so a row can appear on two pages, or on none
 * (docs/11-risks.md).
 */
export interface CursorPosition {
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
 * The order every keyset list is sorted by.
 *
 * Not decoration: afterCursor() below assumes exactly this order, and a cursor
 * is only meaningful against it. Change the order in one list and that list
 * pages wrongly — no error, just rows quietly served twice or skipped — so the
 * two live next to each other and are used together.
 */
export const NEWEST_FIRST = [
  { createdAt: "desc" as const },
  { id: "desc" as const },
];

/**
 * The "everything after this position" condition, in the order every list here
 * is sorted: newest first, and for a tie, the larger id first.
 *
 * Returned as a plain object rather than a Prisma type, because needs and
 * helps have different where-types and the condition is identical for both.
 * Put it in an AND array rather than spreading it: it uses OR, and so do some
 * filters, and two ORs in one object means the second wins silently.
 */
export function afterCursor(position?: CursorPosition) {
  return afterCursorOn("createdAt", position);
}

/**
 * The same condition on a different timestamp column.
 *
 * The inbox is ordered by `lastMessageAt` — the column exists for that, see
 * schema.prisma — so its cursor has to compare that column and not
 * `createdAt`. Everything else about keyset paging is unchanged, which is why
 * this is one function with the column as an argument rather than a second
 * copy of the logic that could drift from the first.
 */
export function afterCursorOn(field: string, position?: CursorPosition) {
  if (!position) return {};

  return {
    OR: [
      { [field]: { lt: position.createdAt } },
      { [field]: position.createdAt, id: { lt: position.id } },
    ],
  };
}

/** NEWEST_FIRST on a different timestamp column, for the same reason. */
export function newestFirstOn(field: string) {
  return [{ [field]: "desc" as const }, { id: "desc" as const }];
}

/**
 * The other direction, for the one list that is a queue.
 *
 * Everything people browse is newest first: the latest needs, the latest
 * offers, the last thing anybody said. The moderator queue is not a list to
 * browse — it is work waiting to be done, and the report that has waited
 * longest is the one that matters most (docs/07-trust-and-safety.md, "the
 * report enters the moderator queue, ordered oldest first").
 */
export const OLDEST_FIRST = [
  { createdAt: "asc" as const },
  { id: "asc" as const },
];

/**
 * "Everything after this position", counting forwards.
 *
 * The mirror of afterCursor: `gt` where that one has `lt`, because the list it
 * pages runs the other way. Pairing the wrong one with an order is the bug this
 * whole family of functions exists to make obvious — a cursor is only
 * meaningful against the sort it was built for, so OLDEST_FIRST and this are
 * used together, as NEWEST_FIRST and afterCursor are.
 */
export function afterCursorOldest(position?: CursorPosition) {
  if (!position) return {};

  return {
    OR: [
      { createdAt: { gt: position.createdAt } },
      { createdAt: position.createdAt, id: { gt: position.id } },
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
export function toPage<T extends CursorPosition>(
  rows: T[],
  limit: number,
): Page<T> {
  return toPageWith(rows, limit, (row) => row);
}

/**
 * The same, for rows whose position is not their own `createdAt`.
 *
 * `positionOf` says which timestamp the cursor is built from — the inbox is
 * ordered by `lastMessageAt`, so that is what its cursor has to carry.
 */
export function toPageWith<T>(
  rows: T[],
  limit: number,
  positionOf: (row: T) => CursorPosition,
): Page<T> {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items.at(-1);

  return {
    items,
    nextCursor: hasMore && last ? encodeCursor(positionOf(last)) : null,
  };
}

/**
 * A page read backwards but shown forwards.
 *
 * Messages page like a chat window: the first request returns the newest
 * handful, the cursor asks for the ones before those — but within a page they
 * read oldest to newest, the way a conversation is read (issue #21). Only the
 * order of `items` changes; the cursor still comes from the last row of the
 * query, which is the oldest message on the page and therefore the right place
 * for the next one to start.
 */
export function toPageOldestFirst<T extends CursorPosition>(
  rows: T[],
  limit: number,
): Page<T> {
  const page = toPage(rows, limit);

  return { ...page, items: [...page.items].reverse() };
}
