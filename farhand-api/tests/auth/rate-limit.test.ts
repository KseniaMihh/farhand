import express, { type RequestHandler } from "express";
import { pinoHttp } from "pino-http";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { env } from "../../src/env.js";
import { logger } from "../../src/logger.js";
import { errorHandler } from "../../src/middleware/error-handler.js";
import { createRateLimiter } from "../../src/middleware/rate-limit.js";
import { PASSWORD, signUpAndLogIn } from "../helpers/auth.js";

/**
 * Rate limiting — issue #14.
 *
 * These tests are the specification. They fail until the TODO in
 * src/middleware/rate-limit.ts is filled in.
 *
 *   npm run test:watch -- rate-limit
 *
 * Two things make this file different from the others.
 *
 * FIRST, .env.test turns rate limiting off, because every other test file
 * makes dozens of requests from one address on purpose. These tests turn it
 * back on for themselves, and off again afterwards.
 *
 * SECOND, the counters live in memory and are NOT cleared between tests —
 * truncating the database does not touch them. So every test uses its own IP
 * address and its own email, and none of them can spend another's budget.
 */
const app = createApp();

beforeEach(() => {
  env.RATE_LIMIT_ENABLED = true;
});

afterEach(() => {
  env.RATE_LIMIT_ENABLED = false;
});

/** A fresh address per test, so budgets never overlap. */
let addressCounter = 0;
function nextIp(): string {
  addressCounter += 1;
  // 198.51.100.x is a documentation range: it can never be a real client.
  return `198.51.100.${String(addressCounter)}`;
}

/** A fresh email per test, for the same reason. */
let emailCounter = 0;
function nextEmail(): string {
  emailCounter += 1;
  return `rate${String(emailCounter)}@example.com`;
}

interface ErrorBody {
  error: { code: string; message: string };
}

describe("the limiter itself", () => {
  /** One route behind one limiter, so the counting is all that is tested. */
  function limited(limiter: RequestHandler) {
    const inner = express();
    inner.set("trust proxy", 1);
    inner.use(pinoHttp({ logger }));
    inner.use(express.json());
    inner.post("/thing", limiter, (_req, res) => {
      res.json({ ok: true });
    });
    inner.use(errorHandler);
    return inner;
  }

  function post(inner: express.Express, ip: string, body?: object) {
    return request(inner)
      .post("/thing")
      .set("X-Forwarded-For", ip)
      .send(body ?? {});
  }

  it("allows requests up to the limit, then refuses", async () => {
    const inner = limited(
      createRateLimiter({ windowMs: 60_000, max: 3, by: "ip" }),
    );
    const ip = nextIp();

    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) statuses.push((await post(inner, ip)).status);

    expect(statuses).toEqual([200, 200, 200, 429]);
  });

  it("refuses with the API's error shape, not the library's plain text", async () => {
    const inner = limited(
      createRateLimiter({ windowMs: 60_000, max: 1, by: "ip" }),
    );
    const ip = nextIp();
    await post(inner, ip);

    const response = await post(inner, ip);
    const body = response.body as ErrorBody;

    // docs/06-api-contract.md: every error has the same shape.
    expect(response.status).toBe(429);
    expect(body.error.code).toBe("TOO_MANY_REQUESTS");
    expect(body.error.message).toBeTruthy();
  });

  it("says when to come back, in seconds", async () => {
    const inner = limited(
      createRateLimiter({ windowMs: 60_000, max: 1, by: "ip" }),
    );
    const ip = nextIp();
    await post(inner, ip);

    const response = await post(inner, ip);

    const retryAfter = Number(response.headers["retry-after"]);
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(60);
  });

  it("tells a client how much budget is left, before it runs out", async () => {
    const inner = limited(
      createRateLimiter({ windowMs: 60_000, max: 3, by: "ip" }),
    );

    const response = await post(inner, nextIp());

    expect(response.status).toBe(200);
    expect(response.headers["ratelimit-policy"]).toBeDefined();
  });

  it("counts each address separately", async () => {
    const inner = limited(
      createRateLimiter({ windowMs: 60_000, max: 1, by: "ip" }),
    );
    const first = nextIp();
    const second = nextIp();

    await post(inner, first);

    expect((await post(inner, first)).status).toBe(429);
    expect((await post(inner, second)).status).toBe(200);
  });

  it("counts by account wherever the requests come from", async () => {
    // The point of the per-account limit: one password guessed against one
    // account from a thousand addresses is still one account under attack.
    const inner = limited(
      createRateLimiter({ windowMs: 60_000, max: 2, by: "account" }),
    );
    const email = nextEmail();

    await post(inner, nextIp(), { email });
    await post(inner, nextIp(), { email });
    const third = await post(inner, nextIp(), { email });

    expect(third.status).toBe(429);
  });

  it("treats one address as one address, whatever the email", async () => {
    const inner = limited(
      createRateLimiter({ windowMs: 60_000, max: 2, by: "ip" }),
    );
    const ip = nextIp();

    await post(inner, ip, { email: nextEmail() });
    await post(inner, ip, { email: nextEmail() });
    const third = await post(inner, ip, { email: nextEmail() });

    expect(third.status).toBe(429);
  });

  it("gives one account one budget however the email is typed", async () => {
    const inner = limited(
      createRateLimiter({ windowMs: 60_000, max: 1, by: "account" }),
    );
    const email = nextEmail();

    await post(inner, nextIp(), { email });
    const response = await post(inner, nextIp(), {
      email: `  ${email.toUpperCase()} `,
    });

    expect(response.status).toBe(429);
  });

  it("lets the client back in once the window has passed", async () => {
    const inner = limited(
      createRateLimiter({ windowMs: 300, max: 1, by: "ip" }),
    );
    const ip = nextIp();
    await post(inner, ip);
    expect((await post(inner, ip)).status).toBe(429);

    await new Promise((resolve) => setTimeout(resolve, 400));

    expect((await post(inner, ip)).status).toBe(200);
  });

  it("does nothing at all when rate limiting is switched off", async () => {
    // Which is what lets the rest of the suite hammer these endpoints.
    const inner = limited(
      createRateLimiter({ windowMs: 60_000, max: 1, by: "ip" }),
    );
    const ip = nextIp();
    await post(inner, ip);
    // Over the limit while it is on — pinned, so a limiter that never counts
    // anything cannot pass this test.
    expect((await post(inner, ip)).status).toBe(429);

    env.RATE_LIMIT_ENABLED = false;

    expect((await post(inner, ip)).status).toBe(200);
  });
});

describe("the real endpoints are limited", () => {
  /**
   * These use the production limits from RATE_LIMITS, so they are slower —
   * each login hashes a password. They are what proves the limiters are
   * actually wired to the routes, which the tests above cannot show.
   */
  function login(ip: string, email: string) {
    return request(app)
      .post("/auth/login")
      .set("X-Forwarded-For", ip)
      .send({ email, password: "not the right passphrase" });
  }

  it("stops one address guessing passwords for many accounts", async () => {
    const ip = nextIp();

    // A different email every time, so only the per-address limit can bite.
    let last = 0;
    for (let i = 0; i < 21; i++) last = (await login(ip, nextEmail())).status;

    expect(last).toBe(429);
  });

  it("stops many addresses guessing the password of one account", async () => {
    const email = nextEmail();

    // A different address every time, so only the per-account limit can bite.
    let last = 0;
    for (let i = 0; i < 11; i++) last = (await login(nextIp(), email)).status;

    expect(last).toBe(429);
  });

  it("does not let a login limit block signing up", async () => {
    const ip = nextIp();
    let lastLogin = 0;
    for (let i = 0; i < 21; i++)
      lastLogin = (await login(ip, nextEmail())).status;
    // Pinned: this address really has run out of login attempts.
    expect(lastLogin).toBe(429);

    const response = await request(app)
      .post("/auth/register")
      .set("X-Forwarded-For", ip)
      .send({
        email: nextEmail(),
        password: PASSWORD,
        displayName: "Anna",
        countryCode: "EE",
      });

    // Different endpoints, different budgets.
    expect(response.status).toBe(201);
  });

  it("stops an account being flooded with emails, across both endpoints", async () => {
    const email = nextEmail();
    await signUpAndLogIn(app, email);

    // forgot-password and resend-verification both send mail to whatever
    // address was typed in, so they share one budget: five in total, not five
    // each.
    const asked: number[] = [];
    for (let i = 0; i < 3; i++) {
      asked.push(
        (
          await request(app)
            .post("/auth/forgot-password")
            .set("X-Forwarded-For", nextIp())
            .send({ email })
        ).status,
      );
    }
    for (let i = 0; i < 3; i++) {
      asked.push(
        (
          await request(app)
            .post("/auth/resend-verification")
            .set("X-Forwarded-For", nextIp())
            .send({ email })
        ).status,
      );
    }

    expect(asked.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
    expect(asked[5]).toBe(429);
  });
});
