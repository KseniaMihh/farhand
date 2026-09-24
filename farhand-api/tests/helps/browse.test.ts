import type { Help } from "@prisma/client";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { prisma } from "../../src/db.js";
import { MAX_PAGE_SIZE } from "../../src/services/shared.js";
import { signUpVerifiedAndLogIn } from "../helpers/auth.js";
import { createCategory } from "../helpers/needs.js";

/**
 * Browsing helps — issue #18.
 *
 * These tests are the specification. They fail until the TODOs in
 * src/services/helps.ts are filled in.
 *
 *   npm run test:watch -- helps/browse
 */
const app = createApp();

let electronics = "";
let cosmetics = "";
let helperId = "";

beforeEach(async () => {
  electronics = (await createCategory("electronics")).id;
  cosmetics = (await createCategory("cosmetics")).id;
  helperId = (await signUpVerifiedAndLogIn(app, "yuki@example.com", "Yuki")).id;
});

/** Writes an offer straight to the database, so its createdAt can be set. */
async function makeHelp(
  overrides: Partial<Help> & { categoryIds?: string[] } = {},
) {
  const { categoryIds = [electronics], ...fields } = overrides;

  return prisma.help.create({
    data: {
      helperId,
      country: "JP",
      shipsTo: ["EE", "FI"],
      description: "I post to the Baltics every other week.",
      status: "ACTIVE",
      ...fields,
      categories: { connect: categoryIds.map((id) => ({ id })) },
    },
  });
}

interface PageBody {
  items: { id: string; description: string; shipsTo: string[] }[];
  nextCursor: string | null;
}

function browse(query: Record<string, string | number> = {}) {
  return request(app).get("/helps").query(query);
}

describe("GET /helps — what is visible", () => {
  it("lists active offers to anyone, logged in or not", async () => {
    await makeHelp({ description: "Visible" });

    const response = await browse();
    const body = response.body as PageBody;

    expect(response.status).toBe(200);
    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.description).toBe("Visible");
  });

  it("hides paused and removed offers", async () => {
    await makeHelp({ status: "ACTIVE", description: "Active" });
    await makeHelp({ status: "PAUSED", description: "Paused" });
    await makeHelp({ status: "REMOVED", description: "Removed" });

    const body = (await browse()).body as PageBody;

    expect(body.items.map((item) => item.description)).toEqual(["Active"]);
  });

  it("puts the newest first", async () => {
    const older = await makeHelp({
      createdAt: new Date("2026-09-01T10:00:00Z"),
    });
    const newer = await makeHelp({
      createdAt: new Date("2026-09-02T10:00:00Z"),
    });

    const body = (await browse()).body as PageBody;

    expect(body.items.map((item) => item.id)).toEqual([newer.id, older.id]);
  });
});

describe("GET /helps — filters", () => {
  it("narrows by where the helper is", async () => {
    await makeHelp({ country: "JP", description: "In Japan" });
    await makeHelp({ country: "US", description: "In the States" });

    const body = (await browse({ country: "jp" })).body as PageBody;

    expect(body.items.map((item) => item.description)).toEqual(["In Japan"]);
  });

  it("narrows by category, matching any one of an offer's categories", async () => {
    await makeHelp({
      categoryIds: [electronics, cosmetics],
      description: "Both",
    });
    await makeHelp({ categoryIds: [electronics], description: "Electronics" });

    const body = (await browse({ categoryId: cosmetics })).body as PageBody;

    // A help has many categories; matching one of them is enough.
    expect(body.items.map((item) => item.description)).toEqual(["Both"]);
  });

  it("finds the offers that list the country asked for", async () => {
    await makeHelp({ shipsTo: ["EE", "FI"], description: "Ships to EE" });
    await makeHelp({ shipsTo: ["US"], description: "Ships to the States" });

    const body = (await browse({ shipsTo: "EE" })).body as PageBody;

    expect(body.items.map((item) => item.description)).toEqual(["Ships to EE"]);
  });

  /**
   * The rule the whole issue turns on. An empty shipsTo means the helper posts
   * anywhere, so they must appear in every search — miss this and the most
   * useful helpers are invisible in every result.
   */
  it("also finds the offers that ship anywhere", async () => {
    await makeHelp({ shipsTo: [], description: "Anywhere" });
    await makeHelp({ shipsTo: ["EE"], description: "Only EE" });
    await makeHelp({ shipsTo: ["US"], description: "Only US" });

    const body = (await browse({ shipsTo: "EE" })).body as PageBody;

    expect(body.items.map((item) => item.description).sort()).toEqual([
      "Anywhere",
      "Only EE",
    ]);
  });

  it("shows everything when no country is asked for", async () => {
    await makeHelp({ shipsTo: [] });
    await makeHelp({ shipsTo: ["US"] });

    const body = (await browse()).body as PageBody;

    expect(body.items).toHaveLength(2);
  });

  it("combines filters", async () => {
    await makeHelp({
      country: "JP",
      shipsTo: ["EE"],
      categoryIds: [electronics],
      description: "Matches",
    });
    await makeHelp({
      country: "US",
      shipsTo: ["EE"],
      categoryIds: [electronics],
      description: "Wrong country",
    });

    const body = (
      await browse({ country: "JP", shipsTo: "EE", categoryId: electronics })
    ).body as PageBody;

    expect(body.items.map((item) => item.description)).toEqual(["Matches"]);
  });
});

describe("GET /helps — paging", () => {
  /** Walks every page and returns the ids in the order they were served. */
  async function pageThrough(
    limit: number,
    query: Record<string, string> = {},
  ) {
    const seen: string[] = [];
    let cursor: string | null = null;

    for (let page = 0; page < 20; page++) {
      const body = (
        await browse({ ...query, limit, ...(cursor ? { cursor } : {}) })
      ).body as PageBody;
      seen.push(...body.items.map((item) => item.id));
      cursor = body.nextCursor;
      if (!cursor) break;
    }

    return seen;
  }

  it("walks the whole list exactly once", async () => {
    const made: string[] = [];
    for (let i = 0; i < 12; i++) made.push((await makeHelp()).id);

    const seen = await pageThrough(5);

    expect(seen).toHaveLength(12);
    expect(new Set(seen).size).toBe(12);
    expect([...seen].sort()).toEqual([...made].sort());
  });

  it("keeps offers created in the same instant in a stable order", async () => {
    const sameMoment = new Date("2026-09-20T12:00:00Z");
    const made: string[] = [];
    for (let i = 0; i < 6; i++) {
      made.push((await makeHelp({ createdAt: sameMoment })).id);
    }

    const seen = await pageThrough(2);

    expect(new Set(seen).size).toBe(6);
    expect([...seen].sort()).toEqual([...made].sort());
  });

  it("keeps the filter while paging", async () => {
    for (let i = 0; i < 6; i++) await makeHelp({ shipsTo: ["EE"] });
    for (let i = 0; i < 6; i++) await makeHelp({ shipsTo: ["US"] });

    const seen = await pageThrough(2, { shipsTo: "EE" });

    // The cursor condition and the shipsTo condition both use OR; combined
    // carelessly, one replaces the other and this comes back as 12.
    expect(seen).toHaveLength(6);
  });

  it("says there is no next page at the end", async () => {
    await makeHelp();

    const body = (await browse({ limit: 5 })).body as PageBody;

    expect(body.nextCursor).toBeNull();
  });

  it("refuses a cursor it did not issue, and a page size beyond the maximum", async () => {
    expect((await browse({ cursor: "not-a-real-cursor" })).status).toBe(422);
    expect((await browse({ limit: MAX_PAGE_SIZE + 1 })).status).toBe(422);
  });
});

describe("GET /helps/:id — one offer", () => {
  it("shows an active offer to a stranger", async () => {
    const help = await makeHelp();

    const response = await request(app).get(`/helps/${help.id}`);

    expect(response.status).toBe(200);
    expect((response.body as { help: { id: string } }).help.id).toBe(help.id);
  });

  it("hides a paused offer from a stranger", async () => {
    const help = await makeHelp({ status: "PAUSED" });

    const response = await request(app).get(`/helps/${help.id}`);

    expect(response.status).toBe(404);
  });

  it("shows the helper their own paused offer, so they can restart it", async () => {
    const yuki = await signUpVerifiedAndLogIn(app, "own@example.com", "Own");
    helperId = yuki.id;
    const help = await makeHelp({ status: "PAUSED" });

    const response = await request(app)
      .get(`/helps/${help.id}`)
      .set("Cookie", yuki.cookie);

    expect(response.status).toBe(200);
  });

  it("answers 404 for an offer that never existed", async () => {
    const response = await request(app).get("/helps/no-such-help");

    expect(response.status).toBe(404);
  });
});

/**
 * The acceptance criterion: "GIN index actually used, verified with EXPLAIN".
 *
 * Two different questions, both worth asking:
 *
 *   1. Does the browse endpoint ask the database something a GIN index can
 *      answer? The index covers the containment operator `@>`; a filter
 *      written any other way would never touch it, however well the index is
 *      built.
 *
 *   2. Can the planner use the index for exactly that query?
 *
 * The SQL is taken from a real request rather than written here by hand — a
 * hand-written query would only prove something about the query we wrote. The
 * shared client announces its statements while NODE_ENV is test (see
 * src/db.ts), so the test listens, makes the request, and explains what it
 * heard.
 *
 * The second question needs one trick. With a handful of test rows Postgres
 * correctly decides a sequential scan is cheaper and ignores every index, so
 * asking "did it use the index" would only measure how small the table is.
 * Turning sequential scans off for one transaction changes the question to
 * "CAN you use it" — that the index exists, covers this column, and matches
 * this operator.
 */
describe("the shipsTo filter and the GIN index", () => {
  interface QueryEvent {
    query: string;
    params: string;
  }

  /**
   * The SQL the shared client sent while `run` was happening.
   *
   * `$on("query")` is only typed when the client is constructed with query
   * logging, which ours is in tests alone — hence the cast.
   */
  async function sqlDuring(
    run: () => Promise<unknown>,
  ): Promise<{ query: string; params: unknown[] }> {
    let captured: { query: string; params: unknown[] } | undefined;
    const client = prisma as unknown as {
      $on: (event: "query", listener: (event: QueryEvent) => void) => void;
    };

    client.$on("query", (event) => {
      if (event.query.includes('"Help"') && event.query.includes("SELECT")) {
        captured = {
          query: event.query,
          params: JSON.parse(event.params) as unknown[],
        };
      }
    });

    await run();
    await new Promise((resolve) => setTimeout(resolve, 50));

    if (!captured) throw new Error("No SELECT against Help was captured");
    return captured;
  }

  it("asks the database the question a GIN index can answer", async () => {
    await makeHelp({ shipsTo: ["EE"] });

    const { query } = await sqlDuring(() => browse({ shipsTo: "EE" }));

    // @> is "contains". A LIKE, or unnesting the array, would not use the index.
    expect(query).toContain('"shipsTo" @>');
  });

  it("can answer that question with the index rather than a table scan", async () => {
    await makeHelp({ shipsTo: ["EE"] });
    const { query, params } = await sqlDuring(() => browse({ shipsTo: "EE" }));

    const plan = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL enable_seqscan = off");
      return tx.$queryRawUnsafe<{ "QUERY PLAN": string }[]>(
        `EXPLAIN ${query}`,
        ...params,
      );
    });
    const planText = plan.map((row) => row["QUERY PLAN"]).join("\n");

    expect(planText).toContain("Help_shipsTo_idx");
    expect(planText).toContain("Bitmap Index Scan");
  });
});
