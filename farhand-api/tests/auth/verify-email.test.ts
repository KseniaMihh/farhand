import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/app.js";
import { withoutRequestId } from "../helpers/http.js";
import { runQueuedJobs } from "../helpers/jobs.js";
import { prisma } from "../../src/db.js";
import { mailer } from "../../src/mailer.js";
import { hashToken } from "../../src/tokens.js";

/**
 * POST /auth/verify-email — issue #10.
 *
 * These tests are the specification. They fail until the TODOs in
 * src/tokens.ts and src/routes/auth.ts are filled in.
 *
 *   npm run test:watch -- verify-email
 */
const app = createApp();

const EMAIL = "anna@example.com";

/**
 * Registers a user and returns the raw token that would have been emailed.
 *
 * The raw token exists in exactly one place — the email — so the test listens
 * where the email is sent. `spyOn` keeps the real method running; it only
 * records the call. vitest.config.ts restores spies after every test.
 */
async function registerAndCaptureToken(): Promise<string> {
  const send = vi.spyOn(mailer, "sendVerificationEmail");

  await request(app).post("/auth/register").send({
    email: EMAIL,
    password: "a decent long passphrase",
    displayName: "Anna",
    countryCode: "EE",
  });

  // Registering queues the email; the worker sends it (#85).
  await runQueuedJobs();

  const token = send.mock.calls.at(-1)?.[1];
  if (!token) throw new Error("Registration did not send a verification email");
  return token;
}

function verify(token: string) {
  return request(app).post("/auth/verify-email").send({ token });
}

async function currentUser() {
  return prisma.user.findUniqueOrThrow({ where: { email: EMAIL } });
}

describe("POST /auth/verify-email — success", () => {
  it("verifies the address with the token from the email", async () => {
    const token = await registerAndCaptureToken();

    const response = await verify(token);

    expect(response.status).toBe(200);
    expect((await currentUser()).emailVerifiedAt).toBeInstanceOf(Date);
  });

  it("consumes the token", async () => {
    const token = await registerAndCaptureToken();

    await verify(token);

    const row = await prisma.verificationToken.findUniqueOrThrow({
      where: { tokenHash: hashToken(token) },
    });
    expect(row.usedAt).toBeInstanceOf(Date);
  });
});

/**
 * 422: the request was readable and its content was wrong
 * (docs/06-api-contract.md). The exact error body is yours to choose; these
 * tests only require that every rejection looks the same.
 */
const REJECTED = 422;

describe("POST /auth/verify-email — rejected tokens", () => {
  it("rejects a token that was already used", async () => {
    const token = await registerAndCaptureToken();
    await verify(token);

    const second = await verify(token);

    expect(second.status).toBe(REJECTED);
  });

  it("rejects an expired token, and leaves the address unverified", async () => {
    const token = await registerAndCaptureToken();

    // Age the token rather than wait 24 hours or fake the clock. Faking time
    // in a test that talks to a real database tends to fight the driver.
    await prisma.verificationToken.updateMany({
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const response = await verify(token);

    expect(response.status).toBe(REJECTED);
    expect((await currentUser()).emailVerifiedAt).toBeNull();
  });

  it("rejects a token that never existed", async () => {
    await registerAndCaptureToken();

    const response = await verify("not-a-real-token");

    expect(response.status).toBe(REJECTED);
    expect((await currentUser()).emailVerifiedAt).toBeNull();
  });

  it("rejects a password-reset token presented as a verification token", async () => {
    await registerAndCaptureToken();
    const user = await currentUser();

    // A valid, unexpired, unused token — of the wrong kind.
    const resetToken = "a-password-reset-token";
    await prisma.verificationToken.create({
      data: {
        userId: user.id,
        type: "PASSWORD_RESET",
        tokenHash: hashToken(resetToken),
        expiresAt: new Date(Date.now() + 60_000),
      },
    });

    const response = await verify(resetToken);

    expect(response.status).toBe(REJECTED);
    expect((await currentUser()).emailVerifiedAt).toBeNull();
  });

  it("rejects an empty token", async () => {
    const response = await verify("   ");

    expect(response.status).toBe(REJECTED);
  });

  it("gives the same answer for used, expired and unknown tokens", async () => {
    const used = await registerAndCaptureToken();
    await verify(used);
    const usedResponse = await verify(used);

    const unknownResponse = await verify("not-a-real-token");

    await prisma.verificationToken.updateMany({
      data: { usedAt: null, expiresAt: new Date(Date.now() - 1000) },
    });
    const expiredResponse = await verify(used);

    expect(unknownResponse.status).toBe(usedResponse.status);
    expect(withoutRequestId(unknownResponse.body)).toEqual(
      withoutRequestId(usedResponse.body),
    );
    expect(expiredResponse.status).toBe(usedResponse.status);
    expect(withoutRequestId(expiredResponse.body)).toEqual(
      withoutRequestId(usedResponse.body),
    );
  });
});

describe("POST /auth/verify-email — single use under concurrency", () => {
  /**
   * The double-click: two requests with the same token arrive together, and
   * both look the token up before either has marked it used. Both see
   * `usedAt: null`. Exactly one may succeed.
   *
   * Racing two real requests does not test this. The requests do not reliably
   * overlap, so a check-then-update implementation passes by luck — this was
   * tried, and the naive version passed every run.
   *
   * So the race is staged instead. The token is used once for real; then the
   * lookup is made to return the row as it looked BEFORE that — the stale
   * read the losing request would see. From there, only a write that
   * re-checks `usedAt` in the same statement (the updateMany in the TODO)
   * can refuse. A plain update by id succeeds, and this test fails.
   *
   * It assumes the lookup is `findUnique`, the natural call for a unique
   * column. Use `findFirst` and the stale row is never served, and this test
   * passes without proving anything.
   */
  it("refuses a second use even when the lookup still saw the token as unused", async () => {
    const token = await registerAndCaptureToken();
    const unused = await prisma.verificationToken.findUniqueOrThrow({
      where: { tokenHash: hashToken(token) },
    });

    const first = await verify(token);
    expect(first.status).toBe(200);

    vi.spyOn(prisma.verificationToken, "findUnique").mockResolvedValueOnce(
      unused,
    );
    const second = await verify(token);

    expect(second.status).toBe(REJECTED);
  });
});
