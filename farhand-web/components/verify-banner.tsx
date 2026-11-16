"use client";

import { useSession } from "@/lib/session";

/**
 * Screen 3.6 — "Confirm your email to start posting."
 *
 * Sits under the header on every page, and only for somebody who is signed in
 * and unverified. That state is real and reachable: `POST /auth/login`
 * succeeds for an unverified account on purpose — `requireVerified` guards
 * posting, not existing — so somebody can register, sign in, browse, and have
 * nowhere the app tells them what is missing. This banner is that place.
 *
 * The design's other banner on 3.6 is suspension ("Your account is suspended
 * until 3 Nov 2026"). `GET /auth/me` does not say whether you are suspended —
 * `status` is deliberately not in a profile — so that half cannot be built
 * and is not attempted here.
 */
export function VerifyBanner() {
  const { session: _session } = useSession();

  // TODO(#156): render nothing unless session.status === "signed-in" and
  // me.emailVerified is false.
  //
  // Two actions, as the design has them:
  //   "Enter code"      → /verify
  //   "Send a new code" → POST /auth/resend-verification
  //
  // That POST answers identically whether or not it did anything (#41), so
  // the only honest confirmation is "if that address has an account, a new
  // code is on its way" — never "sent!", which claims knowledge the response
  // withholds.
  //
  // TODO(#156): the design's "You can ask for another code in 0:52" is a
  // countdown the API does not have. The real limit is 5 an hour per account.
  // Show nothing until a 429 arrives, then show what the API said.
  return null;
}
