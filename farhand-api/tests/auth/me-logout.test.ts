import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/app.js";
import { prisma } from "../../src/db.js";
import { SESSION_COOKIE } from "../../src/sessions.js";
import { logIn, signUpAndLogIn } from "../helpers/auth.js";

/**
 * GET /auth/me and POST /auth/logout — issue #12.
 *
 * Both sit behind requireAuth, so these tests are also where requireAuth
 * itself is tested. They fail until the TODOs in src/middleware/auth.ts and
 * src/routes/auth.ts are filled in.
 *
 *   npm run test:watch -- me-logout
 */
const app = createApp();

function me(cookie?: string) {
  const req = request(app).get("/auth/me");
  return cookie ? req.set("Cookie", cookie) : req;
}

function logout(cookie?: string) {
  const req = request(app).post("/auth/logout");
  return cookie ? req.set("Cookie", cookie) : req;
}

interface MeBody {
  user: {
    id: string;
    email: string;
    role: string;
    status: string;
    suspendedUntil: string | null;
    emailVerified: boolean;
    profile: {
      displayName: string;
      bio: string | null;
      countryCode: string;
      city: string | null;
      avatarUrl: string | null;
    };
  };
}

describe("GET /auth/me — logged in", () => {
  it("returns the user and their profile", async () => {
    const anna = await signUpAndLogIn(app, "anna@example.com");

    const response = await me(anna.cookie);
    const body = response.body as MeBody;

    expect(response.status).toBe(200);
    expect(body.user).toMatchObject({
      id: anna.id,
      email: "anna@example.com",
      role: "USER",
      status: "ACTIVE",
      suspendedUntil: null,
      emailVerified: false,
      profile: {
        displayName: "Anna",
        countryCode: "EE",
        bio: null,
        city: null,
        avatarUrl: null,
      },
    });
  });

  it("never includes the password hash", async () => {
    const anna = await signUpAndLogIn(app, "anna@example.com");

    const response = await me(anna.cookie);

    expect(response.status).toBe(200);
    expect(JSON.stringify(response.body)).not.toContain("argon2");
    expect(JSON.stringify(response.body)).not.toContain("passwordHash");
  });

  it("answers each person with themselves, going by their own cookie", async () => {
    const anna = await signUpAndLogIn(app, "anna@example.com", "Anna");
    const bob = await signUpAndLogIn(app, "bob@example.com", "Bob");

    const annaBody = (await me(anna.cookie)).body as MeBody;
    const bobBody = (await me(bob.cookie)).body as MeBody;

    expect(annaBody.user.email).toBe("anna@example.com");
    expect(bobBody.user.email).toBe("bob@example.com");
  });

  it("still answers a suspended user, who can see their account", async () => {
    const anna = await signUpAndLogIn(app, "anna@example.com");
    await prisma.user.update({
      where: { id: anna.id },
      data: { status: "SUSPENDED" },
    });

    const response = await me(anna.cookie);

    expect(response.status).toBe(200);
    expect((response.body as MeBody).user.status).toBe("SUSPENDED");
  });
});

describe("GET /auth/me — requireAuth says no", () => {
  it("rejects a request with no cookie", async () => {
    const response = await me();

    expect(response.status).toBe(401);
  });

  it("rejects a cookie that matches no session", async () => {
    const response = await me(`${SESSION_COOKIE}=made-up-token`);

    expect(response.status).toBe(401);
  });

  it("rejects an expired session", async () => {
    const anna = await signUpAndLogIn(app, "anna@example.com");
    await prisma.session.updateMany({
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const response = await me(anna.cookie);

    expect(response.status).toBe(401);
  });

  it("rejects a user banned after they logged in, on their very next request", async () => {
    const anna = await signUpAndLogIn(app, "anna@example.com");
    await prisma.user.update({
      where: { id: anna.id },
      data: { status: "BANNED" },
    });

    // The cookie and the session row are both still there. The ban has to
    // land anyway — ADR 0007's reason for sessions over JWTs.
    const response = await me(anna.cookie);

    expect(response.status).toBe(401);
  });

  it("rejects a user whose account was deleted", async () => {
    const anna = await signUpAndLogIn(app, "anna@example.com");
    await prisma.user.update({
      where: { id: anna.id },
      data: { status: "DELETED" },
    });

    const response = await me(anna.cookie);

    expect(response.status).toBe(401);
  });

  it("gives the same answer for every reason", async () => {
    const anna = await signUpAndLogIn(app, "anna@example.com");
    const noCookie = await me();
    const madeUp = await me(`${SESSION_COOKIE}=made-up-token`);
    await prisma.user.update({
      where: { id: anna.id },
      data: { status: "BANNED" },
    });
    const banned = await me(anna.cookie);

    expect(noCookie.status).toBe(401);
    expect(madeUp.body).toEqual(noCookie.body);
    expect(banned.body).toEqual(noCookie.body);
  });
});

describe("POST /auth/logout", () => {
  it("deletes the session and replies 204", async () => {
    const anna = await signUpAndLogIn(app, "anna@example.com");

    const response = await logout(anna.cookie);

    expect(response.status).toBe(204);
    expect(await prisma.session.count()).toBe(0);
  });

  it("tells the browser to forget the cookie", async () => {
    const anna = await signUpAndLogIn(app, "anna@example.com");

    const response = await logout(anna.cookie);

    const cookies = response.headers["set-cookie"] as unknown as
      string[] | undefined;
    const cleared = cookies?.find((c) => c.startsWith(`${SESSION_COOKIE}=`));
    // Clearing a cookie means setting it to empty, already expired.
    expect(cleared).toMatch(new RegExp(`^${SESSION_COOKIE}=;`));
    expect(cleared).toMatch(/Expires=Thu, 01 Jan 1970/);
    expect(cleared).toMatch(/Path=\//);
  });

  it("makes the old cookie useless, even if the browser kept it", async () => {
    const anna = await signUpAndLogIn(app, "anna@example.com");
    await logout(anna.cookie);

    const response = await me(anna.cookie);

    expect(response.status).toBe(401);
  });

  it("logs out only this device", async () => {
    const laptop = await signUpAndLogIn(app, "anna@example.com");
    const phone = await logIn(app, "anna@example.com");

    await logout(laptop.cookie);

    expect((await me(laptop.cookie)).status).toBe(401);
    expect((await me(phone.cookie)).status).toBe(200);
  });

  it("requires being logged in", async () => {
    const response = await logout();

    expect(response.status).toBe(401);
  });

  /**
   * The double-click on "Log out". Both requests pass requireAuth while the
   * session still exists; the first deletes it, and the second must not fail
   * for finding nothing left to delete.
   *
   * Staged rather than raced, for the reason given in verify-email.test.ts:
   * real simultaneous requests do not reliably overlap. After the first
   * logout, requireAuth's lookup is made to return the session as it looked
   * before — what the second request saw.
   */
  it("answers a second, simultaneous logout with 204 too, not an error", async () => {
    const anna = await signUpAndLogIn(app, "anna@example.com");
    const before = await prisma.session.findFirstOrThrow({
      include: { user: { include: { profile: true } } },
    });

    expect((await logout(anna.cookie)).status).toBe(204);

    vi.spyOn(prisma.session, "findUnique").mockResolvedValueOnce(before);
    const second = await logout(anna.cookie);

    expect(second.status).toBe(204);
  });
});
