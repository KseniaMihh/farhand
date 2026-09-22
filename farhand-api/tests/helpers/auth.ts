import type { Express } from "express";
import request from "supertest";
import { prisma } from "../../src/db.js";
import { SESSION_COOKIE } from "../../src/sessions.js";

/**
 * Logged-in users for tests.
 *
 * Almost every test from #12 on needs someone logged in, so it lives here
 * instead of being rewritten in every file. It goes through the real
 * endpoints — register, then log in — so a test's user is made exactly the
 * way a real one is. Not a *.test.ts file, so Vitest does not run it on its
 * own.
 */

export const PASSWORD = "a decent long passphrase";

export interface TestUser {
  id: string;
  email: string;
  /** Ready for `.set("Cookie", user.cookie)` on a Supertest request. */
  cookie: string;
}

/** Registers `email` and logs in. Returns the user and their session cookie. */
export async function signUpAndLogIn(
  app: Express,
  email: string,
  displayName = "Anna",
): Promise<TestUser> {
  await request(app).post("/auth/register").send({
    email,
    password: PASSWORD,
    displayName,
    countryCode: "EE",
  });

  return { ...(await logIn(app, email)), email };
}

/** Logs an existing user in again — a second device, say. */
export async function logIn(app: Express, email: string): Promise<TestUser> {
  const response = await request(app)
    .post("/auth/login")
    .send({ email, password: PASSWORD });

  const cookies = response.headers["set-cookie"] as unknown as
    string[] | undefined;
  const cookie = cookies
    ?.find((c) => c.startsWith(`${SESSION_COOKIE}=`))
    ?.split(";")[0];

  if (response.status !== 200 || !cookie) {
    throw new Error(
      `Test login failed for ${email}: HTTP ${String(response.status)}`,
    );
  }

  const user = await prisma.user.findUniqueOrThrow({ where: { email } });
  return { id: user.id, email, cookie };
}
