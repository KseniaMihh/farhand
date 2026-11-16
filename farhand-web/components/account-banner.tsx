"use client";

import { useSession } from "@/lib/session";

/**
 * Screen 3.6 — the strip under the header, in both the states it has.
 *
 * SUSPENDED, which `GET /auth/me` really does answer. `status` and
 * `suspendedUntil` are in that reply for this exact purpose, and
 * farhand-api/src/routes/auth.ts says so in as many words: "so the frontend
 * can show 'your account is suspended until …'". (The fields kept out of a
 * profile on purpose are the PUBLIC one's, `GET /users/:id`. Different
 * endpoint, different rule — getting those two confused is what nearly cost
 * this banner.)
 *
 * UNVERIFIED, which is reachable and otherwise silent: `POST /auth/login`
 * succeeds for an unverified account on purpose — `requireVerified` guards
 * posting, not existing — so somebody can register, sign in, browse, and have
 * nowhere the app tells them what is missing.
 *
 * TODO(#156): suspension wins when both are true. A suspended account cannot
 * post whether or not it is verified, so offering "Confirm your email to
 * start posting" would be a promise the API will not keep.
 */
export function AccountBanner() {
  const { session: _session } = useSession();

  // TODO(#156): nothing unless signed in. Then:
  //
  //   status === "SUSPENDED"
  //     "Your account is suspended until {date}. You can read, but not post,
  //      propose or message." — the design's wording, with the Paused tint
  //      (#E7E3EF on #4A3F6B), and "Read the community rules".
  //
  //      suspendedUntil === null is NOT "not suspended" — the status already
  //      said it is. It means no end date, so say "until a moderator lifts
  //      it" rather than printing "null" or quietly hiding the banner.
  //
  //   !emailVerified
  //     "Confirm your email to start posting. You can browse meanwhile."
  //     with "Enter code" → /verify and "Send a new code" →
  //     POST /auth/resend-verification.
  //
  //     That POST answers identically whether or not it did anything (#41),
  //     so the only honest confirmation is "if that address has an account, a
  //     new code is on its way" — never "sent!", which claims knowledge the
  //     response withholds.
  //
  // TODO(#156): the design's "You can ask for another code in 0:52" is a
  // countdown the API does not have. The real limit is 5 an hour per account.
  // Show nothing until a 429 arrives, then show what the API said.
  //
  // TODO(#156): BANNED and DELETED cannot hold a session at all, so they
  // cannot reach this component. Handle them by not inventing copy for them.

  return null;
}
