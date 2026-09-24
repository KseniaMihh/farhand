import { HttpError } from "../errors.js";

/**
 * Small pieces shared by the listing services.
 *
 * Needs (#15, #16) and helps (#17, #18) are different products with the same
 * shape underneath: rows someone owns, paged the same way. What genuinely
 * repeats lives here; what differs stays in each service.
 */

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
 * The "everything after this position" condition, in the order every list here
 * is sorted: newest first, and for a tie, the larger id first.
 *
 * Returned as a plain object rather than a Prisma type, because needs and
 * helps have different where-types and the condition is identical for both.
 * Put it in an AND array rather than spreading it: it uses OR, and so do some
 * filters, and two ORs in one object means the second wins silently.
 */
export function afterCursor(position?: CursorPosition) {
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
export function toPage<T extends CursorPosition>(
  rows: T[],
  limit: number,
): Page<T> {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items.at(-1);

  return { items, nextCursor: hasMore && last ? encodeCursor(last) : null };
}
