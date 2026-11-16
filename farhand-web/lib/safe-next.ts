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

/** Where somebody goes when `next` is missing, unusable, or not ours. */
export const HOME = "/";

/**
 * Routes that must never be a destination, because landing on them straight
 * after signing in is a loop or a dead end.
 */
export const NOT_A_DESTINATION = ["/sign-in", "/register", "/verify"];

/**
 * The path to navigate to, which is `next` only when `next` is ours.
 *
 * TODO(#156): parse, do not inspect.
 *
 *     const target = new URL(next, origin);
 *     if (target.origin !== origin) return HOME;
 *     return target.pathname + target.search + target.hash;
 *
 * CHECKING THE FIRST CHARACTERS DOES NOT WORK, and the near-miss is worth
 * writing down because it looks correct: "starts with `/` but not `//`"
 * accepts `/\evil.example`, and a browser normalises that backslash in the
 * authority position, so it navigates to `//evil.example` — a different site.
 * Letting the URL parser decide means the thing that judges the address is
 * the same thing that will later resolve it, which is the only version of
 * this check that stays true as browsers change.
 *
 * `new URL` throws on input it cannot parse at all, so this must not let that
 * escape: an unusable `next` is a trip home, not a crash on the sign-in page.
 *
 * TODO(#156): `origin` is passed in rather than read from
 * `window.location.origin` inside, so this is a pure function and the test
 * does not need a DOM to say what it means.
 */
export function safeNext(
  _next: string | null | undefined,
  _origin: string,
): string {
  // TODO(#156)
  return HOME;
}
