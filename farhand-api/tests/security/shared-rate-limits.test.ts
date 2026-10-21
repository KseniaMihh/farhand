import express from "express";
import { pinoHttp } from "pino-http";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../../src/db.js";
import { env } from "../../src/env.js";
import { logger } from "../../src/logger.js";
import { errorHandler } from "../../src/middleware/error-handler.js";
import {
  createRateLimiter,
  RATE_LIMITS,
} from "../../src/middleware/rate-limit.js";

/**
 * Rate limits that survive a second machine — issue #91.
 *
 * These tests are the specification. They fail until the TODOs in
 * src/middleware/rate-limit-store.ts are filled in.
 *
 *   npm run test:watch -- shared-rate-limits
 *
 * The counters used to live in one process's memory, which is correct for one
 * instance and wrong for several: two would each count to the limit, so the
 * documented 20 login attempts per address quietly became 40. That was the
 * only thing in the code standing between this project and a second machine
 * (docs/14-deployment.md).
 *
 * HOW A SECOND MACHINE IS SIMULATED, because this is the whole file. Calling
 * `createApp()` twice is not two processes: the limiters are module-level, so
 * both apps share the very same objects and would share a counter however it
 * was stored. `vi.resetModules()` and a fresh `import()` build a second copy
 * of the whole module graph — new limiters, new store objects, nothing shared
 * in memory — which is exactly what a second instance is. If the budget is
 * still one budget across the two, it is the database holding it.
 */

let addressCounter = 0;

beforeEach(() => {
  env.RATE_LIMIT_ENABLED = true;
});

afterEach(() => {
  env.RATE_LIMIT_ENABLED = false;
  vi.restoreAllMocks();
});

/** A fresh address per test, so no two tests share a budget. */
function nextIp(): string {
  addressCounter += 1;
  // 198.51.100.x is a documentation range: it can never be a real client.
  return `198.51.100.${String(addressCounter)}`;
}

/**
 * One independent copy of the limiters, as a separate instance would have.
 *
 * `resetModules` clears Vitest's module registry, so the dynamic import below
 * evaluates middleware/rate-limit.ts again and builds new limiter and store
 * objects. They talk to the same database, and to nothing else.
 */
async function anInstance(): Promise<express.Express> {
  vi.resetModules();
  const { limiters } = await import("../../src/middleware/rate-limit.js");
  // The fresh graph has its OWN env object, so the switch set in `beforeEach`
  // above — which belongs to this file's copy — means nothing to it. A second
  // process reads its own environment too; this is that, and forgetting it
  // made every limiter in the new instance skip counting entirely.
  const { env: theirs } = await import("../../src/env.js");
  theirs.RATE_LIMIT_ENABLED = true;
  // And ITS error handler, not this file's. A reset graph has its own
  // `HttpError` class, and `instanceof` across two copies of a class is
  // false — so the 429 the limiter throws came out as a 500 until these two
  // came from the same place. A second process has one copy of everything;
  // this is the seam where simulating one leaks.
  const { errorHandler: theirHandler } =
    await import("../../src/middleware/error-handler.js");

  const app = express();
  app.set("trust proxy", 1);
  app.use(pinoHttp({ logger }));
  app.use(express.json());
  app.post("/thing", limiters.loginByIp, (_req, res) => {
    res.json({ ok: true });
  });
  app.use(theirHandler);

  return app;
}

/**
 * An app on THIS file's module graph, so a spy on `prisma` here is the client
 * it really uses. Needed by the fail-open tests and by nothing else.
 */
function thisInstance(): express.Express {
  const app = express();
  app.set("trust proxy", 1);
  app.use(pinoHttp({ logger }));
  app.use(express.json());
  app.post(
    "/thing",
    createRateLimiter({
      name: `fail-open-${String((failOpenCounter += 1))}`,
      windowMs: RATE_LIMITS.login.windowMs,
      max: RATE_LIMITS.login.perIp,
      by: "ip",
    }),
    (_req, res) => {
      res.json({ ok: true });
    },
  );
  app.use(errorHandler);

  return app;
}

let failOpenCounter = 0;

/** One request from `ip`, and the status it got. */
async function hit(app: express.Express, ip: string): Promise<number> {
  const response = await request(app)
    .post("/thing")
    .set("X-Forwarded-For", ip)
    .send({});

  return response.status;
}

describe("one budget, however many machines", () => {
  it("counts a single address across two instances", async () => {
    const [first, second] = [await anInstance(), await anInstance()];
    const ip = nextIp();
    const limit = RATE_LIMITS.login.perIp;

    // Alternate between them, which is what a load balancer does.
    const answers: number[] = [];
    for (let n = 0; n < limit; n += 1) {
      answers.push(await hit(n % 2 === 0 ? first : second, ip));
    }

    // Exactly the documented number, in total rather than each.
    expect(answers.every((status) => status === 200)).toBe(true);
    expect(await hit(first, ip)).toBe(429);
    expect(await hit(second, ip)).toBe(429);
  });

  it("keeps the counter where both instances can see it", async () => {
    const first = await anInstance();
    const ip = nextIp();

    await hit(first, ip);
    await hit(first, ip);

    const rows = await prisma.rateLimit.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ count: 2 });
    // The limiter's name is part of the key: one table holds every limiter's
    // counters, and two limiters counting the same address must not share a
    // budget.
    expect(rows[0]?.key).toContain(ip);
    expect(rows[0]?.key).toMatch(/^login-ip:/);
  });

  it("gives each limiter its own budget for the same address", async () => {
    const app = express();
    app.set("trust proxy", 1);
    app.use(pinoHttp({ logger }));
    app.use(express.json());
    app.post(
      "/login",
      createRateLimiter({
        name: "login-ip",
        windowMs: RATE_LIMITS.login.windowMs,
        max: RATE_LIMITS.login.perIp,
        by: "ip",
      }),
      (_req, res) => res.json({ ok: 1 }),
    );
    app.post(
      "/token",
      createRateLimiter({
        name: "token-ip",
        windowMs: RATE_LIMITS.token.windowMs,
        max: RATE_LIMITS.token.perIp,
        by: "ip",
      }),
      (_req, res) => res.json({ ok: 1 }),
    );
    app.use(errorHandler);
    const ip = nextIp();

    for (let n = 0; n < RATE_LIMITS.login.perIp; n += 1) {
      await request(app).post("/login").set("X-Forwarded-For", ip).send({});
    }

    expect(
      (await request(app).post("/login").set("X-Forwarded-For", ip).send({}))
        .status,
    ).toBe(429);
    // Spending the login budget must not spend the token one.
    expect(
      (await request(app).post("/token").set("X-Forwarded-For", ip).send({}))
        .status,
    ).toBe(200);
    expect(await prisma.rateLimit.count()).toBe(2);
  });

  it("starts the count again once the window has passed", async () => {
    const app = await anInstance();
    const ip = nextIp();

    for (let n = 0; n < RATE_LIMITS.login.perIp; n += 1) await hit(app, ip);
    expect(await hit(app, ip)).toBe(429);

    // The window ends; the row stays, because the next request rewrites it.
    await prisma.rateLimit.updateMany({
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    expect(await hit(app, ip)).toBe(200);
    const row = await prisma.rateLimit.findFirstOrThrow();
    expect(row.count).toBe(1);
  });

  /**
   * The window's end is written by the DATABASE's clock, not the
   * application's. Several instances means several clocks, and a deadline two
   * machines disagree about is a counter that restarts whenever the request
   * lands on the one that is running fast.
   *
   * Proved by moving this process's clock and leaving the database's alone:
   * `Date.now` is stubbed rather than Vitest's fake timers, because the
   * database driver needs its timers to keep working while the query runs.
   */
  it("dates the window from the database, not the process", async () => {
    const app = await anInstance();
    const ip = nextIp();
    const realNow = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(realNow - 5 * 60 * 1000);

    await hit(app, ip);

    vi.restoreAllMocks();
    const row = await prisma.rateLimit.findFirstOrThrow();
    const expected = Date.now() + RATE_LIMITS.login.windowMs;
    // Within a minute of the real deadline, rather than five minutes early.
    expect(Math.abs(row.expiresAt.getTime() - expected)).toBeLessThan(60_000);
  });
});

describe("when the database cannot be reached", () => {
  /**
   * Fail open, and say so loudly (decision 0027).
   *
   * The store IS the application's database, so "the counter cannot be read"
   * already means every endpoint behind it is answering 500. Refusing as well
   * would turn a database blip into a certain outage instead of a likely one
   * — and the log line is what makes the choice visible rather than silent.
   */
  it("lets the request through, and writes a line about it", async () => {
    // This file's own limiter, not a reset copy: a reset module graph builds
    // its own database client, and the spy below would be watching the wrong
    // one.
    const app = thisInstance();
    const ip = nextIp();
    const broken = vi
      .spyOn(prisma, "$queryRaw")
      .mockRejectedValue(new Error("the database is having a bad minute"));
    const complained = vi.spyOn(logger, "error");

    expect(await hit(app, ip)).toBe(200);

    expect(broken).toHaveBeenCalled();
    expect(
      complained.mock.calls.some((call) =>
        String(call[1]).includes("rate limit"),
      ),
    ).toBe(true);
  });

  it("does not pretend to have counted", async () => {
    const app = thisInstance();
    const ip = nextIp();
    vi.spyOn(prisma, "$queryRaw").mockRejectedValue(new Error("down"));

    // Every request passes while the store is unreachable, including the
    // twenty-first: a store that cannot count must not guess.
    for (let n = 0; n < RATE_LIMITS.login.perIp + 5; n += 1) {
      expect(await hit(app, ip)).toBe(200);
    }
  });
});

describe("the sweep", () => {
  it("deletes windows that have ended and leaves live ones alone", async () => {
    const { sweepRateLimits } =
      await import("../../src/jobs/sweep-rate-limits.js");
    await prisma.rateLimit.createMany({
      data: [
        { key: "old:1", count: 9, expiresAt: new Date(Date.now() - 60_000) },
        { key: "live:1", count: 1, expiresAt: new Date(Date.now() + 60_000) },
      ],
    });

    const deleted = await sweepRateLimits();

    expect(deleted).toBe(1);
    expect((await prisma.rateLimit.findMany()).map((row) => row.key)).toEqual([
      "live:1",
    ]);
  });
});
