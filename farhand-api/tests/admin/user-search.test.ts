import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/app.js";
import { prisma } from "../../src/db.js";
import { logger } from "../../src/logger.js";
import {
  signUpAndLogIn,
  signUpVerifiedAndLogIn,
  type TestUser,
} from "../helpers/auth.js";

/**
 * `GET /admin/users` — issue #67.
 *
 * These tests are the specification. They fail until the TODOs in
 * src/services/moderation.ts are filled in.
 *
 *   npm run test:watch -- user-search
 *
 * The endpoint that hands out email addresses. There is exactly one of those in
 * the API, and the reason this file is long is that the difference between a
 * moderation tool and a way to download the user table is entirely in the
 * details (docs/07-trust-and-safety.md).
 */
const app = createApp();

interface SearchBody {
  items: {
    id: string;
    email: string;
    displayName: string | null;
    countryCode: string | null;
    role: string;
    status: string;
    suspendedUntil: string | null;
    emailVerified: boolean;
    createdAt: string;
  }[];
  nextCursor: string | null;
}

interface ErrorBody {
  error: { code: string; message: string };
}

let mo: TestUser = { id: "", email: "", cookie: "" };
let anna: TestUser = { id: "", email: "", cookie: "" };

beforeEach(async () => {
  mo = await signUpVerifiedAndLogIn(app, "mo@example.com", "Mo");
  await prisma.user.update({
    where: { id: mo.id },
    data: { role: "MODERATOR" },
  });
  anna = await signUpVerifiedAndLogIn(app, "anna@example.com", "Anna");
});

function search(user: TestUser, query = "") {
  return request(app).get(`/admin/users${query}`).set("Cookie", user.cookie);
}

function moderatorLines(calls: unknown[][]) {
  return calls.filter(
    (call) => typeof call[1] === "string" && call[1].includes("moderator"),
  );
}

describe("GET /admin/users", () => {
  describe("who may call it", () => {
    it("refuses a request with no session", async () => {
      const response = await request(app).get("/admin/users");

      expect(response.status).toBe(401);
    });

    it("refuses an ordinary user", async () => {
      const response = await search(anna);

      expect(response.status).toBe(403);
    });

    it("refuses an unverified account, moderator or not", async () => {
      const unverified = await signUpAndLogIn(app, "new@example.com");
      await prisma.user.update({
        where: { id: unverified.id },
        data: { role: "MODERATOR" },
      });

      const response = await search(unverified);

      expect(response.status).toBe(403);
    });

    it("refuses a suspended moderator", async () => {
      await prisma.user.update({
        where: { id: mo.id },
        data: { status: "SUSPENDED", suspendedUntil: null },
      });

      const response = await search(mo);

      expect(response.status).toBe(403);
    });

    it("lets a moderator in", async () => {
      const response = await search(mo);

      expect(response.status).toBe(200);
    });

    /** An admin can do everything a moderator can (ROLE_RANK, #12). */
    it("lets an admin in", async () => {
      const admin = await signUpVerifiedAndLogIn(app, "boss@example.com", "Bo");
      await prisma.user.update({
        where: { id: admin.id },
        data: { role: "ADMIN" },
      });

      const response = await search(admin);

      expect(response.status).toBe(200);
    });
  });

  describe("finding somebody by email", () => {
    it("finds the account for an exact address", async () => {
      const body = (await search(mo, "?email=anna@example.com"))
        .body as SearchBody;

      expect(body.items).toHaveLength(1);
      expect(body.items[0]?.id).toBe(anna.id);
    });

    /** Registration lowercases what it stores (#10), so a search must too. */
    it("finds it whatever case it is typed in", async () => {
      const body = (await search(mo, "?email=%20ANNA@Example.COM%20"))
        .body as SearchBody;

      expect(body.items).toHaveLength(1);
      expect(body.items[0]?.id).toBe(anna.id);
    });

    /**
     * The safety argument of the whole endpoint. A partial email match would
     * make `?email=@gmail.com` a way to page through every Gmail user in the
     * database — the "export the user table" the issue asks us not to build.
     */
    it.each(["?email=@example.com", "?email=anna", "?email=example"])(
      "finds nothing for the partial address %s",
      async (query) => {
        const body = (await search(mo, query)).body as SearchBody;

        expect(body.items).toEqual([]);
      },
    );

    it("finds nothing for an address nobody has", async () => {
      const body = (await search(mo, "?email=ghost@example.com"))
        .body as SearchBody;

      expect(body.items).toEqual([]);
      expect(body.nextCursor).toBeNull();
    });
  });

  describe("finding somebody by name", () => {
    beforeEach(async () => {
      for (const [email, name] of [
        ["annika@example.com", "Annika"],
        ["joanna@example.com", "Joanna"],
        ["bob@example.com", "Bob"],
      ]) {
        await signUpVerifiedAndLogIn(app, email ?? "", name ?? "");
      }
    });

    it("matches part of a display name, ignoring case", async () => {
      const body = (await search(mo, "?q=ann")).body as SearchBody;
      const names = body.items.map((u) => u.displayName).sort();

      expect(names).toEqual(["Anna", "Annika", "Joanna"]);
    });

    it("matches in the middle of a name, not only the start", async () => {
      const body = (await search(mo, "?q=oann")).body as SearchBody;

      expect(body.items.map((u) => u.displayName)).toEqual(["Joanna"]);
    });

    /**
     * One letter is not a search, it is a way of walking the table. `email` is
     * exact so it needs no floor; `q` matches partially, so this is the only
     * thing in the way.
     */
    it("refuses a single character", async () => {
      const response = await search(mo, "?q=a");

      expect(response.status).toBe(422);
      expect((response.body as ErrorBody).error.code).toBe("VALIDATION_FAILED");
    });

    it("does not match an email address through the name field", async () => {
      const body = (await search(mo, "?q=example.com")).body as SearchBody;

      expect(body.items).toEqual([]);
    });
  });

  describe("narrowing by status", () => {
    beforeEach(async () => {
      const banned = await signUpVerifiedAndLogIn(
        app,
        "bad@example.com",
        "Bad",
      );
      await prisma.user.update({
        where: { id: banned.id },
        data: { status: "BANNED" },
      });
      const gone = await signUpVerifiedAndLogIn(
        app,
        "gone@example.com",
        "Gone",
      );
      await prisma.user.update({
        where: { id: gone.id },
        data: { status: "DELETED" },
      });
    });

    it.each(["BANNED", "DELETED", "ACTIVE"])(
      "filters to %s accounts",
      async (status) => {
        const body = (await search(mo, `?status=${status}`)).body as SearchBody;

        expect(body.items.length).toBeGreaterThan(0);
        expect(body.items.every((u) => u.status === status)).toBe(true);
      },
    );

    /**
     * They answer 404 from every public endpoint (#65). This is the tool for
     * looking into what happened, and a moderator who cannot find a banned
     * account cannot check whether the ban was fair.
     */
    it("includes banned and deleted accounts when nothing is filtered", async () => {
      const body = (await search(mo, "?limit=50")).body as SearchBody;
      const statuses = new Set(body.items.map((u) => u.status));

      expect(statuses.has("BANNED")).toBe(true);
      expect(statuses.has("DELETED")).toBe(true);
    });

    it("refuses a status that is not one", async () => {
      const response = await search(mo, "?status=ASLEEP");

      expect(response.status).toBe(422);
    });

    it("combines a name and a status: both must match", async () => {
      const body = (await search(mo, "?q=ba&status=BANNED")).body as SearchBody;

      expect(body.items.map((u) => u.displayName)).toEqual(["Bad"]);
    });
  });

  describe("what a row says", () => {
    it("carries these nine fields and nothing else", async () => {
      const body = (await search(mo, "?email=anna@example.com"))
        .body as SearchBody;

      expect(Object.keys(body.items[0] ?? {}).sort()).toEqual([
        "countryCode",
        "createdAt",
        "displayName",
        "email",
        "emailVerified",
        "id",
        "role",
        "status",
        "suspendedUntil",
      ]);
    });

    /** The one place in the API that does this, deliberately. */
    it("does include the email address", async () => {
      const body = (await search(mo, "?email=anna@example.com"))
        .body as SearchBody;

      expect(body.items[0]?.email).toBe("anna@example.com");
    });

    it("never includes a password hash", async () => {
      const response = await search(mo, "?limit=50");

      expect(JSON.stringify(response.body)).not.toContain("$argon2");
      expect(JSON.stringify(response.body)).not.toContain("passwordHash");
    });

    it("says whether the email is confirmed, as a yes or no", async () => {
      const unverified = await signUpAndLogIn(app, "new@example.com");

      const confirmed = (await search(mo, "?email=anna@example.com"))
        .body as SearchBody;
      const not = (await search(mo, `?email=${unverified.email}`))
        .body as SearchBody;

      expect(confirmed.items[0]?.emailVerified).toBe(true);
      expect(not.items[0]?.emailVerified).toBe(false);
    });

    it("carries a suspension's end date", async () => {
      const until = new Date(Date.now() + 86_400_000);
      await prisma.user.update({
        where: { id: anna.id },
        data: { status: "SUSPENDED", suspendedUntil: until },
      });

      const body = (await search(mo, "?email=anna@example.com"))
        .body as SearchBody;

      expect(body.items[0]?.suspendedUntil).toBe(until.toISOString());
    });
  });

  describe("paging", () => {
    beforeEach(async () => {
      for (let i = 0; i < 4; i++) {
        await signUpVerifiedAndLogIn(
          app,
          `extra${String(i)}@example.com`,
          `Extra ${String(i)}`,
        );
      }
    });

    it("pages newest account first, with nothing repeated or skipped", async () => {
      const first = (await search(mo, "?limit=3")).body as SearchBody;
      expect(first.items).toHaveLength(3);
      expect(first.nextCursor).not.toBeNull();

      const second = (
        await search(mo, `?limit=3&cursor=${first.nextCursor ?? ""}`)
      ).body as SearchBody;

      const seen = [...first.items, ...second.items].map((u) => u.id);
      expect(new Set(seen).size).toBe(seen.length);

      const all = (await search(mo, "?limit=50")).body as SearchBody;
      expect(all.items.map((u) => u.id).slice(0, 6)).toEqual(seen.slice(0, 6));
    });

    it.each(["?limit=0", "?limit=51", "?cursor=nonsense"])(
      "refuses %s",
      async (query) => {
        const response = await search(mo, query);

        expect(response.status).toBe(422);
      },
    );
  });

  describe("what gets written down", () => {
    /**
     * Reading is not a decision, so no AdminAction — the application log, the
     * way a moderator opening a conversation is recorded (#27). The count is in
     * the line because one lookup and somebody paging through the whole table
     * look identical without it.
     */
    it("records a search by email", async () => {
      const written = vi.spyOn(logger, "info");

      await search(mo, "?email=anna@example.com");
      const lines = moderatorLines(written.mock.calls);
      written.mockRestore();

      expect(lines).toHaveLength(1);
      expect(lines[0]?.[0]).toMatchObject({
        moderatorId: mo.id,
        byEmail: true,
        resultCount: 1,
      });
    });

    it("records a search by name, with how many it found", async () => {
      const written = vi.spyOn(logger, "info");

      await search(mo, "?q=ann");
      const lines = moderatorLines(written.mock.calls);
      written.mockRestore();

      expect(lines[0]?.[0]).toMatchObject({
        moderatorId: mo.id,
        byEmail: false,
        resultCount: 1,
      });
    });

    it("records a search with no filters at all", async () => {
      const written = vi.spyOn(logger, "info");

      await search(mo);
      const lines = moderatorLines(written.mock.calls);
      written.mockRestore();

      expect(lines).toHaveLength(1);
    });
  });
});
