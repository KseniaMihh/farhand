import request from "supertest";
import { describe, expect, it, type MockInstance, vi } from "vitest";
import { createApp } from "../../src/app.js";
import { prisma } from "../../src/db.js";
import { mailer } from "../../src/mailer.js";
import { signUpAndLogIn } from "../helpers/auth.js";
import { runQueuedJobs } from "../helpers/jobs.js";

/**
 * POST /auth/resend-verification — issue #41.
 *
 * These tests are the specification. They fail until the TODOs in
 * src/tokens.ts and src/routes/auth.ts are filled in.
 *
 *   npm run test:watch -- resend-verification
 */
const app = createApp();

const EMAIL = "anna@example.com";

function resend(email: string) {
  return request(app).post("/auth/resend-verification").send({ email });
}

function verify(token: string) {
  return request(app).post("/auth/verify-email").send({ token });
}

/**
 * Registers Anna and returns a spy on the verification mailer, already holding
 * the registration email as its first call. Everything sent after that —
 * the resends — lands in the same spy.
 */
async function annaWithMailSpy() {
  const send = vi.spyOn(mailer, "sendVerificationEmail");
  const anna = await signUpAndLogIn(app, EMAIL);
  // Registering queues the email rather than sending it (#85), so the spy is
  // empty until the worker has had its turn.
  await runQueuedJobs();
  return { anna, send };
}

/** The token in the most recent verification email. */
function lastToken(send: MockInstance<typeof mailer.sendVerificationEmail>) {
  const token = send.mock.calls.at(-1)?.[1];
  if (!token) throw new Error("No verification email was sent");
  return token;
}

describe("POST /auth/resend-verification — a link is sent", () => {
  it("emails a new, working link to an unverified account", async () => {
    const { send } = await annaWithMailSpy();

    const response = await resend(EMAIL);
    await runQueuedJobs();

    expect(response.status).toBe(200);
    // One email at registration, one from the resend.
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1]?.[0]).toBe(EMAIL);
    expect((await verify(lastToken(send))).status).toBe(200);
  });

  it("makes the registration link stop working", async () => {
    const { send } = await annaWithMailSpy();
    const registrationToken = lastToken(send);

    await resend(EMAIL);
    await runQueuedJobs();

    expect((await verify(registrationToken)).status).toBe(422);
    expect((await verify(lastToken(send))).status).toBe(200);
  });

  it("keeps only the newest link working when asked more than once", async () => {
    const { send } = await annaWithMailSpy();
    await resend(EMAIL);
    await runQueuedJobs();
    const older = lastToken(send);
    await resend(EMAIL);
    await runQueuedJobs();
    const newer = lastToken(send);

    expect((await verify(older)).status).toBe(422);
    expect((await verify(newer)).status).toBe(200);
  });

  it("sends a link to a suspended user, who can still log in", async () => {
    const { anna, send } = await annaWithMailSpy();
    await prisma.user.update({
      where: { id: anna.id },
      data: { status: "SUSPENDED" },
    });

    await resend(EMAIL);
    await runQueuedJobs();

    expect(send).toHaveBeenCalledTimes(2);
  });

  it("finds the account whatever case and spacing the email is typed in", async () => {
    const { send } = await annaWithMailSpy();

    await resend("  Anna@Example.COM ");
    await runQueuedJobs();

    expect(send).toHaveBeenCalledTimes(2);
  });
});

describe("POST /auth/resend-verification — nothing is sent, and nobody can tell", () => {
  it("answers an unknown email exactly like a real one", async () => {
    await annaWithMailSpy();
    const real = await resend(EMAIL);
    await runQueuedJobs();
    const send = vi.spyOn(mailer, "sendVerificationEmail");
    send.mockClear();

    const unknown = await resend("nobody@example.com");
    await runQueuedJobs();

    // Pinned so two identically broken answers cannot pass the comparison.
    expect(real.status).toBe(200);
    expect(unknown.status).toBe(real.status);
    expect(unknown.body).toEqual(real.body);
    expect(send).not.toHaveBeenCalled();
  });

  it("sends nothing to an address that is already verified, and answers the same", async () => {
    const { anna, send } = await annaWithMailSpy();
    const real = await resend(EMAIL);
    await runQueuedJobs();
    expect(real.status).toBe(200);
    await prisma.user.update({
      where: { id: anna.id },
      data: { emailVerifiedAt: new Date() },
    });
    send.mockClear();
    const tokensBefore = await prisma.verificationToken.count();

    const response = await resend(EMAIL);
    await runQueuedJobs();

    expect(response.body).toEqual(real.body);
    expect(send).not.toHaveBeenCalled();
    expect(await prisma.verificationToken.count()).toBe(tokensBefore);
  });

  it("sends nothing to a banned or deleted account, and answers the same", async () => {
    const { anna, send } = await annaWithMailSpy();
    const real = await resend(EMAIL);
    await runQueuedJobs();
    expect(real.status).toBe(200);

    for (const status of ["BANNED", "DELETED"] as const) {
      await prisma.user.update({ where: { id: anna.id }, data: { status } });
      send.mockClear();

      const response = await resend(EMAIL);
      await runQueuedJobs();

      expect(response.body).toEqual(real.body);
      expect(send).not.toHaveBeenCalled();
    }
  });

  it("rejects a request without a valid email as a validation error", async () => {
    const response = await resend("not-an-email");
    await runQueuedJobs();

    expect(response.status).toBe(422);
  });
});
