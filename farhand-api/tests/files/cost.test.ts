import type { Need } from "@prisma/client";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { prisma } from "../../src/db.js";
import { env } from "../../src/env.js";
import { RATE_LIMITS } from "../../src/middleware/rate-limit.js";
import { READ_URL_SECONDS, REDIRECT_CACHE_SECONDS } from "../../src/storage.js";
import { signUpVerifiedAndLogIn, type TestUser } from "../helpers/auth.js";
import { fileFixture } from "../helpers/files.js";
import { createCategory, createDealFor } from "../helpers/needs.js";

/**
 * What showing a page of images costs (#102).
 *
 * Reading one file is cheap. A page is not one file: #81 puts photos on a
 * need and #93 builds the page that lists them, so the realistic unit is
 * thirty images at once, thirty times over as somebody browses. This file
 * pins the three things that made that expensive, each of which was found by
 * measuring rather than by reading the code:
 *
 *   1. four database round trips per image, three of them for rows the
 *      visibility rule was never going to read
 *   2. `/files/:id` inside a budget written for a person clicking links, so
 *      the TENTH view of a thirty-photo page answered 429
 *   3. `no-store`, so one avatar on twenty cards was twenty requests
 *
 * The numbers here are the specification, not a benchmark: they fail if the
 * endpoint goes back to loading relations it does not need, or back inside
 * the global budget.
 */

const app = createApp();

/** A page of this many photos — #81's need page, at the top of its range. */
const PHOTOS = 30;

/** A fresh address per test, so budgets never overlap. */
let addressCounter = 0;
function nextIp(): string {
  addressCounter += 1;
  // 198.51.100.x is a documentation range: it can never be a real client.
  return `198.51.100.${String(addressCounter)}`;
}

interface QueryEvent {
  query: string;
  params: string;
}

/**
 * The statements the shared client sent while `run` was happening.
 *
 * The client announces them while NODE_ENV is test (src/db.ts), which is the
 * same seam tests/helps/browse.test.ts uses to EXPLAIN the browse query. The
 * `$on` type only exists when query logging is on — hence the cast.
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
  // The event is emitted after the query resolves, so give it a tick to land.
  await new Promise((resolve) => setTimeout(resolve, 50));

  return seen;
}

/** Which tables were SELECTed, in order, once each. */
function tablesRead(statements: string[]): string[] {
  const tables: string[] = [];
  for (const sql of statements) {
    if (!sql.includes("SELECT")) continue;
    const match = /FROM "public"\."(\w+)"/.exec(sql);
    if (match?.[1] && !tables.includes(match[1])) tables.push(match[1]);
  }
  return tables;
}

let kadri: TestUser;
let need: Need;
let avatarId: string;
let photoIds: string[];
let onePhotoId: string;
let orphanPhotoId: string;
let orphanReceiptId: string;

afterEach(() => {
  env.RATE_LIMIT_ENABLED = false;
});

beforeEach(async () => {
  kadri = await signUpVerifiedAndLogIn(app, "kadri@example.com", "Kadri");

  const category = await createCategory("sunscreen");
  need = await prisma.need.create({
    data: {
      requesterId: kadri.id,
      categoryId: category.id,
      title: "Japanese sunscreen",
      description: "The one not sold in Europe",
      buyCountry: "JP",
      deliverCountry: "EE",
      currency: "EUR",
      estimatedPrice: 2400,
      status: "OPEN",
    },
  });

  avatarId = (await fileFixture({ ownerId: kadri.id, purpose: "AVATAR" })).id;

  photoIds = [];
  for (let i = 0; i < PHOTOS; i++) {
    const photo = await fileFixture({
      ownerId: kadri.id,
      purpose: "NEED_PHOTO",
      needId: need.id,
    });
    photoIds.push(photo.id);
  }

  const [first] = photoIds;
  if (!first) throw new Error("no photo fixtures were created");
  onePhotoId = first;

  // A photo attached to no need, and a receipt attached to no deal. Neither is
  // reachable through an endpoint — the uploads in #81 and #82 always know
  // what they belong to — but both columns are nullable, so the rule has to
  // answer for them, and it can do so without asking the database anything.
  orphanPhotoId = (
    await fileFixture({ ownerId: kadri.id, purpose: "NEED_PHOTO" })
  ).id;

  orphanReceiptId = (
    await fileFixture({ ownerId: kadri.id, purpose: "PRODUCT_RECEIPT" })
  ).id;
});

/** Signed out, so `optionalAuth` adds no statements of its own. */
function get(fileId: string) {
  return request(app).get(`/files/${fileId}`);
}

describe("the statements one image view makes", () => {
  it("reads a need photo and its need, and neither the owner nor a deal", async () => {
    const statements = await statementsDuring(async () => {
      const response = await get(onePhotoId);
      expect(response.status).toBe(302);
    });

    expect(tablesRead(statements)).toEqual(["File", "Need"]);
  });

  it("reads an avatar and its owner, and neither a need nor a deal", async () => {
    const statements = await statementsDuring(async () => {
      const response = await get(avatarId);
      expect(response.status).toBe(302);
    });

    expect(tablesRead(statements)).toEqual(["File", "User"]);
  });

  it("refuses a photo belonging to no need without a second statement", async () => {
    const statements = await statementsDuring(async () => {
      const response = await get(orphanPhotoId);
      expect(response.status).toBe(404);
    });

    // There is nothing to ask: a photo with no need is nobody's. The guard
    // that makes this one statement rather than two is the only observable
    // difference it makes, so this test is what holds it in place.
    expect(tablesRead(statements)).toEqual(["File"]);
  });

  it("refuses a receipt belonging to no deal without a second statement", async () => {
    const statements = await statementsDuring(async () => {
      const response = await get(orphanReceiptId);
      expect(response.status).toBe(404);
    });

    // There is nothing to ask: a receipt with no deal is nobody's.
    expect(tablesRead(statements)).toEqual(["File"]);
  });

  it("costs one page of photos one statement each, not four", async () => {
    const statements = await statementsDuring(async () => {
      for (const id of photoIds) {
        expect((await get(id)).status).toBe(302);
      }
    });

    const selects = statements.filter((sql) => sql.includes("SELECT"));

    // Two per image: the row, then the one relation that decides it. Before
    // #102 this was four — File, User, Need and Deal, every time.
    expect(selects.length).toBe(PHOTOS * 2);
  });
});

describe("the budget a page of images spends", () => {
  beforeEach(() => {
    env.RATE_LIMIT_ENABLED = true;
  });

  it("does not come out of the budget for browsing", async () => {
    const ip = nextIp();

    // Spend the whole global ceiling on something that is not a file. /health
    // touches no database, so this is the cheapest way to fill the bucket.
    let lastHealth = 0;
    for (let i = 0; i <= RATE_LIMITS.global.perIp; i++) {
      lastHealth = (
        await request(app).get("/health").set("X-Forwarded-For", ip)
      ).status;
    }

    // Half of the assertion, and the half that fails if the exemption was
    // built by switching the global limiter off instead of stepping around
    // one path: the ceiling must still be a ceiling.
    expect(lastHealth).toBe(429);

    // The other half: with that budget spent, images still load.
    const image = await get(onePhotoId).set("X-Forwarded-For", ip);
    expect(image.status).toBe(302);

    // And by the spelling Express also routes. Routing is case-insensitive by
    // default, so `/FILES/…` reaches the same handler; a predicate that did
    // not agree with the router would leave this one request counted against
    // the budget that has just been spent, and answer 429 instead.
    const shouting = await request(app)
      .get(`/FILES/${onePhotoId}`)
      .set("X-Forwarded-For", ip);
    expect(shouting.status).toBe(302);
  });

  it("has a ceiling of its own, and it is the bigger one", async () => {
    const ip = nextIp();

    // An id that does not exist: the limiter runs before the handler, so this
    // counts the same as a real image and costs one statement instead of two.
    let refusedAt = 0;
    for (let i = 1; i <= RATE_LIMITS.file.perIp + 1; i++) {
      const status = (
        await request(app)
          .get("/files/cm0doesnotexist000000000")
          .set("X-Forwarded-For", ip)
      ).status;
      if (status === 429) {
        refusedAt = i;
        break;
      }
      expect(status).toBe(404);
    }

    // Not merely "a 429 eventually". It has to arrive at the file budget and
    // not at the global one — if `/files/:id` were still counted globally,
    // this would refuse at 301.
    expect(refusedAt).toBe(RATE_LIMITS.file.perIp + 1);
    expect(refusedAt).toBeGreaterThan(RATE_LIMITS.global.perIp);
  });

  it("is a budget worth having, measured in page views", () => {
    // Everything above is relative to whatever `RATE_LIMITS.file.perIp` says,
    // so setting it back to the global 300 passes all of it: 301 is still
    // "one more than the configured limit", and 301 is still greater than
    // 300. Found by exactly that broken variant.
    //
    // The unit that matters is page views, not requests. Before #102 a
    // visitor got ten views of a thirty-image page a minute and then a 429 on
    // their own photos; a budget that does not clear that by a wide margin
    // has not fixed anything.
    const pageViews = Math.floor(RATE_LIMITS.file.perIp / PHOTOS);
    const before = Math.floor(RATE_LIMITS.global.perIp / PHOTOS);

    expect(pageViews).toBeGreaterThanOrEqual(20);
    expect(pageViews).toBeGreaterThanOrEqual(before * 2);
  });
});

describe("the redirect the browser may keep", () => {
  it("may be cached for less than half the life of the signature inside it", () => {
    // The invariant, not the number: a cached redirect is followed while its
    // own signature is still valid, with at least as long again to spare for
    // actually fetching the bytes.
    expect(REDIRECT_CACHE_SECONDS * 2).toBeLessThanOrEqual(READ_URL_SECONDS);
  });

  it("tells the browser so, privately", async () => {
    const response = await get(avatarId);

    expect(response.headers["cache-control"]).toBe(
      `private, max-age=${String(REDIRECT_CACHE_SECONDS)}`,
    );
  });

  it("is still a fresh signature when the browser does ask again", async () => {
    // Nothing above makes the redirect reusable BEYOND its cache window: the
    // API signs again on every request it actually receives.
    const first = await get(avatarId);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const second = await get(avatarId);

    expect(second.headers.location).not.toBe(first.headers.location);
  });
});

describe("a receipt still needs its deal", () => {
  // The query change moved the receipt rule behind a `dealId` check, so the
  // real rule gets its own test here as well as in read.test.ts: the point is
  // that skipping the query must not skip the permission.
  it("is visible to the two people in the deal and nobody else", async () => {
    const yuki = await signUpVerifiedAndLogIn(app, "yuki@example.com", "Yuki");
    const stranger = await signUpVerifiedAndLogIn(app, "s@example.com", "Sam");
    const deal = await createDealFor(need, yuki.id);
    const receipt = await fileFixture({
      ownerId: yuki.id,
      purpose: "PRODUCT_RECEIPT",
      dealId: deal.id,
    });

    expect((await get(receipt.id).set("Cookie", kadri.cookie)).status).toBe(
      302,
    );
    expect((await get(receipt.id).set("Cookie", yuki.cookie)).status).toBe(302);
    expect((await get(receipt.id).set("Cookie", stranger.cookie)).status).toBe(
      404,
    );
    expect((await get(receipt.id)).status).toBe(404);
  });
});
