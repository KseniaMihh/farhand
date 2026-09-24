import type { Need } from "@prisma/client";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { prisma } from "../../src/db.js";
import { MAX_PAGE_SIZE } from "../../src/services/shared.js";
import { signUpVerifiedAndLogIn } from "../helpers/auth.js";
import { createCategory } from "../helpers/needs.js";

/**
 * Browsing needs — issue #16.
 *
 * These tests are the specification. They fail until the TODOs in
 * src/services/needs.ts are filled in.
 *
 *   npm run test:watch -- browse
 */
const app = createApp();

let categoryId = "";
let otherCategoryId = "";
let requesterId = "";

beforeEach(async () => {
  categoryId = (await createCategory("electronics")).id;
  otherCategoryId = (await createCategory("cosmetics")).id;
  requesterId = (await signUpVerifiedAndLogIn(app, "anna@example.com")).id;
});

/**
 * Writes a need straight to the database.
 *
 * The endpoints are tested in #15; here the point is to control exactly what
 * is in the list — including its createdAt, which a request cannot set.
 */
async function makeNeed(overrides: Partial<Need> = {}) {
  return prisma.need.create({
    data: {
      requesterId,
      categoryId,
      title: "Japanese sunscreen",
      description: "The one not sold in Europe",
      buyCountry: "JP",
      deliverCountry: "EE",
      currency: "EUR",
      estimatedPrice: 2400,
      status: "OPEN",
      ...overrides,
    },
  });
}

interface PageBody {
  items: { id: string; title: string; status: string }[];
  nextCursor: string | null;
}

function browse(query: Record<string, string | number> = {}) {
  return request(app).get("/needs").query(query);
}

/** Walks every page and returns the ids in the order they were served. */
async function pageThrough(limit: number, onEachPage?: () => Promise<void>) {
  const seen: string[] = [];
  let cursor: string | null = null;

  for (let page = 0; page < 20; page++) {
    const query: Record<string, string | number> = { limit };
    if (cursor) query.cursor = cursor;
    const body = (await browse(query)).body as PageBody;

    seen.push(...body.items.map((item) => item.id));
    cursor = body.nextCursor;
    if (!cursor) break;
    if (onEachPage) await onEachPage();
  }

  return seen;
}

describe("GET /needs — what is visible", () => {
  it("lists open needs to anyone, logged in or not", async () => {
    await makeNeed({ title: "Visible" });

    const response = await browse();
    const body = response.body as PageBody;

    expect(response.status).toBe(200);
    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.title).toBe("Visible");
  });

  it("hides drafts, closed, expired and matched needs", async () => {
    await makeNeed({ status: "OPEN", title: "Open" });
    await makeNeed({ status: "DRAFT", title: "Draft" });
    await makeNeed({ status: "CLOSED", title: "Closed" });
    await makeNeed({ status: "EXPIRED", title: "Expired" });
    await makeNeed({ status: "MATCHED", title: "Matched" });
    await makeNeed({ status: "REMOVED", title: "Removed" });

    const body = (await browse()).body as PageBody;

    expect(body.items.map((item) => item.title)).toEqual(["Open"]);
  });

  it("puts the newest first", async () => {
    const older = await makeNeed({
      title: "Older",
      createdAt: new Date("2026-09-01T10:00:00Z"),
    });
    const newer = await makeNeed({
      title: "Newer",
      createdAt: new Date("2026-09-02T10:00:00Z"),
    });

    const body = (await browse()).body as PageBody;

    expect(body.items.map((item) => item.id)).toEqual([newer.id, older.id]);
  });
});

describe("GET /needs — filters", () => {
  it("narrows by the country the product must be bought in", async () => {
    await makeNeed({ buyCountry: "JP", title: "From Japan" });
    await makeNeed({ buyCountry: "US", title: "From the States" });

    const body = (await browse({ buyCountry: "JP" })).body as PageBody;

    expect(body.items.map((item) => item.title)).toEqual(["From Japan"]);
  });

  it("narrows by the country it must be delivered to", async () => {
    await makeNeed({ deliverCountry: "EE", title: "To Estonia" });
    await makeNeed({ deliverCountry: "FI", title: "To Finland" });

    const body = (await browse({ deliverCountry: "ee" })).body as PageBody;

    // Typed in lower case, matched all the same.
    expect(body.items.map((item) => item.title)).toEqual(["To Estonia"]);
  });

  it("narrows by category", async () => {
    await makeNeed({ categoryId, title: "Electronics one" });
    await makeNeed({ categoryId: otherCategoryId, title: "Cosmetics one" });

    const body = (await browse({ categoryId: otherCategoryId }))
      .body as PageBody;

    expect(body.items.map((item) => item.title)).toEqual(["Cosmetics one"]);
  });

  it("searches the title and the description, ignoring case", async () => {
    await makeNeed({ title: "Kindle Paperwhite", description: "any colour" });
    await makeNeed({ title: "Sunscreen", description: "A Kindle case too" });
    await makeNeed({ title: "Coffee beans", description: "dark roast" });

    const body = (await browse({ q: "kindle" })).body as PageBody;

    expect(body.items.map((item) => item.title).sort()).toEqual([
      "Kindle Paperwhite",
      "Sunscreen",
    ]);
  });

  it("combines filters, and finds nothing when they do not overlap", async () => {
    await makeNeed({ buyCountry: "JP", categoryId, title: "Japanese gadget" });

    const both = (await browse({ buyCountry: "JP", categoryId }))
      .body as PageBody;
    const neither = (await browse({ buyCountry: "US", categoryId }))
      .body as PageBody;

    expect(both.items).toHaveLength(1);
    expect(neither.items).toHaveLength(0);
    expect(neither.nextCursor).toBeNull();
  });

  it("treats an absent filter as no filter", async () => {
    await makeNeed({ buyCountry: "JP" });
    await makeNeed({ buyCountry: "US" });

    const body = (await browse()).body as PageBody;

    expect(body.items).toHaveLength(2);
  });
});

describe("GET /needs — paging", () => {
  it("returns a page and a cursor, then the rest", async () => {
    for (let i = 0; i < 5; i++) await makeNeed({ title: `Need ${String(i)}` });

    const first = (await browse({ limit: 2 })).body as PageBody;
    const second = (await browse({ limit: 2, cursor: first.nextCursor ?? "" }))
      .body as PageBody;

    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).toBeTruthy();
    expect(second.items).toHaveLength(2);
    // No overlap between the pages.
    const firstIds = first.items.map((item) => item.id);
    expect(second.items.some((item) => firstIds.includes(item.id))).toBe(false);
  });

  it("says there is no next page at the end", async () => {
    await makeNeed();
    await makeNeed();

    const body = (await browse({ limit: 5 })).body as PageBody;

    expect(body.items).toHaveLength(2);
    expect(body.nextCursor).toBeNull();
  });

  it("walks the whole list exactly once", async () => {
    const made: string[] = [];
    for (let i = 0; i < 25; i++) made.push((await makeNeed()).id);

    const seen = await pageThrough(10);

    expect(seen).toHaveLength(25);
    expect(new Set(seen).size).toBe(25);
    expect([...seen].sort()).toEqual([...made].sort());
  });

  it("keeps needs created in the same instant in a stable order", async () => {
    // The tie case the cursor's second value exists for: sorting by createdAt
    // alone leaves these six in no defined order, so a row could be served
    // twice or skipped.
    const sameMoment = new Date("2026-09-20T12:00:00Z");
    const made: string[] = [];
    for (let i = 0; i < 6; i++) {
      made.push((await makeNeed({ createdAt: sameMoment })).id);
    }

    const seen = await pageThrough(2);

    expect(seen).toHaveLength(6);
    expect(new Set(seen).size).toBe(6);
    expect([...seen].sort()).toEqual([...made].sort());
  });

  /**
   * The test issue #16 asks for by name.
   *
   * Someone posts a need while you are on page two. With counting pagination
   * ("skip 20, take 20") every later page slides along by one, so a need you
   * already saw comes round again and one you have not seen is skipped. A
   * cursor pins the position to a row, so inserts elsewhere cannot move it.
   */
  it("shows no duplicates and skips nothing when needs are posted mid-paging", async () => {
    const original: string[] = [];
    for (let i = 0; i < 12; i++) {
      original.push((await makeNeed({ title: `Original ${String(i)}` })).id);
    }

    // A new need appears between every page — always at the top, since it is
    // the newest.
    const seen = await pageThrough(4, async () => {
      await makeNeed({ title: "Posted while you were reading" });
    });

    // Nothing served twice.
    expect(new Set(seen).size).toBe(seen.length);
    // Every need that existed when paging started was served exactly once.
    for (const id of original) {
      expect(seen.filter((servedId) => servedId === id)).toHaveLength(1);
    }
  });

  it("refuses a cursor it did not issue", async () => {
    await makeNeed();

    const response = await browse({ cursor: "not-a-real-cursor" });

    expect(response.status).toBe(422);
  });

  it("refuses a page size beyond the maximum", async () => {
    const response = await browse({ limit: MAX_PAGE_SIZE + 1 });

    expect(response.status).toBe(422);
  });
});

describe("GET /needs/:id — one need", () => {
  it("shows an open need to a stranger", async () => {
    const need = await makeNeed();

    const response = await request(app).get(`/needs/${need.id}`);

    expect(response.status).toBe(200);
    expect((response.body as { need: { id: string } }).need.id).toBe(need.id);
  });

  it("shows a matched need, because a deal is running on it", async () => {
    const need = await makeNeed({ status: "MATCHED" });

    const response = await request(app).get(`/needs/${need.id}`);

    expect(response.status).toBe(200);
  });

  it("hides a draft from a stranger, as if it did not exist", async () => {
    const need = await makeNeed({ status: "DRAFT" });

    const response = await request(app).get(`/needs/${need.id}`);

    // 404, not 403: an unpublished draft should not be discoverable by
    // trying ids.
    expect(response.status).toBe(404);
  });

  it("hides a closed need from a stranger", async () => {
    const need = await makeNeed({ status: "CLOSED" });

    const response = await request(app).get(`/needs/${need.id}`);

    expect(response.status).toBe(404);
  });

  it("shows the owner their own draft", async () => {
    const owner = await prisma.user.findUniqueOrThrow({
      where: { id: requesterId },
    });
    const anna = await request(app)
      .post("/auth/login")
      .send({ email: owner.email, password: "a decent long passphrase" });
    const cookie = (anna.headers["set-cookie"] as unknown as string[])[0] ?? "";
    const need = await makeNeed({ status: "DRAFT" });

    const response = await request(app)
      .get(`/needs/${need.id}`)
      .set("Cookie", cookie);

    expect(response.status).toBe(200);
  });

  it("answers 404 for a need that never existed", async () => {
    const response = await request(app).get("/needs/no-such-need");

    expect(response.status).toBe(404);
  });
});

describe("GET /me/needs — my own list", () => {
  it("requires being logged in", async () => {
    const response = await request(app).get("/me/needs");

    expect(response.status).toBe(401);
  });

  it("shows my drafts and closed needs, which the public list hides", async () => {
    const anna = await signUpVerifiedAndLogIn(app, "own@example.com", "Owner");
    requesterId = anna.id;
    await makeNeed({ status: "DRAFT", title: "My draft" });
    await makeNeed({ status: "CLOSED", title: "My closed one" });
    await makeNeed({ status: "OPEN", title: "My open one" });

    const response = await request(app)
      .get("/me/needs")
      .set("Cookie", anna.cookie);
    const body = response.body as PageBody;

    expect(response.status).toBe(200);
    expect(body.items.map((item) => item.title).sort()).toEqual([
      "My closed one",
      "My draft",
      "My open one",
    ]);
  });

  it("shows nobody else's needs", async () => {
    await makeNeed({ title: "Anna's need" });
    const bob = await signUpVerifiedAndLogIn(app, "bob@example.com", "Bob");

    const body = (await request(app).get("/me/needs").set("Cookie", bob.cookie))
      .body as PageBody;

    expect(body.items).toHaveLength(0);
  });

  it("pages the same way as the public list", async () => {
    const anna = await signUpVerifiedAndLogIn(app, "mine@example.com", "Mine");
    requesterId = anna.id;
    for (let i = 0; i < 5; i++) await makeNeed({ status: "DRAFT" });

    const first = (
      await request(app)
        .get("/me/needs")
        .query({ limit: 2 })
        .set("Cookie", anna.cookie)
    ).body as PageBody;

    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).toBeTruthy();
  });
});
