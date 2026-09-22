import { Prisma } from "@prisma/client";
import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db.js";
import { createVerificationToken, hashToken } from "../tokens.js";
import { mailer } from "../mailer.js";
import { HttpError } from "../errors.js";
import {
  hashPassword,
  verifyPassword,
  DUMMY_PASSWORD_HASH,
} from "../password.js";
import {
  createSession,
  SESSION_COOKIE,
  sessionCookieOptions,
} from "../sessions.js";
import { requireAuth, getAuth } from "../middleware/auth.js";

export const authRouter: Router = Router();

/**
 * Accounts: registration, verification, login, logout.
 *
 * Contract: docs/06-api-contract.md. Sessions rather than JWTs:
 * docs/10-decisions/0007-sessions-over-jwt.md.
 *
 * The Zod schema lives in this file for now. Once there are several endpoints
 * it is worth its own module, but one endpoint does not justify the
 * indirection yet.
 */

/**
 * What a registration request must contain.
 *
 * Anything this schema rejects never reaches the database, and the error
 * handler turns a ZodError into the shared 422 response by itself — there is
 * nothing to catch.
 *
 * Two orderings here are load-bearing:
 *
 *   The email is trimmed and lowercased BEFORE it is validated, so that
 *   " Anna@X.com " is accepted and stored as "anna@x.com". Validate first and
 *   the padded form is rejected; normalise only on the way out and
 *   "Anna@x.com" becomes a second account that the unique index cannot catch.
 *
 *   displayName is trimmed BEFORE the length check, so "   " fails `min(1)`
 *   instead of being stored as an empty name.
 *
 * The password is deliberately NOT trimmed. A trailing space is part of
 * someone's password, and trimming it here would mean trimming it identically
 * at login forever.
 *
 * No composition rules ("one uppercase, one digit") — they push people towards
 * Password1!, and NIST now recommends against them. Length is what matters.
 * The maximum exists because unbounded input to a deliberately slow hash is a
 * cheap way to tie up the server.
 */
export const registerSchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email()),
  password: z.string().min(8).max(72),
  displayName: z.string().trim().min(1).max(50),
  // ISO 3166-1 alpha-2, matching Char(2) in the schema. The regex rather than
  // `.length(2)`: length alone accepts "12" and "!!" as countries. Whether
  // "ZZ" is a real country is a further question, and a full list can wait.
  countryCode: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{2}$/, "Must be a two-letter country code"),
});

/** Prisma's unique-constraint violation — here, the email already exists. */
function isDuplicateKey(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002"
  );
}

/**
 * POST /auth/register
 *
 * Creates an account and its public profile, and answers identically whether
 * or not the email was already registered.
 *
 * That identical answer is the point. If this endpoint said "that email is
 * taken", anyone could type addresses into it and learn who has an account
 * here — and on a platform where people arrange to carry goods across borders,
 * "does this person use Farhand" is not a harmless fact. The real owner of the
 * address is not locked out; they can still log in, or reset their password.
 * What they must not get is a second account, and what an attacker must not
 * get is a yes/no oracle.
 *
 * Never log the request body from here: it holds a plaintext password, and
 * pino would write it to disk.
 */
authRouter.post("/auth/register", async (req, res) => {
  const data = registerSchema.parse(req.body);

  // Before the insert, and on the duplicate path too. Hashing only for new
  // accounts would make duplicate requests measurably faster, which hands back
  // the same oracle the identical response was meant to close.
  const passwordHash = await hashPassword(data.password);

  try {
    // One transaction: a User without a Profile is a half-made account that
    // every later query would have to defend against. Both rows, or neither.
    const rawToken = await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: { email: data.email, passwordHash },
      });

      await tx.profile.create({
        data: {
          userId: user.id,
          displayName: data.displayName,
          countryCode: data.countryCode,
        },
      });

      return createVerificationToken(tx, user.id);
    });

    // Outside the transaction, after commit — mail can't be un-sent, but
    // a row that never committed can simply not exist.
    await mailer.sendVerificationEmail(data.email, rawToken);
  } catch (error) {
    if (!isDuplicateKey(error)) throw error;
    // Duplicate path: no token, no email — the real owner already has one.
  }
  res.status(201).json({
    message: "Check your email to verify your account.",
  });
});

/**
 * What a verification request must contain: the raw token from the email.
 * The shape only — whether the token is real is decided below.
 */
export const verifyEmailSchema = z.object({
  token: z.string().trim().min(1),
});

authRouter.post("/auth/verify-email", async (req, res) => {
  const { token } = verifyEmailSchema.parse(req.body);
  const tokenHash = hashToken(token);

  const invalid = () =>
    new HttpError(
      422,
      "VALIDATION_FAILED",
      "This link is invalid or has expired",
    );

  const row = await prisma.verificationToken.findUnique({
    where: { tokenHash },
  });

  if (
    row?.type !== "EMAIL_VERIFICATION" ||
    row.usedAt !== null ||
    row.expiresAt < new Date()
  ) {
    throw invalid();
  }

  await prisma.$transaction(async (tx) => {
    const { count } = await tx.verificationToken.updateMany({
      where: { id: row.id, usedAt: null },
      data: { usedAt: new Date() },
    });

    if (count === 0) throw invalid();

    await tx.user.updateMany({
      where: { id: row.userId, emailVerifiedAt: null },
      data: { emailVerifiedAt: new Date() },
    });
  });

  res.status(200).json({ message: "Email verified." });
});

/**
 * What a login request must contain.
 *
 * Deliberately looser than registerSchema. The password only has to be a
 * non-empty string — NOT the 8–72 characters that registration demands. Two
 * reasons: if the minimum is ever raised, people with older, shorter passwords
 * must still be able to log in; and a 422 saying "password too short" would
 * answer a question the attacker has no business asking. A wrong password of
 * any length gets the same 401.
 *
 * The email IS normalised the same way as at registration, or "Anna@x.com"
 * would never find the account stored as "anna@x.com".
 */
export const loginSchema = z.object({
  email: z.string().trim().toLowerCase(),
  password: z.string().min(1),
});

/**
 * POST /auth/login
 *
 * Checks the email and password and, if they are right, starts a session and
 * sets it as a cookie. The order of the checks is the point of this endpoint:
 *
 *   - An unknown email, a wrong password and a DELETED account all get the
 *     same 401. "No account with that email" would let anyone check whether
 *     an address uses Farhand — the thing registration works so hard to hide.
 *
 *   - BANNED is checked only after the password. Checked first, typing an
 *     email alone would reveal that the account exists.
 *
 *   - SUSPENDED and unverified users are let in
 *     (docs/02-roles-and-permissions.md). What they may not do is enforced
 *     per action, from #12 on.
 *
 * The reply says who is logged in — never the user row itself, which holds
 * passwordHash. Never log the request body here: it holds a plaintext password.
 */
authRouter.post("/auth/login", async (req, res) => {
  const { email, password } = loginSchema.parse(req.body);

  const user = await prisma.user.findUnique({
    where: { email },
    include: { profile: true },
  });

  // Always check the password, even with no user — against a real hash that
  // can never match, so "unknown email" and "wrong password" take the same
  // time. See DUMMY_PASSWORD_HASH's comment for why the gap otherwise leaks
  // who has an account.
  const passwordOk = await verifyPassword(
    user?.passwordHash ?? DUMMY_PASSWORD_HASH,
    password,
  );

  if (!user || !passwordOk || user.status === "DELETED") {
    throw HttpError.unauthorized("Email or password is incorrect");
  }

  // Checked only now — after the password — so typing an email alone can
  // never reveal whether that account is banned.
  if (user.status === "BANNED") {
    throw HttpError.forbidden("This account has been banned");
  }

  const rawToken = await prisma.$transaction(async (tx) => {
    const token = await createSession(tx, user.id, {
      userAgent: req.get("user-agent"),
      ipAddress: req.ip,
    });

    await tx.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    return token;
  });

  res.cookie(SESSION_COOKIE, rawToken, sessionCookieOptions());
  res.json({
    user: {
      id: user.id,
      email: user.email,
      displayName: user.profile?.displayName,
      emailVerified: user.emailVerifiedAt !== null,
    },
  });
});

/**
 * GET /auth/me
 *
 * Who is logged in. The frontend calls this when the app first loads, to
 * decide between "Log in" and "Hello, Anna". requireAuth has already found the
 * user, so there is no database query here.
 *
 * status and suspendedUntil are in the reply so the frontend can show "your
 * account is suspended until …". The object is built field by field on
 * purpose: spreading the user row (`...user`) would send passwordHash to the
 * browser.
 */
authRouter.get("/auth/me", requireAuth, (req, res) => {
  const { user } = getAuth(req);

  res.status(200).json({
    user: {
      id: user.id,
      email: user.email,
      role: user.role,
      status: user.status,
      suspendedUntil: user.suspendedUntil,
      emailVerified: user.emailVerifiedAt !== null,
      profile: {
        displayName: user.profile?.displayName,
        bio: user.profile?.bio,
        countryCode: user.profile?.countryCode,
        city: user.profile?.city,
        avatarUrl: user.profile?.avatarUrl,
      },
    },
  });
});

/**
 * POST /auth/logout
 *
 * Ends THIS session — the device the request came from. Other devices stay
 * logged in. Deleting the row is what really logs out: the cookie may survive
 * on the device, but it no longer points at anything, so requireAuth rejects
 * it.
 */
authRouter.post("/auth/logout", requireAuth, async (req, res) => {
  const { session } = getAuth(req);

  // deleteMany, not delete. Two logouts at once (a double-click) both pass
  // requireAuth; by the time the second deletes, the first already has, and
  // Prisma's delete throws when nothing matches — a 500 for clicking twice.
  // deleteMany just reports count: 0, so logging out twice ends exactly where
  // logging out once does, and both requests can honestly answer 204.
  await prisma.session.deleteMany({ where: { id: session.id } });

  res.clearCookie(SESSION_COOKIE, sessionCookieOptions());
  res.status(204).end();
});

/**
 * What a forgot-password request must contain. The email is normalised and
 * checked exactly as at registration — registerSchema's own rule, reused.
 */
export const forgotPasswordSchema = z.object({
  email: registerSchema.shape.email,
});

/**
 * What a reset request must contain: the token from the email, and the new
 * password.
 *
 * The new password follows the REGISTRATION rules — registerSchema's own
 * rule, so there is one definition of a valid password, not two that drift
 * apart. (Login is looser on purpose; that is about checking an old password,
 * this is about choosing a new one.)
 */
export const resetPasswordSchema = z.object({
  token: z.string().trim().min(1),
  password: registerSchema.shape.password,
});

/**
 * POST /auth/forgot-password
 *
 * "I forgot my password — email me a link." Answers the same whether or not
 * the email has an account, so it cannot be used to find out who does.
 *
 * TODO(#13):
 *
 *   1. Parse the body with forgotPasswordSchema.
 *
 *   2. Find the user by email.
 *
 *   3. If there is a user, and they are not BANNED or DELETED:
 *        const rawToken = await createPasswordResetToken(prisma, user.id);
 *        await mailer.sendPasswordResetEmail(user.email, rawToken);
 *      Unverified users DO get a link — clicking it proves they own the
 *      address, which is what verification proves too.
 *
 *   4. Always reply 200 with the same message, for example:
 *        { message: "If an account exists for that email, a reset link is on its way." }
 *
 * Known and deliberate: the path with an account does a little more work (a
 * database write) than the path without, so it is a few milliseconds slower.
 * That is far smaller than #11's 4-versus-18 ms argon2 gap, but it is not
 * zero. The complete fix comes with v2's background job queue: every request
 * enqueues a job, and the worker decides whether there is anyone to email —
 * then the request path is identical for everyone.
 */
authRouter.post("/auth/forgot-password", async (_req, res) => {
  // TODO(#13): implement. See the steps above.
  await Promise.resolve();
  res.status(501).json({
    error: { code: "INTERNAL", message: "Not implemented yet" },
  });
});

/**
 * POST /auth/reset-password
 *
 * Sets a new password with the token from the email, and logs the account out
 * everywhere.
 *
 * TODO(#13), in this order:
 *
 *   1. Parse the body with resetPasswordSchema. This comes FIRST: a new
 *      password that is too short gets a 422 before the token is touched, so
 *      the person can fix the password and try again with the same link.
 *
 *   2. Look the token up by hashToken(token), including its user.
 *
 *   3. One identical 422 — as in verify-email — when the token is missing, is
 *      not a PASSWORD_RESET token (a verification token must not change a
 *      password), is used, has expired, or belongs to a BANNED or DELETED
 *      user:
 *        throw new HttpError(422, "VALIDATION_FAILED",
 *          "This link is invalid or has expired");
 *
 *   4. Hash the new password with hashPassword() — BEFORE the transaction.
 *      A transaction holds database locks while it runs; the slow argon2
 *      work should not happen while it does.
 *
 *   5. In ONE transaction:
 *        a. Consume the token with updateMany({ where: { id, usedAt: null } })
 *           and check the count — your single-use pattern from #10. Count 0
 *           → throw the same 422.
 *        b. Update the user: the new passwordHash, and emailVerifiedAt set to
 *           now if it was still null. The link reached their inbox, which
 *           proves they own the address — so resetting also verifies.
 *        c. Delete ALL the user's sessions: session.deleteMany({ where:
 *           { userId } }). Someone resets a password because they think
 *           someone else might know it; every device logged in with the old
 *           one — including a stranger's — must be logged out now.
 *
 *   6. Reply 200, for example:
 *        { message: "Password changed. Log in with your new password." }
 *      Do not log them in automatically: a login proves they know the NEW
 *      password, and it starts a fresh session.
 *
 * Imports you will need: createPasswordResetToken from ../tokens.js.
 * hashToken, hashPassword, mailer and HttpError are already imported.
 */
authRouter.post("/auth/reset-password", async (_req, res) => {
  // TODO(#13): implement. See the steps above.
  await Promise.resolve();
  res.status(501).json({
    error: { code: "INTERNAL", message: "Not implemented yet" },
  });
});
