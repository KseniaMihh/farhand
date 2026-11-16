"use client";

/**
 * Screen 3.3 — sign in.
 *
 * The screen the whole issue exists for: `POST /auth/login` sets the
 * `httpOnly`, `sameSite: "lax"` session cookie, and because the request went
 * to this app's own `/api/...` the browser treats it as same-site and keeps
 * it. Reload, still signed in — the first real proof of decision 0031.
 *
 * ONE MESSAGE, NOT TWO. The design's 3.3a says "That email and password don't
 * match. Check both and try again." above the form rather than marking a
 * field, and that is right rather than lazy: a wrong-password error that
 * marked only the password would confirm the email exists.
 */
export default function SignIn() {
  // TODO(#156): two fields → apiSend("POST", "/auth/login", {...}).
  //
  //   200 → refresh(), then router.replace() to where they were going.
  //   401 → the one sentence above the form. No field marks.
  //   429 → 3.3b. The real rule is 20 an hour per IP and 10 per account over
  //         a 15-minute window, so the design's "wait 15 minutes" is right.
  //         Show what the API said and offer "Reset password", as 3.3b does.
  //
  // TODO(#156): an unverified account signs in SUCCESSFULLY — requireVerified
  // guards posting, not logging in. Do not special-case it here; the banner
  // on 3.6 is where that is said.
  //
  // TODO(#156): "where they were going" needs a decision. A `?next=` param is
  // the usual answer and is an open redirect if it is not checked.
  //
  // CHECK IT BY PARSING, NOT BY LOOKING AT THE FIRST CHARACTERS:
  //
  //     const target = new URL(next, window.location.origin);
  //     if (target.origin !== window.location.origin) → home
  //     otherwise use target.pathname + target.search + target.hash
  //
  // A "starts with one slash, not two" test looks equivalent and is not.
  // Browsers normalise a backslash to a slash in the authority position, so
  // `/\evil.com` passes that test and navigates to `//evil.com`. Letting the
  // URL parser decide means the thing that resolves the address is the same
  // thing that judged it, which is the only version of this check that stays
  // true as browsers change.
  //
  // No screen in this issue sets `next`; the guard is written now because the
  // first screen that does will not think about it.

  return null;
}
