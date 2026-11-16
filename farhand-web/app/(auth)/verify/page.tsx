"use client";

/**
 * Screen 3.2 — confirm an email.
 *
 * THE SCREEN THAT CHANGES SHAPE. The design draws six single-character boxes
 * and says "We sent a 6-digit code… It works for 30 minutes". The API sends
 * 32 random bytes as base64url — a 43-character string — and it lasts 24
 * hours (farhand-api/src/tokens.ts). Six boxes cannot hold it, so this is one
 * field you paste into.
 *
 * It also reads `?token=` from the URL. `APP_ORIGIN` still points at the API,
 * so no email contains a link yet; #152 gives the app an address and changes
 * `src/mailer.ts`, and when it does, this page is already where the link
 * lands.
 *
 * A LINK MUST NOT VERIFY BY ARRIVING. Filling the field from the query and
 * waiting for "Confirm email" to be pressed is deliberate: a `GET` that
 * verified would be spent by the first link prefetcher, scanner or inbox
 * preview that saw it, and the token is single-use. The same reasoning is
 * already written down in docs/06-api-contract.md under this endpoint.
 */
export default function Verify() {
  // TODO(#156): one field, prefilled from useSearchParams().get("token").
  //
  //   200 → VERIFYING DOES NOT SIGN ANYBODY IN. It sets `emailVerifiedAt` and
  //         nothing else; the session is whatever it already was. So:
  //         signed in → refresh(), then home, and the banner stops showing.
  //         Signed out → /sign-in, which is the next thing they need.
  //   422 → "That code didn't work or has expired. Send a new one." —
  //         which is the design's wording AND the API's position: unknown,
  //         used, expired and wrong-kind all answer the same, because
  //         telling them apart helps nobody who legitimately holds a code.
  //         Say what the API said; do not guess which of the four it was.
  //
  // TODO(#156): verifying while signed out is allowed by the API and must
  // stay allowed here — the token is the proof, not the cookie. Somebody
  // reaching this page from an inbox on another device has no session at all.
  //
  // TODO(#156): "send a new code" needs an address, and after a reload this
  // page may not have one. Three sources, in order:
  //
  //   1. the session, when there is one
  //   2. sessionStorage, written by /register right after a 201 and cleared
  //      once verification succeeds
  //   3. an email field on this page, as the fallback
  //
  // NOT THE URL. A querystring lives in history, in the referrer header of
  // every link clicked afterwards, and in whatever logs the address passes
  // through; an email address does not belong in any of them. sessionStorage
  // dies with the tab, which is the right lifetime for a value that only
  // bridges one redirect.
  //
  // Whichever source it comes from, POST /auth/resend-verification answers
  // identically for an address that exists and one that does not (#41), so
  // the confirmation says "if that address has an account…" and the fallback
  // field gives nothing away.

  return null;
}
