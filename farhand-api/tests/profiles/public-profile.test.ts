import type { AccountStatus } from "@prisma/client";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { prisma } from "../../src/db.js";
import { signUpVerifiedAndLogIn, type TestUser } from "../helpers/auth.js";
import { withoutRequestId } from "../helpers/http.js";

/**
 * GET /users/:id — issue #65.
 *
 * These tests are the specification. They fail until the TODOs in
 * src/services/profiles.ts are filled in.
 *
 *   npm run test:watch -- public-profile
 *
 * Two rules carry most of the file. What a stranger may see
 * (docs/07-trust-and-safety.md: display name and country, and no email
 * addresses anywhere in the API), and the fact that an account which is gone
 * must be indistinguishable from an id that never existed.
 */
/** The one answer this endpoint gives, and the one it gives instead. */
interface ProfileBody {
  user: {
    id: string;
    displayName: string;
    countryCode: string;
    bio: string | null;
    memberSince: string;
  };
}

interface ErrorBody {
  error: { code: string; message: string };
}

const app = createApp();

let anna: TestUser = { id: "", email: "", cookie: "" };

beforeEach(async () => {
  anna = await signUpVerifiedAndLogIn(app, "anna@example.com", "Anna");
});

/** Puts a status on an existing account, the way moderation (#27) would. */
async function setStatus(userId: string, status: AccountStatus) {
  await prisma.user.update({ where: { id: userId }, data: { status } });
}

describe("GET /users/:id", () => {
  it("returns the public profile, with no session at all", async () => {
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: anna.id },
    });

    const response = await request(app).get(`/users/${anna.id}`);

    expect(response.status).toBe(200);
    expect((response.body as ProfileBody).user).toEqual({
      id: anna.id,
      displayName: "Anna",
      countryCode: "EE",
      bio: null,
      memberSince: user.createdAt.toISOString(),
    });
  });

  /**
   * Not "does it contain an email" — "is it exactly these five keys". A
   * whitelist is the only version of this test that still works the day
   * somebody adds a column to Profile.
   */
  it("returns those five fields and nothing else", async () => {
    await prisma.profile.update({
      where: { userId: anna.id },
      data: { city: "Tallinn", avatarUrl: "https://example.com/a.png" },
    });

    const response = await request(app).get(`/users/${anna.id}`);

    expect(Object.keys((response.body as ProfileBody).user).sort()).toEqual([
      "bio",
      "countryCode",
      "displayName",
      "id",
      "memberSince",
    ]);
  });

  it("never leaks the email address, anywhere in the body", async () => {
    const response = await request(app).get(`/users/${anna.id}`);

    expect(JSON.stringify(response.body)).not.toContain("anna@example.com");
    expect(JSON.stringify(response.body)).not.toContain("@");
  });

  it("shows a bio once there is one", async () => {
    await prisma.profile.update({
      where: { userId: anna.id },
      data: { bio: "I fly Tallinn–Tokyo twice a year." },
    });

    const response = await request(app).get(`/users/${anna.id}`);

    expect((response.body as ProfileBody).user.bio).toBe(
      "I fly Tallinn–Tokyo twice a year.",
    );
  });

  /**
   * Reading your own public profile shows the public profile. `GET /auth/me` is
   * where the private fields live, and there is no third answer in between.
   */
  it("shows the same thing to the person it belongs to", async () => {
    const anonymous = await request(app).get(`/users/${anna.id}`);
    const themselves = await request(app)
      .get(`/users/${anna.id}`)
      .set("Cookie", anna.cookie);

    expect(themselves.status).toBe(200);
    expect(themselves.body).toEqual(anonymous.body);
  });

  it("is readable while its owner is suspended", async () => {
    await setStatus(anna.id, "SUSPENDED");

    const response = await request(app).get(`/users/${anna.id}`);

    expect(response.status).toBe(200);
    expect((response.body as ProfileBody).user.displayName).toBe("Anna");
  });

  it("answers 404 for an id that names nobody", async () => {
    const response = await request(app).get("/users/cm0000000000000000000000");

    expect(response.status).toBe(404);
    expect((response.body as ErrorBody).error.code).toBe("NOT_FOUND");
  });

  /**
   * The heart of the issue. If a deleted account answered differently from an
   * unknown id, then "is this person still on Farhand?" becomes a question
   * anybody can ask about anybody — the same enumeration problem registration
   * answers by always replying identically (#10).
   *
   * Byte-identical apart from the request id, which differs on every request by
   * design (#29).
   */
  it.each(["DELETED", "BANNED"] as const)(
    "answers exactly like an unknown id when the account is %s",
    async (status) => {
      const unknown = await request(app).get("/users/cm000000000000000000000x");
      await setStatus(anna.id, status);

      const gone = await request(app).get(`/users/${anna.id}`);

      expect(gone.status).toBe(unknown.status);
      expect(withoutRequestId(gone.body)).toEqual(
        withoutRequestId(unknown.body),
      );
    },
  );

  /**
   * Registration creates the user and the profile in one transaction (#10), so
   * this cannot happen. It is here because the endpoint's answer is a profile:
   * if there is no profile row, returning half of one — a display name that is
   * an empty string, a country that is undefined — would be worse than saying
   * there is nothing here.
   */
  it("answers 404 for a user with no profile row", async () => {
    const orphan = await prisma.user.create({
      data: { email: "orphan@example.com", passwordHash: "x" },
    });

    const response = await request(app).get(`/users/${orphan.id}`);

    expect(response.status).toBe(404);
  });

  it("refuses an empty id rather than listing anybody", async () => {
    const response = await request(app).get("/users/");

    expect(response.status).toBe(404);
  });
});
