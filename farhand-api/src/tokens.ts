import { createHash, randomBytes } from "node:crypto";
import type { Prisma, TokenType } from "@prisma/client";

/**
 * Single-use tokens, for email verification and password reset.
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
 * dead. A new link can always be asked for, with POST
 * /auth/resend-verification (#41).
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
 * The one place a single-use token is issued. Both kinds work the same way —
 * retire the older unused ones, store a hash, return the raw token — and
 * differ only in type and lifetime, so they share this rather than keeping two
 * copies that drift apart the first time one is fixed and the other is not.
 */
async function issueToken(
  db: Prisma.TransactionClient,
  userId: string,
  type: TokenType,
  ttlMs: number,
): Promise<string> {
  // Retire every earlier, still-unused token of this type first — only the
  // newest one should ever work.
  await db.verificationToken.updateMany({
    where: { userId, type, usedAt: null },
    data: { usedAt: new Date() },
  });

  const raw = generateToken();

  await db.verificationToken.create({
    data: {
      userId,
      type,
      tokenHash: hashToken(raw),
      expiresAt: new Date(Date.now() + ttlMs),
    },
  });

  return raw;
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
  return issueToken(
    db,
    userId,
    "EMAIL_VERIFICATION",
    EMAIL_VERIFICATION_TTL_MS,
  );
}

/**
 * Issues a password-reset token for a user. Returns the RAW token, for the
 * caller to email; stores only its hash.
 */
export async function createPasswordResetToken(
  db: Prisma.TransactionClient,
  userId: string,
): Promise<string> {
  return issueToken(db, userId, "PASSWORD_RESET", PASSWORD_RESET_TTL_MS);
}
