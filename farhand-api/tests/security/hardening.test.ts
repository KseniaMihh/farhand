import express from "express";
import { pinoHttp } from "pino-http";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { env } from "../../src/env.js";
import { logger } from "../../src/logger.js";
import { TRUSTED_PROXY_HOPS } from "../../src/middleware/caller-address.js";
import { errorHandler } from "../../src/middleware/error-handler.js";
import { RATE_LIMITS } from "../../src/middleware/rate-limit.js";

/**
 * Security hardening — issue #28.
 *
 * These tests are the specification. The CSRF ones fail until the TODO in
 * src/middleware/security.ts is filled in; the rest describe wiring that is
 * already in place, and exist so that removing it is noticed.
 *
 *   npm run test:watch -- hardening
 *
 * Like the rate-limit files, this one turns settings on for itself: .env.test
 * has the origin check off, because four hundred other tests post without a
 * browser to set an Origin header.
 */
const app = createApp();

describe("headers on every answer", () => {
  it("tells the browser not to guess what a response is", async () => {
    const response = await request(app).get("/health");

    // A JSON body sniffed as HTML is how a reflected value becomes a script.
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("refuses to be put in a frame", async () => {
    const response = await request(app).get("/health");

    expect(response.headers["x-frame-options"]?.toUpperCase()).toBe(
      "SAMEORIGIN",
    );
  });

  it("does not leak our URLs to other sites", async () => {
    const response = await request(app).get("/health");

    expect(response.headers["referrer-policy"]).toBeTruthy();
  });

  it("still does not say what it is built with", async () => {
    const response = await request(app).get("/health");

    expect(response.headers["x-powered-by"]).toBeUndefined();
  });

  it("puts them on refusals too, not just on answers", async () => {
    const response = await request(app).get("/no-such-route");

    // The headers belong on everything, including what a guard or a limiter
    // turned away — which is why they are registered before the routes.
    expect(response.status).toBe(404);
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
  });
});

describe("which website may call us", () => {
  it("allows the frontend, with cookies", async () => {
    const response = await request(app)
      .get("/health")
      .set("Origin", env.APP_ORIGIN);

    expect(response.headers["access-control-allow-origin"]).toBe(
      env.APP_ORIGIN,
    );
    // Without this the browser will not send the session cookie at all.
    expect(response.headers["access-control-allow-credentials"]).toBe("true");
  });

  it("allows nobody else", async () => {
    const response = await request(app)
      .get("/health")
      .set("Origin", "https://evil.example");

    // No header means the browser refuses to hand the answer to that page.
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("never answers with a wildcard, because cookies are allowed", async () => {
    const response = await request(app)
      .get("/health")
      .set("Origin", env.APP_ORIGIN);

    // "*" together with credentials is forbidden by the specification, and
    // would mean any page on the internet could act as whoever is signed in.
    expect(response.headers["access-control-allow-origin"]).not.toBe("*");
  });

  it("answers the browser's preflight before anything can refuse it", async () => {
    const response = await request(app)
      .options("/needs")
      .set("Origin", env.APP_ORIGIN)
      .set("Access-Control-Request-Method", "POST");

    expect(response.status).toBeLessThan(300);
    expect(response.headers["access-control-allow-methods"]).toContain("POST");
  });
});

describe("a ceiling for one address", () => {
  beforeEach(() => {
    env.RATE_LIMIT_ENABLED = true;
  });

  afterEach(() => {
    env.RATE_LIMIT_ENABLED = false;
  });

  it("stops one machine hammering the API, whichever endpoint it picks", async () => {
    // A fresh app, so this test's budget is its own: the limiter's counters
    // live in memory and outlive a single test file.
    const inner = express();
    inner.set("trust proxy", TRUSTED_PROXY_HOPS);
    inner.use(pinoHttp({ logger }));
    const { limiters } = await import("../../src/middleware/rate-limit.js");
    inner.use(limiters.globalByIp);
    inner.get("/anything", (_req, res) => {
      res.json({ ok: true });
    });
    inner.use(errorHandler);

    const ip = "198.51.100.200";
    const statuses: number[] = [];
    for (let i = 0; i < RATE_LIMITS.global.perIp + 1; i++) {
      statuses.push(
        (await request(inner).get("/anything").set("X-Forwarded-For", ip))
          .status,
      );
    }

    expect(statuses.filter((status) => status === 200)).toHaveLength(
      RATE_LIMITS.global.perIp,
    );
    expect(statuses.at(-1)).toBe(429);
  }, 60_000);

  it("is actually mounted in front of the real routes", async () => {
    // The test above builds its own app, so it proves the limiter counts —
    // not that anything uses it. This asks the real app, and the budget
    // headers are the cheapest proof that a request passed through it.
    const response = await request(app)
      .get("/health")
      .set("X-Forwarded-For", "198.51.100.201");

    expect(response.status).toBe(200);
    const headers = Object.keys(response.headers).join(" ").toLowerCase();
    expect(headers).toMatch(/ratelimit/);
  });

  it("is generous enough that a person browsing never sees it", () => {
    // Three hundred a minute is roughly five a second, sustained. The specific
    // limits on login and messages are the ones that stop an attack; this is
    // only a ceiling.
    expect(RATE_LIMITS.global.perIp).toBeGreaterThanOrEqual(120);
  });
});

describe("what a production error says", () => {
  afterEach(() => {
    env.NODE_ENV = "test";
  });

  /** An app with one route that throws something with a revealing message. */
  function brokenApp() {
    const inner = express();
    inner.use(pinoHttp({ logger }));
    inner.get("/boom", () => {
      throw new Error(
        "connect ECONNREFUSED 10.0.0.5:5432 for user farhand_admin",
      );
    });
    inner.use(errorHandler);
    return inner;
  }

  it("says nothing about what went wrong", async () => {
    env.NODE_ENV = "production";

    const response = await request(brokenApp()).get("/boom");
    const body = response.body as {
      error: { code: string; message: string; details?: unknown };
    };

    expect(response.status).toBe(500);
    expect(body.error.code).toBe("INTERNAL");
    expect(body.error.message).toBe("Something went wrong");
    // No host, no port, no user, no table name, no stack.
    expect(body.error.details).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("ECONNREFUSED");
    expect(JSON.stringify(body)).not.toContain("farhand_admin");
    expect(JSON.stringify(body)).not.toContain("10.0.0.5");
  });

  it("still helps while you are developing", async () => {
    env.NODE_ENV = "development";

    const response = await request(brokenApp()).get("/boom");
    const body = response.body as { error: { details?: unknown } };

    // The same information, to the person who can act on it.
    expect(String(body.error.details)).toContain("ECONNREFUSED");
  });

  it("never sends a stack, in any environment", async () => {
    for (const mode of ["production", "development"] as const) {
      env.NODE_ENV = mode;

      const response = await request(brokenApp()).get("/boom");

      expect(JSON.stringify(response.body)).not.toContain("at Object");
      expect(JSON.stringify(response.body)).not.toContain(".ts:");
    }
  });
});
