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
 * How long a password reset link works: one hour — much shorter than the day a
 * verification link gets. A reset link can take over the account, so the
 * window in which a leaked or forwarded email is dangerous should be small.
 * Someone who asks for a reset is usually waiting for the email right now.
 */
export const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000;

/**
 * A new raw token, safe to put in a URL.
 *
 * Never Math.random() — it is predictable. node:crypto is the
 * cryptographically secure source.
 */
export function generateToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

/**
 * The form a token is stored and looked up in.
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
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Issues an email-verification token for a user. Returns the RAW token, for
 * the caller to email; stores only its hash.
 *
 * Takes the database client as a parameter so it can run inside the
 * registration transaction: pass `tx` there, `prisma` anywhere else.
 * `Prisma.TransactionClient` accepts both.
 */
export async function createVerificationToken(
  db: Prisma.TransactionClient,
  userId: string,
): Promise<string> {
  const raw = generateToken();

  await db.verificationToken.create({
    data: {
      userId,
      type: "EMAIL_VERIFICATION",
      tokenHash: hashToken(raw),
      expiresAt: new Date(Date.now() + EMAIL_VERIFICATION_TTL_MS),
    },
  });

  return raw;
}

/**
 * Issues a password-reset token for a user. Returns the RAW token, for the
 * caller to email; stores only its hash.
 *
 * TODO(#13): the same as createVerificationToken above, with two differences:
 *
 *   1. type "PASSWORD_RESET" and PASSWORD_RESET_TTL_MS.
 *
 *   2. FIRST, before creating the new token, retire every earlier reset token
 *      for this user that has not been used yet:
 *
 *        db.verificationToken.updateMany({
 *          where: { userId, type: "PASSWORD_RESET", usedAt: null },
 *          data: { usedAt: new Date() },
 *        })
 *
 *      So only the newest link ever works. Someone who clicks "forgot
 *      password" three times has three emails; if an older one leaks (a
 *      forwarded message, a shared inbox), it is already dead.
 *
 * Marking them used rather than deleting them keeps the history, and a used
 * token already fails the check in reset-password, so no new rule is needed.
 */
/* eslint-disable @typescript-eslint/no-unused-vars --
   Covers only this stub, which does not use its arguments yet. DELETE this
   comment and the eslint-enable below it once the function is implemented. */
export async function createPasswordResetToken(
  db: Prisma.TransactionClient,
  userId: string,
): Promise<string> {
  // TODO(#13): replace this whole body.
  return Promise.reject(
    new Error("createPasswordResetToken is not implemented yet"),
  );
}
/* eslint-enable @typescript-eslint/no-unused-vars */
