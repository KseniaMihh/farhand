import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { prisma } from "../../src/db.js";
import { signUpVerifiedAndLogIn } from "../helpers/auth.js";
import { createCategory } from "../helpers/needs.js";

/**
 * Listing the categories — issue #159.
 *
 * These tests are the specification. They fail until the TODOs in
 * src/services/categories.ts and src/routes/categories.ts are filled in.
 *
 *   npm run test:watch -- categories
 *
 * The endpoint itself is three lines. What is worth pinning is everything
 * around it: that it needs no session, that it answers an unseeded database
 * with a list rather than a failure, that it says it may be cached and says
 * so PUBLICLY for the first time in this API, and that the shape it returns
 * is the one an offer has carried since #17 rather than a second one that
 * will drift.
 */
const app = createApp();

/** What the endpoint promises, so the assertions below are type-checked too. */
interface CategoriesBody {
  categories: { id: string; slug: string; name: string }[];
  nextCursor?: unknown;
}

beforeEach(async () => {
  await prisma.category.deleteMany({});
});

describe("who may read it", () => {
  /**
   * A category picker is on the screens somebody fills in before they have
   * posted anything, and the browse filters are public outright. Requiring a
   * session would mean a signed-out visitor could not be shown what Farhand
   * is for.
   */
  it("answers a visitor with no session at all", async () => {
    await createCategory("electronics");

    const response = await request(app).get("/categories");

    expect(response.status).toBe(200);
  });

  it("answers a signed-in caller the same thing", async () => {
    await createCategory("electronics");
    const kadri = await signUpVerifiedAndLogIn(
      app,
      "kadri@example.com",
      "Kadri",
    );

    const signedOut = await request(app).get("/categories");
    const signedIn = await request(app)
      .get("/categories")
      .set("Cookie", kadri.cookie);

    expect(signedIn.status).toBe(200);
    expect(signedIn.body).toEqual(signedOut.body);
  });
});

describe("what comes back", () => {
  /**
   * The same three fields an offer carries. `src/services/helps.ts` has
   * returned `{ id, slug, name }` inside every offer since #17, and a second
   * spelling of a category is how one of them grows a field the other does
   * not.
   */
  it("gives each category its id, its slug and its name", async () => {
    await createCategory("electronics");

    const response = await request(app).get("/categories");
    const [first] = (response.body as CategoriesBody).categories;

    expect(first).toBeDefined();
    expect(Object.keys(first ?? {}).sort()).toEqual(["id", "name", "slug"]);
    expect(first?.slug).toBe("electronics");
  });

  /** Named, never a bare array — every other reply in this API is an object. */
  it("wraps the list in a named object", async () => {
    await createCategory("electronics");

    const response = await request(app).get("/categories");

    expect(Array.isArray(response.body)).toBe(false);
    expect(Array.isArray((response.body as CategoriesBody).categories)).toBe(
      true,
    );
  });

  it("gives every category, not a page of them", async () => {
    for (const slug of ["electronics", "books", "cosmetics", "snacks"]) {
      await createCategory(slug);
    }

    const response = await request(app).get("/categories");

    const body = response.body as CategoriesBody;

    expect(body.categories).toHaveLength(4);
    // No cursor, no `nextCursor`: the whole thing is the answer, so there is
    // nothing to continue from.
    expect(body.nextCursor).toBeUndefined();
  });

  /**
   * By name rather than by slug. The two are close enough to look
   * interchangeable — "beauty-care" and "Beauty & care" — and a slug sorts on
   * its punctuation, which is not a thing a reader can see.
   */
  it("sorts by the name a person reads", async () => {
    await createCategory("snacks");
    await createCategory("books");
    await createCategory("electronics");

    const response = await request(app).get("/categories");
    const names = (response.body as CategoriesBody).categories.map(
      (category) => category.name,
    );

    expect(names).toEqual([...names].sort());
    expect(names[0]).toBe("Books");
  });

  /**
   * A database nobody has seeded is a deployment that is not finished. The
   * shape of the answer should not be the thing that says so — a client that
   * works with eleven categories should not crash with none.
   */
  it("answers an empty table with an empty list, not a failure", async () => {
    const response = await request(app).get("/categories");

    expect(response.status).toBe(200);
    expect((response.body as CategoriesBody).categories).toEqual([]);
  });
});

/**
 * THE FIRST PUBLIC CACHE HEADER THIS API SETS. `files.ts` already sends
 * `private, max-age=…` on the image redirect, so the mechanism is not new —
 * but `private` means "this answer was for one caller", and this one is the
 * same for everybody. `public` is a genuinely different promise: a shared
 * cache may keep it and hand it to somebody else.
 */
describe("what it says about caching", () => {
  it("says it may be cached, publicly, for an hour", async () => {
    await createCategory("electronics");

    const response = await request(app).get("/categories");

    expect(response.headers["cache-control"]).toBe("public, max-age=3600");
  });

  /**
   * The reason an hour is safe: nothing here is about the caller. The day
   * this endpoint learns to say something per-caller — a count of a user's
   * own needs, a hidden category — `public` becomes a leak rather than an
   * optimisation, and this test is where that gets noticed.
   */
  it("gives two different callers byte-for-byte the same answer", async () => {
    await createCategory("electronics");
    const kadri = await signUpVerifiedAndLogIn(
      app,
      "kadri@example.com",
      "Kadri",
    );
    const yuki = await signUpVerifiedAndLogIn(app, "yuki@example.com", "Yuki");

    const first = await request(app)
      .get("/categories")
      .set("Cookie", kadri.cookie);
    const second = await request(app)
      .get("/categories")
      .set("Cookie", yuki.cookie);

    expect(JSON.stringify(first.body)).toBe(JSON.stringify(second.body));
  });
});
