/**
 * Who the landing page is for — issue #170.
 *
 * Signed in, `/` should be the product and not the sales pitch, so a request
 * for it that carries a session is sent to the list.
 *
 * WHY THIS IS A MODULE AND NOT THREE LINES IN `proxy.ts`, which is the
 * same argument `lib/safe-next.ts` makes: a rule tangled into the thing that
 * applies it is a rule that gets tested by clicking. The two mistakes worth
 * guarding against are both quiet — gating a path that was never meant to be
 * gated, and gating `/` for everybody — and neither shows up as an error.
 *
 * It takes "is there a cookie" rather than the request, so the test needs no
 * `NextRequest` to say what it means.
 */

/** The only path the front door guards. */
export const FRONT_DOOR = "/";

/** Where somebody signed in is sent instead. */
export const THE_PRODUCT = "/needs";

/**
 * The path to redirect to, or `null` to let the request through.
 *
 * A COOKIE IS NOT A VALID SESSION, and that is deliberate. A stale one sends
 * somebody to `/needs` who turns out to be signed out — harmless, because
 * that page is public and its header draws the signed-out state correctly.
 * Asking the API whether the session is real would make the one screen that
 * renders while the API is asleep depend on the API being awake, which is
 * the whole property the landing page exists for.
 */
export function frontDoor(
  pathname: string,
  hasSession: boolean,
): string | null {
  if (pathname !== FRONT_DOOR) return null;
  if (!hasSession) return null;

  return THE_PRODUCT;
}
