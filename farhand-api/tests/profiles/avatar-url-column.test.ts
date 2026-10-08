import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { prisma } from "../../src/db.js";
import {
  PASSWORD,
  signUpVerifiedAndLogIn,
  type TestUser,
} from "../helpers/auth.js";
import { solidImage } from "../helpers/images.js";

/**
 * `Profile.avatarUrl` is dead, and this proves the application never names it
 * (#103).
 *
 * It was in the schema from the first migration and **nothing ever wrote a
 * value to it** — no endpoint could, because the only way to set an avatar
 * arrived in #80 and sets `avatarFileId`. #80 then replaced it properly, and
 * left the column behind on purpose: migrations run before the new code is
 * live, so a column the old code still touches cannot be dropped in the same
 * release (docs/14-deployment.md).
 *
 * That left one line writing it, in `deleteMyAccount`, nulling a column that
 * was already null. This issue removes that line, and this file is why the
 * removal is safe to follow with a migration: if anything in the API mentions
 * the column again, this fails before the drop can break production.
 *
 * NOT to be confused with the `avatarUrl` **field in responses**, which is
 * alive, documented, and computed from `avatarFileId`. Same name, different
 * thing — which is the whole reason this issue needed reading twice. The tests
 * in avatar.test.ts and public-profile.test.ts are what hold that field in
 * place.
 */

const app = createApp();

/** The column, spelled the way Prisma quotes it in SQL. */
const COLUMN = '"avatarUrl"';

interface QueryEvent {
  query: string;
  params: string;
}

/**
 * Every statement the shared client sent while `run` was happening. The client
 * announces them while NODE_ENV is test (src/db.ts) — the same seam
 * tests/files/cost.test.ts counts statements with.
 */
async function statementsDuring(
  run: () => Promise<unknown>,
): Promise<string[]> {
  const seen: string[] = [];
  const client = prisma as unknown as {
    $on: (event: "query", listener: (event: QueryEvent) => void) => void;
  };

  client.$on("query", (event) => {
    seen.push(event.query);
  });

  await run();
  await new Promise((resolve) => setTimeout(resolve, 50));

  return seen;
}

let anna: TestUser;

beforeEach(async () => {
  anna = await signUpVerifiedAndLogIn(app, "anna@example.com", "Anna");
});

describe("nothing in the API names Profile.avatarUrl", () => {
  it("not when a profile is created, read or edited", async () => {
    const statements = await statementsDuring(async () => {
      // Registering writes a Profile row.
      const registered = await request(app)
        .post("/auth/register")
        .set("Origin", "http://localhost:3000")
        .send({
          email: "yuki@example.com",
          password: PASSWORD,
          displayName: "Yuki",
          countryCode: "JP",
        });
      expect(registered.status).toBe(201);

      // Reading one, as its owner and as a stranger.
      expect(
        (await request(app).get("/auth/me").set("Cookie", anna.cookie)).status,
      ).toBe(200);
      expect((await request(app).get(`/users/${anna.id}`)).status).toBe(200);

      // And editing one.
      const patched = await request(app)
        .patch("/me/profile")
        .set("Cookie", anna.cookie)
        .set("Origin", "http://localhost:3000")
        .send({ bio: "I fly Tallinn–Tokyo twice a year", city: "Tallinn" });
      expect(patched.status).toBe(200);
    });

    expect(statements.filter((sql) => sql.includes(COLUMN))).toEqual([]);
  });

  it("not when an avatar is set or removed", async () => {
    const statements = await statementsDuring(async () => {
      const bytes = await solidImage(256, 256);

      const set = await request(app)
        .put("/me/avatar")
        .set("Cookie", anna.cookie)
        .set("Origin", "http://localhost:3000")
        .set("Content-Type", "application/octet-stream")
        .send(bytes);
      expect(set.status).toBe(200);

      const removed = await request(app)
        .delete("/me/avatar")
        .set("Cookie", anna.cookie)
        .set("Origin", "http://localhost:3000");
      expect(removed.status).toBe(200);
    });

    expect(statements.filter((sql) => sql.includes(COLUMN))).toEqual([]);
  });

  it("not when an account is deleted, which is the line this issue removed", async () => {
    const statements = await statementsDuring(async () => {
      const gone = await request(app)
        .delete("/me")
        .set("Cookie", anna.cookie)
        .set("Origin", "http://localhost:3000")
        .send({ password: PASSWORD });
      expect(gone.status).toBe(204);
    });

    // This is the assertion that fails if `avatarUrl: null` comes back into
    // deleteMyAccount — and therefore the one that makes the migration in the
    // next release safe to apply.
    expect(statements.filter((sql) => sql.includes(COLUMN))).toEqual([]);
  });

  it("still answers with the avatarUrl FIELD, which is a different thing", async () => {
    // The guard against the obvious wrong fix: deleting the response field to
    // make the tests above pass. It is computed from avatarFileId, it is in
    // docs/06-api-contract.md, and it survives this issue untouched.
    const me = await request(app).get("/auth/me").set("Cookie", anna.cookie);
    const mine = await request(app).get(`/users/${anna.id}`);

    expect(me.status).toBe(200);
    expect(
      (me.body as { user: { profile: Record<string, unknown> } }).user.profile,
    ).toHaveProperty("avatarUrl");

    expect(mine.status).toBe(200);
    expect(
      (mine.body as { user: Record<string, unknown> }).user,
    ).toHaveProperty("avatarUrl");
  });
});
