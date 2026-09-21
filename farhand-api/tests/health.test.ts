import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";

/**
 * The first API-level tests, and the proof that the harness works end to end:
 * a real Express app, a real database, real HTTP.
 *
 * `createApp()` returns an app without opening a port — Supertest binds an
 * ephemeral one per request and closes it again. That is why `src/app.ts` is
 * separate from `src/server.ts`, and why these tests need no setup or teardown
 * of their own.
 */
const app = createApp();

/**
 * Supertest types `response.body` as `any`, which would spread untyped values
 * through every assertion. Naming the shapes here costs two lines and makes the
 * test double as a written statement of what each endpoint returns.
 */
interface HealthBody {
  status: string;
  uptime: number;
}

interface ReadyBody {
  status: string;
  database: { status: string; latencyMs?: number };
}

interface ErrorBody {
  error: { code: string; message: string };
}

describe("GET /health", () => {
  it("reports the process as alive", async () => {
    const response = await request(app).get("/health");
    const body = response.body as HealthBody;

    expect(response.status).toBe(200);
    expect(body.status).toBe("ok");
  });

  it("reports uptime in whole seconds", async () => {
    const response = await request(app).get("/health");
    const body = response.body as HealthBody;

    expect(body.uptime).toBeTypeOf("number");
    expect(body.uptime).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(body.uptime)).toBe(true);
  });
});

describe("GET /health/ready", () => {
  it("reports the database as reachable", async () => {
    const response = await request(app).get("/health/ready");
    const body = response.body as ReadyBody;

    expect(response.status).toBe(200);
    expect(body.status).toBe("ok");
    expect(body.database.status).toBe("ok");
  });

  it("measures how long the database took to answer", async () => {
    const response = await request(app).get("/health/ready");
    const body = response.body as ReadyBody;

    expect(body.database.latencyMs).toBeTypeOf("number");
  });
});

describe("unknown routes", () => {
  it("answer with the shared error shape, not Express's HTML page", async () => {
    const response = await request(app).get("/does-not-exist");
    const body = response.body as ErrorBody;

    expect(response.status).toBe(404);
    expect(body.error.code).toBe("NOT_FOUND");
    expect(body.error.message).toContain("/does-not-exist");
  });
});
