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
