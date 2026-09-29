import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/app.js";
import { withoutRequestId } from "../helpers/http.js";
import { prisma } from "../../src/db.js";
import { mailer } from "../../src/mailer.js";
import { hashToken, PASSWORD_RESET_TTL_MS } from "../../src/tokens.js";
import { logIn, PASSWORD, signUpAndLogIn } from "../helpers/auth.js";

/**
 * POST /auth/forgot-password and POST /auth/reset-password — issue #13.
 *
 * These tests are the specification. They fail until the TODOs in
 * src/tokens.ts and src/routes/auth.ts are filled in.
 *
 *   npm run test:watch -- password-reset
 */
const app = createApp();

const EMAIL = "anna@example.com";
const NEW_PASSWORD = "a brand new passphrase";

function forgot(email: string) {
  return request(app).post("/auth/forgot-password").send({ email });
}

function reset(token: string, password = NEW_PASSWORD) {
  return request(app).post("/auth/reset-password").send({ token, password });
}

function login(password: string) {
  return request(app).post("/auth/login").send({ email: EMAIL, password });
}

/** Asks for a reset link and returns the raw token that would be emailed. */
async function requestResetToken(email = EMAIL): Promise<string> {
  const send = vi.spyOn(mailer, "sendPasswordResetEmail");
  await forgot(email);
  const token = send.mock.calls.at(-1)?.[1];
  if (!token) throw new Error("forgot-password did not send a reset email");
  return token;
}

describe("POST /auth/forgot-password", () => {
  it("emails a reset link to an account that exists", async () => {
    await signUpAndLogIn(app, EMAIL);
    const send = vi.spyOn(mailer, "sendPasswordResetEmail");

    const response = await forgot(EMAIL);

    expect(response.status).toBe(200);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0]).toBe(EMAIL);
  });

  it("stores only a hash of the token, as a reset token that expires in an hour", async () => {
    await signUpAndLogIn(app, EMAIL);
    const before = Date.now();

    const token = await requestResetToken();
    const row = await prisma.verificationToken.findUniqueOrThrow({
      where: { tokenHash: hashToken(token) },
    });

    expect(row.tokenHash).not.toBe(token);
    expect(row.type).toBe("PASSWORD_RESET");
    expect(row.usedAt).toBeNull();
    const expected = before + PASSWORD_RESET_TTL_MS;
    expect(row.expiresAt.getTime()).toBeGreaterThan(expected - 60_000);
    expect(row.expiresAt.getTime()).toBeLessThan(expected + 60_000);
  });

  it("answers an unknown email exactly like a known one, and sends nothing", async () => {
    await signUpAndLogIn(app, EMAIL);
    const known = await forgot(EMAIL);
    const send = vi.spyOn(mailer, "sendPasswordResetEmail");

    const unknown = await forgot("nobody@example.com");

    // Pinned so two identically broken answers cannot pass the comparison.
    expect(known.status).toBe(200);
    expect(unknown.status).toBe(known.status);
    expect(withoutRequestId(unknown.body)).toEqual(
      withoutRequestId(known.body),
    );
    expect(send).not.toHaveBeenCalled();
  });

  it("sends nothing to a banned or deleted account, and still answers the same", async () => {
    const anna = await signUpAndLogIn(app, EMAIL);
    const known = await forgot(EMAIL);
    expect(known.status).toBe(200);

    for (const status of ["BANNED", "DELETED"] as const) {
      await prisma.user.update({ where: { id: anna.id }, data: { status } });
      const send = vi.spyOn(mailer, "sendPasswordResetEmail");

      const response = await forgot(EMAIL);

      expect(withoutRequestId(response.body)).toEqual(
        withoutRequestId(known.body),
      );
      expect(send).not.toHaveBeenCalled();
      send.mockRestore();
    }
  });

  it("finds the account whatever case and spacing the email is typed in", async () => {
    await signUpAndLogIn(app, EMAIL);
    const send = vi.spyOn(mailer, "sendPasswordResetEmail");

    await forgot("  Anna@Example.COM ");

    expect(send).toHaveBeenCalledTimes(1);
  });

  it("makes only the newest link work when asked more than once", async () => {
    await signUpAndLogIn(app, EMAIL);
    const older = await requestResetToken();
    const newer = await requestResetToken();

    expect((await reset(older)).status).toBe(422);
    expect((await reset(newer)).status).toBe(200);
  });

  it("rejects a request without a valid email as a validation error", async () => {
    const response = await forgot("not-an-email");

    expect(response.status).toBe(422);
  });
});

describe("POST /auth/reset-password — success", () => {
  it("sets the new password: it works, and the old one does not", async () => {
    await signUpAndLogIn(app, EMAIL);
    const token = await requestResetToken();

    const response = await reset(token);

    expect(response.status).toBe(200);
    expect((await login(NEW_PASSWORD)).status).toBe(200);
    expect((await login(PASSWORD)).status).toBe(401);
  });

  it("logs the account out on every device", async () => {
    const laptop = await signUpAndLogIn(app, EMAIL);
    const phone = await logIn(app, EMAIL);
    const token = await requestResetToken();

    await reset(token);

    expect(await prisma.session.count()).toBe(0);
    const me = (cookie: string) =>
      request(app).get("/auth/me").set("Cookie", cookie);
    expect((await me(laptop.cookie)).status).toBe(401);
    expect((await me(phone.cookie)).status).toBe(401);
  });

  it("verifies the email, since the link proved the person owns the address", async () => {
    await signUpAndLogIn(app, EMAIL);
    const token = await requestResetToken();

    await reset(token);

    const user = await prisma.user.findUniqueOrThrow({
      where: { email: EMAIL },
    });
    expect(user.emailVerifiedAt).toBeInstanceOf(Date);
  });

  it("keeps the original verification date of an already verified address", async () => {
    const anna = await signUpAndLogIn(app, EMAIL);
    const verifiedAt = new Date("2026-01-15T10:00:00Z");
    await prisma.user.update({
      where: { id: anna.id },
      data: { emailVerifiedAt: verifiedAt },
    });
    const token = await requestResetToken();

    await reset(token);

    const user = await prisma.user.findUniqueOrThrow({
      where: { id: anna.id },
    });
    expect(user.emailVerifiedAt?.toISOString()).toBe(verifiedAt.toISOString());
  });

  it("lets someone fix a too-short password and try again with the same link", async () => {
    await signUpAndLogIn(app, EMAIL);
    const token = await requestResetToken();

    // Registration rules apply to a NEW password — and a rejected password
    // must not burn the link.
    const tooShort = await reset(token, "short");
    const retry = await reset(token);

    expect(tooShort.status).toBe(422);
    expect(retry.status).toBe(200);
  });
});

describe("POST /auth/reset-password — rejected tokens", () => {
  it("rejects a token that was already used, and keeps the password it set", async () => {
    await signUpAndLogIn(app, EMAIL);
    const token = await requestResetToken();
    await reset(token);

    const second = await reset(token, "yet another passphrase");

    expect(second.status).toBe(422);
    expect((await login(NEW_PASSWORD)).status).toBe(200);
  });

  it("rejects an expired token, and leaves the old password in place", async () => {
    await signUpAndLogIn(app, EMAIL);
    const token = await requestResetToken();
    await prisma.verificationToken.updateMany({
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const response = await reset(token);

    expect(response.status).toBe(422);
    expect((await login(PASSWORD)).status).toBe(200);
  });

  it("rejects an email-verification token presented as a reset token", async () => {
    // Registration emails a verification token; it must not change a password.
    const send = vi.spyOn(mailer, "sendVerificationEmail");
    await signUpAndLogIn(app, EMAIL);
    const verificationToken = send.mock.calls.at(-1)?.[1] ?? "";

    const response = await reset(verificationToken);

    expect(verificationToken).not.toBe("");
    expect(response.status).toBe(422);
    expect((await login(PASSWORD)).status).toBe(200);
  });

  it("rejects a token belonging to a user banned since they asked", async () => {
    const anna = await signUpAndLogIn(app, EMAIL);
    const token = await requestResetToken();
    await prisma.user.update({
      where: { id: anna.id },
      data: { status: "BANNED" },
    });

    const response = await reset(token);

    expect(response.status).toBe(422);
  });

  it("gives the same answer for used, expired and unknown tokens", async () => {
    await signUpAndLogIn(app, EMAIL);
    const token = await requestResetToken();
    await reset(token);
    const used = await reset(token);

    const unknown = await reset("not-a-real-token");

    await prisma.verificationToken.updateMany({
      data: { usedAt: null, expiresAt: new Date(Date.now() - 1000) },
    });
    const expired = await reset(token);

    expect(used.status).toBe(422);
    expect(withoutRequestId(unknown.body)).toEqual(withoutRequestId(used.body));
    expect(withoutRequestId(expired.body)).toEqual(withoutRequestId(used.body));
  });

  /**
   * Two submits of the same reset form at once. Staged, not raced — see
   * verify-email.test.ts for why: after the first reset, the token lookup is
   * made to return the row as it looked before it was used.
   */
  it("refuses a second use even when the lookup still saw the token as unused", async () => {
    await signUpAndLogIn(app, EMAIL);
    const token = await requestResetToken();
    const unused = await prisma.verificationToken.findUniqueOrThrow({
      where: { tokenHash: hashToken(token) },
      include: { user: true },
    });

    expect((await reset(token)).status).toBe(200);

    vi.spyOn(prisma.verificationToken, "findUnique").mockResolvedValueOnce(
      unused,
    );
    const second = await reset(token, "yet another passphrase");

    expect(second.status).toBe(422);
    expect((await login(NEW_PASSWORD)).status).toBe(200);
  });
});
