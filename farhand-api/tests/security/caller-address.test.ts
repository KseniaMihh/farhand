import express, { type RequestHandler } from "express";
import { pinoHttp } from "pino-http";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "../../src/env.js";
import { logger } from "../../src/logger.js";
import {
  createCallerAddressCheck,
  isPrivateAddress,
  TRUSTED_PROXY_HOPS,
} from "../../src/middleware/caller-address.js";
import { errorHandler } from "../../src/middleware/error-handler.js";
import { createRateLimiter } from "../../src/middleware/rate-limit.js";

/**
 * Who the caller is — issue #145.
 *
 * These tests are the specification. They fail until the TODOs in
 * src/middleware/caller-address.ts are filled in.
 *
 *   npm run test:watch -- caller-address
 *
 * THE BUG THEY EXIST FOR. `src/app.ts` trusted one hop of `X-Forwarded-For`
 * for a year. Production has three — a caller, Cloudflare in front of
 * `onrender.com`, and Render's balancer — and Express counts hops from the
 * socket backwards, so one hop landed on the balancer. Every by-address rate
 * limit was therefore counted against a handful of internal addresses, and
 * `Session.ipAddress` recorded an address nobody owns. The pre-launch walk
 * (#131) found it on 21 October 2026, in the one step written to ask this
 * question; nothing in the suite could have.
 *
 * WHY NOTHING IN THE SUITE COULD HAVE. Every request here arrives from the
 * same machine, so a test that sends one `X-Forwarded-For` entry and reads
 * back the same address passes under any hop count: with a chain shorter than
 * the count, Express clamps to the leftmost entry. A test that cannot fail is
 * worse than no test, and the entire reason this file builds chains of the
 * length production really has.
 */

/**
 * One caller's address, as it reaches us on production.
 *
 * Two intermediaries after the caller: a public documentation address standing
 * in for Cloudflare, and a private one standing in for Render's balancer —
 * which is the address the bug resolved to, so it is the honest stand-in.
 */
function chain(caller: string, ...forged: string[]): string {
  return [...forged, caller, "198.51.100.254", "10.0.0.1"].join(", ");
}

let addressCounter = 0;

/** A fresh caller per test, so no two tests share a rate-limit budget. */
function nextCaller(): string {
  addressCounter += 1;
  // 203.0.113.x is a documentation range: it can never be a real client.
  return `203.0.113.${String(addressCounter)}`;
}

/** An app that answers with whatever address it resolved. */
function echoing(hops: number = TRUSTED_PROXY_HOPS) {
  const app = express();
  app.set("trust proxy", hops);
  app.use(pinoHttp({ logger }));
  app.get("/who", (req, res) => {
    res.json({ ip: req.ip, ips: req.ips });
  });
  return app;
}

/** One route behind one limiter, with production's hop count. */
function limited(limiter: RequestHandler) {
  const app = express();
  app.set("trust proxy", TRUSTED_PROXY_HOPS);
  app.use(pinoHttp({ logger }));
  app.get("/thing", limiter, (_req, res) => {
    res.json({ ok: true });
  });
  app.use(errorHandler);
  return app;
}

describe("the address a request arrives with", () => {
  it("is the caller's own, three hops away", async () => {
    const caller = nextCaller();

    const response = await request(echoing())
      .get("/who")
      .set("X-Forwarded-For", chain(caller));

    expect(response.body).toMatchObject({ ip: caller });
  });

  /**
   * The forgery argument for counting hops, and the reason the count is not
   * `true`.
   *
   * `X-Forwarded-For` is a header, so a caller can write one. Cloudflare
   * APPENDS the address it sees to whatever arrives, so anything a caller
   * invents ends up to the LEFT of its own real address — and counting from
   * the right steps straight over it. With `trust proxy` set to `true`,
   * Express would believe the leftmost entry and this test would read back
   * `203.0.113.200`.
   */
  it("is not the one the caller wrote for itself", async () => {
    const caller = nextCaller();

    const response = await request(echoing())
      .get("/who")
      .set("X-Forwarded-For", chain(caller, "203.0.113.200"));

    expect(response.body).toMatchObject({ ip: caller });
    expect((response.body as { ips: string[] }).ips).not.toContain(
      "203.0.113.200",
    );
  });

  /**
   * What happens if an intermediary disappears — Cloudflare taken out of
   * front, say. Express clamps the count to the chain, so a shorter chain
   * still resolves to its leftmost entry rather than to nothing.
   *
   * This is the forgiving direction, and it is also why the suite was blind:
   * a one-entry chain reads back correctly under every count there is.
   */
  it("is still the caller's when the chain is shorter than the count", async () => {
    const caller = nextCaller();

    const response = await request(echoing())
      .get("/who")
      .set("X-Forwarded-For", `${caller}, 10.0.0.1`);

    expect(response.body).toMatchObject({ ip: caller });
  });
});

describe("one budget per caller, not one for the proxy", () => {
  beforeEach(() => {
    env.RATE_LIMIT_ENABLED = true;
  });

  afterEach(() => {
    env.RATE_LIMIT_ENABLED = false;
  });

  /**
   * The failure the hop count caused, written as a test.
   *
   * Both callers are behind the same two intermediaries, which is the whole
   * internet's situation on production. Resolve the address wrongly and the
   * second caller is refused for what the first one spent.
   */
  it("does not let one caller spend another's, behind the same proxy", async () => {
    const app = limited(
      createRateLimiter({
        name: "hops-separate",
        windowMs: 60_000,
        max: 2,
        by: "ip",
      }),
    );
    const spent = nextCaller();
    const fresh = nextCaller();

    const spentStatuses: number[] = [];
    for (let i = 0; i < 3; i++) {
      spentStatuses.push(
        (await request(app).get("/thing").set("X-Forwarded-For", chain(spent)))
          .status,
      );
    }

    const other = await request(app)
      .get("/thing")
      .set("X-Forwarded-For", chain(fresh));

    expect(spentStatuses).toEqual([200, 200, 429]);
    expect(other.status).toBe(200);
  });

  /** The other direction: a caller must not buy itself a new budget. */
  it("does not hand a caller a fresh budget for a header it wrote", async () => {
    const app = limited(
      createRateLimiter({
        name: "hops-forged",
        windowMs: 60_000,
        max: 2,
        by: "ip",
      }),
    );
    const caller = nextCaller();

    for (let i = 0; i < 3; i++) {
      await request(app).get("/thing").set("X-Forwarded-For", chain(caller));
    }

    // A different invented address every time, which is what a script would
    // do once it worked out that the leftmost entry was being believed.
    const statuses: number[] = [];
    for (let i = 0; i < 3; i++) {
      statuses.push(
        (
          await request(app)
            .get("/thing")
            .set("X-Forwarded-For", chain(caller, `203.0.113.${String(i)}`))
        ).status,
      );
    }

    expect(statuses).toEqual([429, 429, 429]);
  });
});

describe("an address that cannot belong to a caller", () => {
  it.each([
    ["10.195.187.131", true, "the address production actually resolved to"],
    ["10.196.55.5", true, "the second one, from A's data export"],
    ["172.16.0.1", true, "the bottom of the RFC 1918 middle range"],
    ["172.31.255.255", true, "the top of it"],
    ["172.32.0.1", false, "one past the top, which is a real address"],
    ["172.15.255.255", false, "one below it, likewise"],
    ["192.168.1.1", true, "a home network"],
    ["127.0.0.1", true, "loopback"],
    ["::1", true, "loopback, the other spelling"],
    ["::ffff:127.0.0.1", true, "what Node hands back with no header at all"],
    ["::ffff:10.0.0.1", true, "an IPv4-mapped private address"],
    ["169.254.1.1", true, "link-local, which means DHCP failed"],
    ["fd00::1", true, "IPv6 unique-local"],
    ["203.0.113.7", false, "a caller"],
    ["2001:db8::1", false, "a caller, over IPv6"],
    [undefined, false, "nothing at all, which is not a wrong address"],
  ])("%s → %s (%s)", (address, expected, _why) => {
    expect(isPrivateAddress(address)).toBe(expected);
  });
});

describe("saying so when the hop count is wrong again", () => {
  beforeEach(() => {
    env.NODE_ENV = "production";
  });

  afterEach(() => {
    env.NODE_ENV = "test";
    vi.restoreAllMocks();
  });

  /** An app whose count is deliberately the broken one, with the check on. */
  function miscounting(hops = 1) {
    const app = express();
    app.set("trust proxy", hops);
    app.use(pinoHttp({ logger }));
    app.use(createCallerAddressCheck());
    app.get("/who", (req, res) => {
      res.json({ ip: req.ip });
    });
    return app;
  }

  it("says the chain and the address it resolved, at error level", async () => {
    const complained = vi.spyOn(logger, "error");

    const response = await request(miscounting())
      .get("/who")
      .set("X-Forwarded-For", chain(nextCaller()));

    // The bug itself: one hop resolves to the rightmost entry.
    expect(response.body).toMatchObject({ ip: "10.0.0.1" });
    expect(complained).toHaveBeenCalledTimes(1);

    const [context, message] = complained.mock.calls[0] as [
      { ip?: string; forwardedFor?: string },
      string,
    ];
    expect(context.ip).toBe("10.0.0.1");
    // The chain, so the log line alone says what the count should have been.
    expect(context.forwardedFor).toContain("198.51.100.254");
    expect(message).toMatch(/trust proxy/i);
  });

  /**
   * Three hundred requests a minute is the global ceiling, and a line for
   * every one of them is a log nobody reads and, with a DSN set, a Sentry
   * quota spent on one fact.
   */
  it("says it once, however many requests arrive", async () => {
    const complained = vi.spyOn(logger, "error");
    const app = miscounting();

    for (let i = 0; i < 5; i++) {
      await request(app)
        .get("/who")
        .set("X-Forwarded-For", chain(nextCaller()));
    }

    expect(complained).toHaveBeenCalledTimes(1);
  });

  /** A second app has said nothing yet, which is what the factory is for. */
  it("is one app's silence, not the module's", async () => {
    const complained = vi.spyOn(logger, "error");

    await request(miscounting())
      .get("/who")
      .set("X-Forwarded-For", chain(nextCaller()));
    await request(miscounting())
      .get("/who")
      .set("X-Forwarded-For", chain(nextCaller()));

    expect(complained).toHaveBeenCalledTimes(2);
  });

  /**
   * That the check is MOUNTED, which nothing else here proves: every test
   * above builds its own app, so all of them would pass with the middleware
   * missing from src/app.ts entirely.
   *
   * A request straight to the app carries no `X-Forwarded-For` at all, so
   * Express resolves the socket — loopback — which is exactly the shape of
   * the fault on production, where the socket is Render's loopback too.
   */
  it("is wired into the real app", async () => {
    const complained = vi.spyOn(logger, "error");
    const { createApp } = await import("../../src/app.js");

    await request(createApp()).get("/health");

    expect(complained).toHaveBeenCalledTimes(1);
    const [context] = complained.mock.calls[0] as [{ ip?: string }, string];
    expect(isPrivateAddress(context.ip)).toBe(true);
  });

  it("stays quiet when the address it resolved is a real one", async () => {
    const complained = vi.spyOn(logger, "error");
    const caller = nextCaller();

    const response = await request(miscounting(TRUSTED_PROXY_HOPS))
      .get("/who")
      .set("X-Forwarded-For", chain(caller));

    expect(response.body).toMatchObject({ ip: caller });
    expect(complained).not.toHaveBeenCalled();
  });

  /**
   * Development is a private address by definition — `127.0.0.1`, or Docker's
   * network — and a check that complained about `npm run dev` would be turned
   * off within the week.
   */
  it("stays quiet outside production, where a private address is normal", async () => {
    env.NODE_ENV = "development";
    const complained = vi.spyOn(logger, "error");

    await request(miscounting()).get("/who");

    expect(complained).not.toHaveBeenCalled();
  });
});
