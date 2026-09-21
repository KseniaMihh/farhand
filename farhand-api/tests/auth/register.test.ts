import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { prisma } from "../../src/db.js";

/**
 * POST /auth/register — issue #9.
 *
 * These tests are the specification. They fail until the TODOs in
 * src/routes/auth.ts and src/password.ts are filled in; making them pass is
 * the task.
 *
 * Run one at a time while you work:
 *   npm run test:watch -- register
 */
const app = createApp();

/** A request body that should always succeed. Vary one field per test. */
function validPayload(overrides: Record<string, unknown> = {}) {
  return {
    email: "anna@example.com",
    password: "a decent long passphrase",
    displayName: "Anna",
    countryCode: "EE",
    ...overrides,
  };
}

function register(body: Record<string, unknown>) {
  return request(app).post("/auth/register").send(body);
}

describe("POST /auth/register — success", () => {
  it("creates the account", async () => {
    const response = await register(validPayload());

    expect(response.status).toBe(201);

    const user = await prisma.user.findUnique({
      where: { email: "anna@example.com" },
    });
    expect(user).not.toBeNull();
  });

  it("creates the profile in the same request", async () => {
    await register(validPayload());

    const user = await prisma.user.findUnique({
      where: { email: "anna@example.com" },
      include: { profile: true },
    });

    // A User without a Profile is a half-made account. Both rows, or neither.
    expect(user?.profile).not.toBeNull();
    expect(user?.profile?.displayName).toBe("Anna");
    expect(user?.profile?.countryCode).toBe("EE");
  });

  it("stores the password as an argon2id hash, never as plaintext", async () => {
    const payload = validPayload();
    await register(payload);

    const user = await prisma.user.findUnique({
      where: { email: "anna@example.com" },
    });

    expect(user?.passwordHash).not.toBe(payload.password);
    expect(user?.passwordHash).not.toContain(payload.password);
    // The prefix is argon2's self-description. "$argon2i$" or "$argon2d$" here
    // would mean the wrong algorithm reached the database.
    expect(user?.passwordHash.startsWith("$argon2id$")).toBe(true);
  });

  it("leaves the account unverified", async () => {
    await register(validPayload());

    const user = await prisma.user.findUnique({
      where: { email: "anna@example.com" },
    });

    // Email verification is #10. Nothing here should mark the address proven.
    expect(user?.emailVerifiedAt).toBeNull();
  });

  it("normalises the email, so one address cannot become two accounts", async () => {
    await register(validPayload({ email: "  Anna@Example.COM  " }));

    const user = await prisma.user.findUnique({
      where: { email: "anna@example.com" },
    });

    expect(user).not.toBeNull();
  });
});

describe("POST /auth/register — a duplicate email is indistinguishable", () => {
  /**
   * The point of these two tests: someone who types an address into this
   * endpoint must not learn whether that address has an account here.
   *
   * Note what is NOT asserted — the exact status code or body. The property is
   * that the two responses are *the same as each other*, so the wording of the
   * response is yours to choose, and changing it later cannot accidentally
   * reintroduce the leak.
   */
  beforeEach(async () => {
    await register(validPayload());
  });

  it("answers a repeat registration exactly as it answered the first", async () => {
    const first = await register(validPayload({ email: "bob@example.com" }));
    const repeat = await register(validPayload({ email: "bob@example.com" }));

    // Pinned so this test cannot pass by both responses being identically
    // broken — two matching 500s would satisfy the comparison below.
    expect(first.status).toBe(201);

    expect(repeat.status).toBe(first.status);
    expect(repeat.body).toEqual(first.body);
  });

  it("does not create a second account, or touch the first", async () => {
    const before = await prisma.user.findUniqueOrThrow({
      where: { email: "anna@example.com" },
    });

    await register(
      validPayload({ password: "a completely different passphrase" }),
    );

    const users = await prisma.user.findMany({
      where: { email: "anna@example.com" },
    });
    expect(users).toHaveLength(1);

    // The second attempt must not overwrite the real owner's password — that
    // would be account takeover dressed up as registration.
    expect(users[0]?.passwordHash).toBe(before.passwordHash);
  });
});

describe("POST /auth/register — validation", () => {
  /**
   * 422 is what src/middleware/error-handler.ts returns for a ZodError.
   *
   * Note that docs/06-api-contract.md says validation failures are 400. The
   * code and the document disagree, and one of them needs changing — see the
   * note in the pull request. These tests follow the code; if you decide the
   * document wins, change the handler and these three numbers together.
   */
  const VALIDATION_STATUS = 422;

  it("rejects a password that is too short", async () => {
    const response = await register(validPayload({ password: "short" }));

    expect(response.status).toBe(VALIDATION_STATUS);
    expect(await prisma.user.count()).toBe(0);
  });

  it("rejects a country that is not a two-letter code", async () => {
    const response = await register(validPayload({ countryCode: "Estonia" }));

    expect(response.status).toBe(VALIDATION_STATUS);
    expect(await prisma.user.count()).toBe(0);
  });

  it("rejects an address that is not an email", async () => {
    const response = await register(validPayload({ email: "not-an-email" }));

    expect(response.status).toBe(VALIDATION_STATUS);
    expect(await prisma.user.count()).toBe(0);
  });

  it("rejects a display name longer than the column", async () => {
    const response = await register(
      validPayload({ displayName: "x".repeat(51) }),
    );

    // Caught by the schema, not by the database. A VarChar(50) overflow
    // surfaces as a 500 from Postgres, which is a bug, not a validation error.
    expect(response.status).toBe(VALIDATION_STATUS);
  });

  it("names the field that failed", async () => {
    const response = await register(validPayload({ countryCode: "Estonia" }));
    const body = response.body as {
      error: { code: string; details?: { field: string }[] };
    };

    expect(body.error.code).toBe("VALIDATION_FAILED");
    expect(body.error.details?.map((d) => d.field)).toContain("countryCode");
  });
});
