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
  //   200 → refresh() the session, then home. The banner stops showing
  //         because /auth/me now says emailVerified.
  //   422 → "That code didn't work or has expired. Send a new one." —
  //         which is the design's wording AND the API's position: unknown,
  //         used, expired and wrong-kind all answer the same, because
  //         telling them apart helps nobody who legitimately holds a code.
  //         Say what the API said; do not guess which of the four it was.
  //
  // TODO(#156): "send a new code" needs an address, and somebody who arrived
  // from an email may not be signed in. Signed in → use the session's email
  // and POST /auth/resend-verification. Signed out → send them to /sign-in
  // rather than asking for the address again on this page; a form that takes
  // an email and says nothing back is a way to test which addresses exist.
  //
  // TODO(#156): verifying while signed out is allowed by the API and should
  // stay allowed here — the token is the proof, not the cookie. Afterwards,
  // point them at /sign-in.

  return null;
}
