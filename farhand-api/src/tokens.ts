/* eslint-disable @typescript-eslint/no-unused-vars --
   The stubs below do not use their arguments or imports yet. DELETE THIS LINE
   once all three functions are implemented. */
import { createHash, randomBytes } from "node:crypto";
import type { Prisma } from "@prisma/client";

/**
 * Single-use tokens: email verification now, password reset in #13.
 *
 * The raw token goes to the user (by email); only its hash is stored. Anyone
 * who reads the VerificationToken table — a leaked backup, an over-broad
 * admin query — gets hashes that cannot be turned back into working links.
 * docs/07-trust-and-safety.md commits us to this.
 */

/**
 * 32 random bytes = 256 bits. Guessing one is not a thing that happens.
 *
 * That entropy is also why SHA-256 is the right hash here and argon2 is not —
 * see hashToken below.
 */
const TOKEN_BYTES = 32;

/**
 * How long a verification link works. Long enough to survive "I'll check my
 * email after lunch", short enough that a link sitting in an old inbox is
 * dead. A new link can always be issued.
 */
export const EMAIL_VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * A new raw token, safe to put in a URL.
 *
 * TODO(#10): `randomBytes(TOKEN_BYTES)` from node:crypto, encoded with
 * `.toString("base64url")`. base64url rather than base64 because the result
 * will end up in a link, and base64's "+" and "/" mean things in URLs.
 *
 * Never Math.random() — it is predictable. node:crypto is the
 * cryptographically secure source.
 */
export function generateToken(): string {
  // TODO(#10): replace this.
  throw new Error("generateToken is not implemented yet");
}

/**
 * The form a token is stored and looked up in.
 *
 * TODO(#10): SHA-256 of the token, as a hex string:
 * `createHash("sha256").update(token).digest("hex")`.
 *
 * Why SHA-256 here when passwords get argon2id — the question worth being able
 * to answer:
 *
 *   Password hashing is slow because passwords are GUESSABLE. People pick
 *   from a small space, so an attacker with the hashes can try billions of
 *   candidates; slowness is the only defence.
 *
 *   These tokens are 256 random bits. There is nothing to guess — the space is
 *   too large to search at any speed. Slowness buys nothing.
 *
 *   And a fast, deterministic hash is REQUIRED here: to verify, we hash the
 *   incoming token and look it up by the unique `tokenHash` column. argon2
 *   salts every hash randomly, so the same token would hash differently each
 *   time and could never be found by lookup.
 */
export function hashToken(token: string): string {
  // TODO(#10): replace this.
  throw new Error("hashToken is not implemented yet");
}

/**
 * Issues an email-verification token for a user. Returns the RAW token, for
 * the caller to email; stores only its hash.
 *
 * Takes the database client as a parameter so it can run inside the
 * registration transaction: pass `tx` there, `prisma` anywhere else.
 * `Prisma.TransactionClient` accepts both.
 *
 * TODO(#10):
 *   1. generateToken()
 *   2. db.verificationToken.create with the userId, type EMAIL_VERIFICATION,
 *      tokenHash: hashToken(raw), and expiresAt: now + the TTL above
 *   3. return the raw token — never the row, which holds only the hash
 */
export async function createVerificationToken(
  db: Prisma.TransactionClient,
  userId: string,
): Promise<string> {
  // TODO(#10): replace this.
  return Promise.reject(
    new Error("createVerificationToken is not implemented yet"),
  );
}
