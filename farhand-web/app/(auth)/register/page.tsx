"use client";

/**
 * Screen 3.1 — create an account.
 *
 * Four fields, and the API's rules are the only rules (#156's table):
 *
 *   email        trimmed and lowercased by the API; send what was typed
 *   password     8–72. The hint says "at least 8 characters" and nothing
 *                about 72 — the cap is real, server-side, and not worth a
 *                sentence a reader has to carry
 *   displayName  1–50 after trimming
 *   countryCode  ISO 3166-1 alpha-2, uppercased by the API
 *
 * THE ERROR STATE THE DESIGN HAS AND THIS CANNOT: 3.1a draws "An account with
 * this email already exists. Sign in instead." `POST /auth/register` answers
 * `201` with the same body either way, on purpose — telling the two apart
 * would let anybody test whether an address is on Farhand. So a successful
 * registration always lands on /verify, and the design's second error state
 * has no code behind it.
 */
export default function Register() {
  // TODO(#156): controlled form → apiSend("POST", "/auth/register", {...}).
  //
  //   201 → write the email to sessionStorage, then router.push("/verify").
  //         The token arrives by email and that page asks for it; the address
  //         is only there so "send a new code" works after a reload. Not in
  //         the URL — see the note on /verify for why.
  //   422 → fieldErrorsIn(error) onto the four fields. The API's top-level
  //         message is the fallback when `details` blames nothing.
  //   429 → the API's own sentence. Registration is limited to 5 an hour per
  //         account and 10 per IP, and there is nothing useful to add to it.
  //
  // TODO(#156): the country picker. The API takes any valid ISO 3166-1
  // alpha-2 code; there is no endpoint listing countries, so the list is the
  // frontend's own. `Intl.DisplayNames` turns a code into a name in the
  // browser, which beats shipping a table of 249 strings — and the design's
  // dropdown shows names, not codes.
  //
  // TODO(#156): the password field needs the design's "Show" toggle, which
  // is `type` flipping between "password" and "text" and an aria-pressed
  // button — not a second input.

  return null;
}
