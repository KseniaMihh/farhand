import { Router } from "express";
import { z } from "zod";

export const authRouter: Router = Router();

/**
 * Accounts: registration, verification, login, logout.
 *
 * Contract: docs/06-api-contract.md. Sessions rather than JWTs:
 * docs/10-decisions/0007-sessions-over-jwt.md.
 *
 * The Zod schema lives in this file for now. Once there are several endpoints
 * it is worth its own module, but one endpoint does not justify the indirection
 * yet.
 */

/**
 * What a registration request must contain.
 *
 * Every field is validated here so the handler below can assume it is dealing
 * with well-formed data. Anything this schema rejects never reaches the
 * database, and the error handler turns a ZodError into the shared error shape
 * automatically — there is nothing to catch.
 *
 * TODO(#9): fill in the four fields.
 *
 *   email        A valid email. Store it lowercased and trimmed, or
 *                "Anna@x.com" and "anna@x.com" become two accounts and the
 *                unique index will not save you. Look at `.trim()`,
 *                `.toLowerCase()` and `z.email()`.
 *
 *   password     A minimum length, and nothing else. Resist composition rules
 *                ("one uppercase, one digit, one symbol") — they push people
 *                towards Password1! and NIST now recommends against them.
 *                Length is what actually matters. Pick your minimum; the tests
 *                use a 5-character password as "too weak", so anything from 8
 *                upwards satisfies them. Consider a maximum too (~72–128):
 *                unbounded input to a deliberately slow hash is a free way to
 *                tie up the server.
 *
 *   displayName  1–50 characters after trimming — the schema says
 *                VarChar(50), and a value longer than the column throws at
 *                the database instead of returning a clean 4xx.
 *
 *   countryCode  Exactly two letters, ISO 3166-1 alpha-2, uppercased —
 *                Char(2) in the schema. Two letters is the shape; whether
 *                "ZZ" is a real country is a further question, and a full list
 *                can wait. The test only requires that "Estonia" is rejected.
 */
export const registerSchema = z.object({
  // TODO(#9): replace this placeholder with the four fields above.
});

/**
 * POST /auth/register
 *
 * Creates an account and its public profile. Responds identically whether or
 * not the email was already registered.
 *
 * ── Why the identical response matters ────────────────────────────────────
 * If this endpoint answered "that email is taken", anyone could type addresses
 * into it and learn who has an account here. On a platform where people
 * arrange to carry goods across borders, "does this person use Farhand" is not
 * a harmless fact. So a duplicate registration looks exactly like a new one
 * from the outside: same status, same body.
 *
 * The real owner of the address is not locked out — they can still log in, or
 * use the password reset flow (#13). What they must NOT get is a second
 * account, and what an attacker must not get is a yes/no oracle.
 *
 * ── What to write ─────────────────────────────────────────────────────────
 * TODO(#9), roughly in this order:
 *
 *   1. Parse the body with registerSchema. Let a ZodError propagate: Express 5
 *      forwards a throw from an async handler to the error handler by itself.
 *
 *   2. Hash the password with hashPassword() from ../password.js.
 *      Do this BEFORE looking at whether the email exists, and do it even on
 *      the duplicate path. Skipping it there would make duplicate requests
 *      measurably faster than new ones, which hands back the same oracle the
 *      identical response was meant to close. Timing is a weaker signal than a
 *      different response body, and closing it costs nothing here.
 *
 *   3. Create the User and its Profile in ONE transaction — prisma.$transaction.
 *      A Profile is not optional: a User without one is a half-made account
 *      that every later query has to defend against. Either both rows exist or
 *      neither does.
 *
 *   4. Handle the duplicate email. Two ways, and the difference is worth
 *      understanding:
 *
 *        (a) SELECT first, then create if absent. Reads naturally, and is
 *            wrong: two simultaneous requests can both see "absent" and both
 *            try to insert. The window is small and real.
 *
 *        (b) Just insert, and catch the unique constraint violation. The
 *            database is the only thing that can decide this atomically.
 *            Prisma throws PrismaClientKnownRequestError with code "P2002".
 *
 *      Use (b). Catch P2002, swallow it, and fall through to the same
 *      response. Let every other error propagate — a failure to reach the
 *      database must not look like a successful registration.
 *
 *   5. Respond 201 with the same neutral body on both paths. The account is
 *      unverified until #10 adds the email token; `emailVerifiedAt` stays null
 *      and nothing else should set it.
 *
 * Never log the request body here. It contains a plaintext password, and pino
 * would write it to disk.
 */
authRouter.post("/auth/register", async (_req, res) => {
  // TODO(#9): implement. See the steps above.
  await Promise.resolve();
  res.status(501).json({
    error: { code: "INTERNAL", message: "Not implemented yet" },
  });
});
