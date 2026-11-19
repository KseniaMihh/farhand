/**
 * Where to send somebody after they sign in (#156).
 *
 * A `?next=` parameter is how a protected screen says "come back here", and
 * it is an open redirect the moment it is trusted — a link to
 * `/sign-in?next=https://evil.example/login` on a site people sign in to is a
 * phishing page with our domain in front of it.
 *
 * WHY THIS IS A MODULE AND NOT THREE LINES IN THE SIGN-IN PAGE: it is a
 * security check, so it is the part of that page worth testing, and a check
 * tangled into a component is one that gets tested by clicking.
 *
 * Nothing in #156 sets `next`. This is written before the first caller
 * because the first caller will not be thinking about any of the above.
 */

/**
 * Where somebody goes when `next` is missing, unusable, or not ours.
 *
 * THE LIST, NOT THE FRONT DOOR (#168). `/` is now the landing page, and it
 * exists to explain the product to somebody who has decided nothing.
 * Somebody who has just signed in has decided. Sending them to the sales
 * pitch is the wrong end of the site, and it is the screen they are least
 * likely to have wanted.
 */
export const HOME = "/needs";

/**
 * Routes that must never be a destination, because landing on them straight
 * after signing in is a loop or a dead end.
 */
export const NOT_A_DESTINATION = ["/sign-in", "/register", "/verify"];

/**
 * The path to navigate to, which is `next` only when `next` is ours.
 *
 * PARSED, NOT INSPECTED, and the near-miss is worth writing down because it
 * looks correct: "starts with `/` but not `//`" accepts `/\evil.example`, and
 * the URL parser reads that backslash as the start of an authority, so it
 * resolves to `https://evil.example` — a different site reached through a
 * string that passes the test. `\/evil.example` and `/\\evil.example` do the
 * same. Letting the parser decide means the thing that judges the address is
 * the same thing that will later resolve it, which is the only version of
 * this check that stays true as browsers change.
 *
 * `origin` is passed in rather than read from `window.location.origin` here,
 * so this is a pure function and its test does not need a DOM to say what it
 * means.
 */
export function safeNext(
  next: string | null | undefined,
  origin: string,
): string {
  if (next === null || next === undefined || next === "") return HOME;

  let target: URL;
  let ours: string;

  try {
    target = new URL(next, origin);
    // Normalised rather than compared as written: `URL.origin` has no
    // trailing slash and a lowercased host, and an `origin` argument from
    // somewhere less careful might have either.
    ours = new URL(origin).origin;
  } catch {
    // `new URL` throws on what it cannot parse at all. An unusable `next` is
    // a trip home — letting this escape would turn a junk querystring into a
    // crashed sign-in page, which is the one page nobody can route around.
    return HOME;
  }

  // The whole check. A scheme that is not a page — `javascript:`, `data:` —
  // has the origin "null" and fails here too, so there is no list of schemes
  // to keep up to date.
  if (target.origin !== ours) return HOME;

  // `pathname` rather than the whole path, so `/sign-in?next=…` is caught
  // and `/sign-in-help` is not.
  if (NOT_A_DESTINATION.includes(target.pathname)) return HOME;

  return `${target.pathname}${target.search}${target.hash}`;
}
