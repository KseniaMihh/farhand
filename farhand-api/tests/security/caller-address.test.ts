import express, { type RequestHandler } from "express";
import { pinoHttp } from "pino-http";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "../../src/env.js";
import { logger } from "../../src/logger.js";
import {
  CALLER_HEADER,
  callerAddress,
  createCallerAddressCheck,
  createVouchedAddress,
  isPrivateAddress,
  TRUSTED_PROXY_HOPS,
  VOUCH_HEADER,
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

/**
 * The address our own frontend states — issue #164.
 *
 * WHY A SECRET AND NOT A COUNT. Everything above this line resolves a caller
 * by counting hops back from the socket, and that works for a request which
 * arrives at the API directly. Since #152 there is a second path: the browser
 * talks to the deployed site and `farhand-web/proxy.ts` forwards to us,
 * which puts a fourth machine in front and makes the chain four entries long
 * where a direct one is three. `TRUSTED_PROXY_HOPS` cannot be right for both.
 *
 * Nor can it be made right by raising it, which is the part that took three
 * deploys to see. A direct caller who writes ONE invented entry produces a
 * four-entry chain of exactly the same shape as the proxied one — the test
 * `a count of four believes a forgery` below is that, written down. The chain
 * carries no evidence of which path it came down, so the frontend has to say
 * who the caller is and prove that it is the frontend.
 *
 * The full measurements are in decision 0035.
 */

/** Long enough for `env.ts` to accept, and obviously not a real secret. */
const SECRET = "a-test-vouch-secret-of-ample-length";

/**
 * An app that answers with the address it would count the request against.
 *
 * The secret is REQUIRED rather than defaulted, and that is not fussiness: the
 * first version of this helper defaulted it, so the case below that passes
 * `undefined` to mean "nothing configured" silently got the working secret
 * instead and the test asserted the wrong thing. A default parameter cannot
 * tell `undefined` from absent, and `undefined` is the state under test.
 */
function vouching(
  secret: string | undefined,
  hops: number = TRUSTED_PROXY_HOPS,
) {
  const app = express();
  app.set("trust proxy", hops);
  app.use(pinoHttp({ logger }));
  app.use(createVouchedAddress(secret));
  app.get("/who", (req, res) => {
    res.json({ ip: callerAddress(req), vouched: req.vouchedCaller ?? null });
  });
  return app;
}

/** The same, behind a limiter, for the budget tests. */
function vouchLimited(limiter: RequestHandler, secret = SECRET) {
  const app = express();
  app.set("trust proxy", TRUSTED_PROXY_HOPS);
  app.use(pinoHttp({ logger }));
  app.use(createVouchedAddress(secret));
  app.get("/thing", limiter, (_req, res) => {
    res.json({ ok: true });
  });
  app.use(errorHandler);
  return app;
}

/**
 * The chain as the API receives it through the deployed site: the visitor,
 * then Vercel's own outbound address, then the two intermediaries `chain`
 * already stands in for. Four entries, which is the shape that broke #152 —
 * a count of three lands on the second entry, and the second entry is
 * Vercel's.
 */
function proxiedChain(visitor: string): string {
  return [visitor, "198.51.100.77", "198.51.100.254", "10.0.0.1"].join(", ");
}

describe("the address our own frontend vouches for", () => {
  it("is believed, over anything the chain says", async () => {
    const visitor = nextCaller();

    const response = await request(vouching(SECRET))
      .get("/who")
      .set("X-Forwarded-For", proxiedChain(visitor))
      .set(CALLER_HEADER, visitor)
      .set(VOUCH_HEADER, SECRET);

    expect(response.body).toMatchObject({ ip: visitor, vouched: visitor });
  });

  /**
   * The failure this issue exists for, as a test rather than a story. Without
   * the vouch, the four-entry chain resolves its SECOND entry — which on
   * production is Vercel, and which is why every visitor shared one bucket.
   */
  it("is the only way to get it right: the chain alone resolves the proxy", async () => {
    const visitor = nextCaller();

    const response = await request(vouching(SECRET))
      .get("/who")
      .set("X-Forwarded-For", proxiedChain(visitor));

    expect(response.body).toMatchObject({ ip: "198.51.100.77" });
    expect(response.body).not.toMatchObject({ ip: visitor });
  });

  /**
   * And why the obvious fix is not one. Raising the count to four resolves
   * the leftmost entry, which on a DIRECT request is whatever the caller
   * typed. This is the trap decision 0029 names: a count that is too large
   * lands on a real address and passes every check we have.
   */
  it("a count of four believes a forgery, which is why it stays at three", async () => {
    const caller = nextCaller();

    const four = await request(vouching(SECRET, 4))
      .get("/who")
      .set("X-Forwarded-For", chain(caller, "203.0.113.250"));

    const three = await request(vouching(SECRET, TRUSTED_PROXY_HOPS))
      .get("/who")
      .set("X-Forwarded-For", chain(caller, "203.0.113.250"));

    expect(four.body).toMatchObject({ ip: "203.0.113.250" });
    expect(three.body).toMatchObject({ ip: caller });
  });

  it("is ignored without the proof", async () => {
    const visitor = nextCaller();

    const response = await request(vouching(SECRET))
      .get("/who")
      .set("X-Forwarded-For", chain(visitor))
      .set(CALLER_HEADER, "203.0.113.251");

    expect(response.body).toMatchObject({ ip: visitor, vouched: null });
  });

  it("is ignored when the proof is wrong", async () => {
    const visitor = nextCaller();

    const response = await request(vouching(SECRET))
      .get("/who")
      .set("X-Forwarded-For", chain(visitor))
      .set(CALLER_HEADER, "203.0.113.252")
      .set(VOUCH_HEADER, "not-the-secret-but-of-a-similar-length");

    expect(response.body).toMatchObject({ ip: visitor, vouched: null });
  });

  /**
   * The state of every laptop and of this entire suite: no secret set. It has
   * to mean "nothing is ever vouched", because it is also the state a
   * forgotten dashboard variable produces — and then the headers below are
   * just something a stranger wrote.
   */
  it("is ignored when no secret is configured at all", async () => {
    const visitor = nextCaller();

    const response = await request(vouching(undefined))
      .get("/who")
      .set("X-Forwarded-For", chain(visitor))
      .set(CALLER_HEADER, "203.0.113.253")
      .set(VOUCH_HEADER, SECRET);

    expect(response.body).toMatchObject({ ip: visitor, vouched: null });
  });

  /**
   * A vouched value that is not an address would become a rate-limit key all
   * the same, and quietly group everyone it was sent for into one bucket —
   * which is the bug this issue is closing, arriving by another door.
   *
   * `"1.2.3.4, 5.6.7.8"` is in here because Node joins duplicate headers with
   * a comma, so that is what two of these headers look like by the time
   * Express sees them.
   */
  it.each([
    ["", "empty"],
    ["   ", "whitespace"],
    ["example.com", "a hostname"],
    ["1.2.3.4, 5.6.7.8", "two of them, which is what a duplicate header is"],
    ["203.0.113.9:443", "an address with a port"],
    ["not an address at all", "words"],
  ])("is ignored when it is not an address: %s (%s)", async (value, _why) => {
    const visitor = nextCaller();

    const response = await request(vouching(SECRET))
      .get("/who")
      .set("X-Forwarded-For", chain(visitor))
      .set(CALLER_HEADER, value)
      .set(VOUCH_HEADER, SECRET);

    expect(response.body).toMatchObject({ ip: visitor, vouched: null });
  });

  it("is believed over IPv6, which is how half the internet arrives", async () => {
    const response = await request(vouching(SECRET))
      .get("/who")
      .set("X-Forwarded-For", proxiedChain(nextCaller()))
      .set(CALLER_HEADER, "2001:db8::1")
      .set(VOUCH_HEADER, SECRET);

    expect(response.body).toMatchObject({ ip: "2001:db8::1" });
  });

  /**
   * The direct path has to keep working exactly as #145 left it, because it
   * is still how anything but the website reaches this API.
   */
  it("leaves the direct path alone when nobody vouches", async () => {
    const caller = nextCaller();

    const response = await request(vouching(SECRET))
      .get("/who")
      .set("X-Forwarded-For", chain(caller, "203.0.113.254"));

    expect(response.body).toMatchObject({ ip: caller, vouched: null });
  });
});

describe("one budget per visitor, not one for the frontend", () => {
  beforeEach(() => {
    env.RATE_LIMIT_ENABLED = true;
  });

  afterEach(() => {
    env.RATE_LIMIT_ENABLED = false;
  });

  /**
   * #152's unmet acceptance criterion, as a test. Both visitors arrive
   * through the same frontend, so the chain the API sees is identical for
   * both of them; only the vouched address differs. Get this wrong and the
   * second visitor is refused for what the first one spent — ten people in
   * ten countries exhausting a limit meant for one.
   */
  it("does not let one visitor spend another's, behind the same frontend", async () => {
    const app = vouchLimited(
      createRateLimiter({
        name: "vouch-separate",
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
        (
          await request(app)
            .get("/thing")
            .set("X-Forwarded-For", proxiedChain(spent))
            .set(CALLER_HEADER, spent)
            .set(VOUCH_HEADER, SECRET)
        ).status,
      );
    }

    const other = await request(app)
      .get("/thing")
      .set("X-Forwarded-For", proxiedChain(fresh))
      .set(CALLER_HEADER, fresh)
      .set(VOUCH_HEADER, SECRET);

    expect(spentStatuses).toEqual([200, 200, 429]);
    expect(other.status).toBe(200);
  });

  /**
   * The other direction, and the reason the secret exists: a stranger must
   * not be able to buy themselves an unlimited budget by naming a new address
   * each time.
   */
  it("does not hand a stranger a fresh budget for a caller header they wrote", async () => {
    const app = vouchLimited(
      createRateLimiter({
        name: "vouch-forged",
        windowMs: 60_000,
        max: 2,
        by: "ip",
      }),
    );
    const caller = nextCaller();

    for (let i = 0; i < 3; i++) {
      await request(app).get("/thing").set("X-Forwarded-For", chain(caller));
    }

    const statuses: number[] = [];
    for (let i = 0; i < 3; i++) {
      statuses.push(
        (
          await request(app)
            .get("/thing")
            .set("X-Forwarded-For", chain(caller))
            .set(CALLER_HEADER, `203.0.113.${String(100 + i)}`)
        ).status,
      );
    }

    expect(statuses).toEqual([429, 429, 429]);
  });
});

describe("saying so when a vouch stops verifying", () => {
  /**
   * What a rotated secret looks like from in here, and it is otherwise
   * completely silent: the site keeps working, every visitor quietly shares
   * one bucket again, and the symptom is "signing in sometimes says too many
   * attempts" — which looks nothing like its cause.
   */
  it("says it once when a vouch arrives and fails", async () => {
    const complained = vi.spyOn(logger, "error");
    const app = vouching(SECRET);

    for (let i = 0; i < 3; i++) {
      await request(app)
        .get("/who")
        .set(CALLER_HEADER, "203.0.113.11")
        .set(VOUCH_HEADER, "a secret that is wrong but plausibly long");
    }

    expect(complained).toHaveBeenCalledTimes(1);
  });

  /** It is one app's silence, not the module's — same reason as above. */
  it("is one app's silence, not the module's", async () => {
    const complained = vi.spyOn(logger, "error");

    await request(vouching(SECRET))
      .get("/who")
      .set(CALLER_HEADER, "203.0.113.12")
      .set(VOUCH_HEADER, "wrong, and long enough to look like a real one");
    await request(vouching(SECRET))
      .get("/who")
      .set(CALLER_HEADER, "203.0.113.13")
      .set(VOUCH_HEADER, "wrong, and long enough to look like a real one");

    expect(complained).toHaveBeenCalledTimes(2);
  });

  it("stays quiet when no vouch arrives at all", async () => {
    const complained = vi.spyOn(logger, "error");

    await request(vouching(SECRET))
      .get("/who")
      .set("X-Forwarded-For", chain(nextCaller()));

    expect(complained).not.toHaveBeenCalled();
  });

  it("stays quiet for a vouch that verifies", async () => {
    const complained = vi.spyOn(logger, "error");

    await request(vouching(SECRET))
      .get("/who")
      .set(CALLER_HEADER, "203.0.113.14")
      .set(VOUCH_HEADER, SECRET);

    expect(complained).not.toHaveBeenCalled();
  });

  /**
   * Never the secret itself, nor the one that was offered. The complaint is
   * read in Render's logs, which is the one place a secret must not be —
   * logger.ts redacts the header for the same reason.
   */
  it("never writes either secret into the complaint", async () => {
    const complained = vi.spyOn(logger, "error");

    await request(vouching(SECRET))
      .get("/who")
      .set(CALLER_HEADER, "203.0.113.15")
      .set(VOUCH_HEADER, "the-wrong-secret-of-a-believable-length");

    const said = JSON.stringify(complained.mock.calls);
    expect(said).not.toContain(SECRET);
    expect(said).not.toContain("the-wrong-secret-of-a-believable-length");
  });
});

describe("a private address, vouched for", () => {
  beforeEach(() => {
    env.NODE_ENV = "production";
  });

  afterEach(() => {
    env.NODE_ENV = "test";
  });

  /**
   * Accepted rather than refused, deliberately. A frontend vouching for
   * `10.0.0.1` is a frontend reading its own inbound chain wrongly, and
   * believing it is what makes the alarm below fire and say so. Refusing
   * would fall back to `req.ip`, look almost right, and hide it.
   */
  it("is believed, so that the alarm can see it", async () => {
    const app = express();
    app.set("trust proxy", TRUSTED_PROXY_HOPS);
    app.use(pinoHttp({ logger }));
    app.use(createVouchedAddress(SECRET));
    app.get("/who", (req, res) => {
      res.json({ ip: callerAddress(req) });
    });

    const response = await request(app)
      .get("/who")
      .set("X-Forwarded-For", proxiedChain(nextCaller()))
      .set(CALLER_HEADER, "10.0.0.1")
      .set(VOUCH_HEADER, SECRET);

    expect(response.body).toMatchObject({ ip: "10.0.0.1" });
  });

  /**
   * And the alarm has to send the reader to the right file. A vouched private
   * address is not a hop-count problem, and `TRUSTED_PROXY_HOPS` is the wrong
   * setting to go and change — an afternoon in the wrong place.
   */
  it("points at the frontend, not at the hop count", async () => {
    const complained = vi.spyOn(logger, "error");
    const app = express();
    app.set("trust proxy", TRUSTED_PROXY_HOPS);
    app.use(pinoHttp({ logger }));
    app.use(createVouchedAddress(SECRET));
    app.use(createCallerAddressCheck());
    app.get("/who", (_req, res) => {
      res.json({ ok: true });
    });

    await request(app)
      .get("/who")
      .set("X-Forwarded-For", proxiedChain(nextCaller()))
      .set(CALLER_HEADER, "10.0.0.1")
      .set(VOUCH_HEADER, SECRET);

    expect(complained).toHaveBeenCalledTimes(1);
    const [, message] = complained.mock.calls[0] as [unknown, string];
    expect(message).toContain("vouched");
    expect(message).toContain("proxy.ts");
    expect(message).not.toContain("trust proxy believes");
  });
});
