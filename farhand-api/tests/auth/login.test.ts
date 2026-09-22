import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { prisma } from "../../src/db.js";
import {
  SESSION_COOKIE,
  SESSION_TTL_MS,
  sessionCookieOptions,
} from "../../src/sessions.js";
import { hashToken } from "../../src/tokens.js";

/**
 * POST /auth/login — issue #11.
 *
 * These tests are the specification. They fail until the TODOs in
 * src/sessions.ts, src/password.ts and src/routes/auth.ts are filled in.
 *
 *   npm run test:watch -- login
 */
const app = createApp();

const EMAIL = "anna@example.com";
const PASSWORD = "a decent long passphrase";

async function registerAnna() {
  await request(app).post("/auth/register").send({
    email: EMAIL,
    password: PASSWORD,
    displayName: "Anna",
    countryCode: "EE",
  });
}

function login(email: string, password: string) {
  return request(app)
    .post("/auth/login")
    .set("User-Agent", "farhand-test-agent")
    .send({ email, password });
}

/** The full Set-Cookie line for the session cookie, if the reply set one. */
function sessionCookieHeader(response: request.Response): string | undefined {
  const cookies = response.headers["set-cookie"] as unknown as
    string[] | undefined;
  return cookies?.find((c) => c.startsWith(`${SESSION_COOKIE}=`));
}

/** Just the token inside the session cookie. */
function sessionToken(response: request.Response): string {
  const header = sessionCookieHeader(response) ?? "";
  return decodeURIComponent(header.split(";")[0]?.split("=")[1] ?? "");
}

interface LoginBody {
  user: {
    id: string;
    email: string;
    displayName: string;
    emailVerified: boolean;
  };
}

describe("POST /auth/login — success", () => {
  it("logs in and sets a session cookie", async () => {
    await registerAnna();

    const response = await login(EMAIL, PASSWORD);

    expect(response.status).toBe(200);
    expect(sessionToken(response)).not.toBe("");
  });

  it("sets the cookie httpOnly, SameSite=Lax, for the whole site", async () => {
    await registerAnna();

    const header = sessionCookieHeader(await login(EMAIL, PASSWORD)) ?? "";

    expect(header).toMatch(/;\s*HttpOnly/i);
    expect(header).toMatch(/;\s*SameSite=Lax/i);
    expect(header).toMatch(/;\s*Path=\//i);
    // Tests run on plain http, like development — Secure would stop the
    // browser sending the cookie back. Production is checked separately below.
    expect(header).not.toMatch(/;\s*Secure/i);
  });

  it("stores only a hash of the session token, never the token itself", async () => {
    await registerAnna();
    const token = sessionToken(await login(EMAIL, PASSWORD));

    const sessions = await prisma.session.findMany();

    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.tokenHash).not.toBe(token);
    expect(sessions[0]?.tokenHash).toBe(hashToken(token));
  });

  it("expires the session and the cookie after 30 days", async () => {
    await registerAnna();
    const before = Date.now();

    const response = await login(EMAIL, PASSWORD);
    const session = await prisma.session.findFirstOrThrow();

    const expected = before + SESSION_TTL_MS;
    expect(session.expiresAt.getTime()).toBeGreaterThan(expected - 60_000);
    expect(session.expiresAt.getTime()).toBeLessThan(expected + 60_000);
    // Max-Age is in seconds.
    expect(sessionCookieHeader(response)).toContain(
      `Max-Age=${String(SESSION_TTL_MS / 1000)}`,
    );
  });

  it("records the device, so a user can later see where they are logged in", async () => {
    await registerAnna();
    await login(EMAIL, PASSWORD);

    const session = await prisma.session.findFirstOrThrow();

    expect(session.userAgent).toBe("farhand-test-agent");
    expect(session.ipAddress).toBeTruthy();
  });

  it("updates lastLoginAt", async () => {
    await registerAnna();

    await login(EMAIL, PASSWORD);

    const user = await prisma.user.findUniqueOrThrow({
      where: { email: EMAIL },
    });
    expect(user.lastLoginAt).toBeInstanceOf(Date);
  });

  it("replies with who is logged in, and never with the password hash", async () => {
    await registerAnna();

    const response = await login(EMAIL, PASSWORD);
    const body = response.body as LoginBody;

    expect(body.user.email).toBe(EMAIL);
    expect(body.user.displayName).toBe("Anna");
    expect(body.user.emailVerified).toBe(false);
    expect(JSON.stringify(body)).not.toContain("argon2");
    expect(JSON.stringify(body)).not.toContain("passwordHash");
  });

  it("finds the account whatever case and spacing the email is typed in", async () => {
    await registerAnna();

    const response = await login("  Anna@Example.COM ", PASSWORD);

    expect(response.status).toBe(200);
  });

  it("gives every login its own session, one per device", async () => {
    await registerAnna();

    const first = sessionToken(await login(EMAIL, PASSWORD));
    const second = sessionToken(await login(EMAIL, PASSWORD));

    expect(first).not.toBe(second);
    expect(await prisma.session.count()).toBe(2);
  });
});

describe("POST /auth/login — wrong credentials", () => {
  it("rejects a wrong password with 401, and starts no session", async () => {
    await registerAnna();

    const response = await login(EMAIL, "not the right passphrase");

    expect(response.status).toBe(401);
    expect(sessionCookieHeader(response)).toBeUndefined();
    expect(await prisma.session.count()).toBe(0);
  });

  it("answers an unknown email exactly like a wrong password", async () => {
    await registerAnna();

    const wrongPassword = await login(EMAIL, "not the right passphrase");
    const unknownEmail = await login("nobody@example.com", PASSWORD);

    // Pinned so two identically broken answers cannot pass the comparison.
    expect(wrongPassword.status).toBe(401);
    expect(unknownEmail.status).toBe(wrongPassword.status);
    expect(unknownEmail.body).toEqual(wrongPassword.body);
  });

  /**
   * The identical-body test above is not enough on its own: an unknown email
   * that skips the password check answers about four times faster (measured:
   * ~4 ms against ~18 ms), and the speed alone reveals which emails have
   * accounts. DUMMY_PASSWORD_HASH exists to close that.
   *
   * Timing tests are usually flaky, so this one compares the two cases with
   * each other rather than against a fixed number of milliseconds, takes the
   * median of seven tries each, and uses a cutoff far from both outcomes.
   * Measured ratios: 0.21–0.24 without the dummy hash, 0.93–0.97 with it.
   */
  it("takes as long to reject an unknown email as a wrong password", async () => {
    await registerAnna();

    const median = (xs: number[]) =>
      [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;
    const timed = async (email: string) => {
      const start = performance.now();
      await login(email, "not the right passphrase");
      return performance.now() - start;
    };

    // Pinned: two equally fast failures (say, both a 501) would pass the
    // ratio below without the password ever being checked.
    expect((await login(EMAIL, "not the right passphrase")).status).toBe(401);

    const wrongPassword: number[] = [];
    const unknownEmail: number[] = [];
    for (let i = 0; i < 7; i++) {
      wrongPassword.push(await timed(EMAIL));
      unknownEmail.push(await timed("nobody@example.com"));
    }

    expect(median(unknownEmail) / median(wrongPassword)).toBeGreaterThan(0.5);
  });

  it("does not apply the registration password rules to a login attempt", async () => {
    await registerAnna();

    // Too short to register with — but at login it is just a wrong password.
    // A 422 "too short" would tell an attacker about the password policy.
    const response = await login(EMAIL, "short");

    expect(response.status).toBe(401);
  });

  it("rejects a request with no password as a validation error", async () => {
    const response = await request(app)
      .post("/auth/login")
      .send({ email: EMAIL });

    expect(response.status).toBe(422);
  });
});

describe("POST /auth/login — account status", () => {
  async function setStatus(status: "SUSPENDED" | "BANNED" | "DELETED") {
    await prisma.user.update({ where: { email: EMAIL }, data: { status } });
  }

  it("lets an unverified user log in", async () => {
    await registerAnna();

    const response = await login(EMAIL, PASSWORD);

    // docs/02-roles-and-permissions.md: unverified users can sign in; they
    // just cannot post until they confirm their email.
    expect(response.status).toBe(200);
  });

  it("lets a suspended user log in, so they can still finish their deals", async () => {
    await registerAnna();
    await setStatus("SUSPENDED");

    const response = await login(EMAIL, PASSWORD);

    expect(response.status).toBe(200);
  });

  it("refuses a banned user with 403, and starts no session", async () => {
    await registerAnna();
    await setStatus("BANNED");

    const response = await login(EMAIL, PASSWORD);

    expect(response.status).toBe(403);
    expect(sessionCookieHeader(response)).toBeUndefined();
    expect(await prisma.session.count()).toBe(0);
  });

  it("checks the password before revealing that an account is banned", async () => {
    await registerAnna();
    await setStatus("BANNED");

    const response = await login(EMAIL, "not the right passphrase");

    // 403 here would tell anyone who typed the email that the account exists
    // and is banned. Without the right password, it is just a wrong login.
    expect(response.status).toBe(401);
  });

  it("treats a deleted account as if it did not exist", async () => {
    await registerAnna();
    const unknown = await login("nobody@example.com", PASSWORD);
    await setStatus("DELETED");

    const response = await login(EMAIL, PASSWORD);

    expect(response.status).toBe(401);
    expect(response.body).toEqual(unknown.body);
  });
});

describe("session cookie settings per environment", () => {
  it("is Secure in production, so it only ever travels over HTTPS", () => {
    expect(sessionCookieOptions(true)).toMatchObject({
      secure: true,
      httpOnly: true,
      sameSite: "lax",
    });
  });

  it("is not Secure in development, which runs on plain http", () => {
    expect(sessionCookieOptions(false)).toMatchObject({
      secure: false,
      httpOnly: true,
      sameSite: "lax",
    });
  });
});
