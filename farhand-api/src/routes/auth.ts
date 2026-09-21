import { Prisma } from "@prisma/client";
import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db.js";
import { hashPassword } from "../password.js";

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
    await prisma.$transaction(async (tx) => {
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
    });
  } catch (error) {
    // Insert-and-catch rather than check-then-insert: two simultaneous
    // requests can both see "no such email" and both proceed. The unique index
    // is the only thing that can decide this atomically.
    //
    // Only P2002 is swallowed. A database that cannot be reached must not look
    // like a successful registration.
    if (!isDuplicateKey(error)) throw error;
  }

  // The account stays unverified until #10 adds the email token; nothing here
  // should set emailVerifiedAt.
  res.status(201).json({
    message: "Check your email to verify your account.",
  });
});
