import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { env } from "../src/env.js";

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
  commit: string | null;
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

/**
 * How the deploy job tells the new version from the old one (#96). Render
 * builds for minutes after the hook is called, and all that time the old
 * version answers /health/ready with a cheerful 200. Only the commit says which
 * one is talking.
 */
describe("GET /health reports the commit it runs", () => {
  // Render sets this on every deploy, and nothing sets it here — but a
  // developer's shell might, so it is saved and restored rather than assumed.
  const original = env.RENDER_GIT_COMMIT;

  afterEach(() => {
    env.RENDER_GIT_COMMIT = original;
  });

  it("is the commit the platform deployed, exactly as given", async () => {
    const sha = "4f2a9c1e0b7d3a5f6e8c9b0a1d2e3f4a5b6c7d8e";
    env.RENDER_GIT_COMMIT = sha;

    const response = await request(app).get("/health");
    const body = response.body as HealthBody;

    expect(response.status).toBe(200);
    expect(body.commit).toBe(sha);
  });

  it("follows the platform, rather than whatever was set at startup", async () => {
    // Two values in one test: an implementation that captured the commit
    // once, at import, would report the first one both times.
    env.RENDER_GIT_COMMIT = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    await request(app).get("/health");

    env.RENDER_GIT_COMMIT = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const body = (await request(app).get("/health")).body as HealthBody;

    expect(body.commit).toBe("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
  });

  it("is null, not missing, when nothing set one", async () => {
    // A missing key and a null one look the same to a careless reader. CI's
    // check compares the field to a SHA, so "absent" must be stated, not
    // implied by omission.
    env.RENDER_GIT_COMMIT = undefined;

    const body = (await request(app).get("/health")).body as HealthBody;

    expect(body).toHaveProperty("commit");
    expect(body.commit).toBeNull();
  });

  it("is reported by liveness only, not by readiness", async () => {
    // Readiness answers one question, whether the database can be reached.
    // The commit is about the process, so it lives with the process check.
    env.RENDER_GIT_COMMIT = "cccccccccccccccccccccccccccccccccccccccc";

    // First that the commit is there to be reported at all — otherwise an API
    // that reports it nowhere passes this test for the wrong reason.
    const live = (await request(app).get("/health")).body as HealthBody;
    expect(live.commit).toBe("cccccccccccccccccccccccccccccccccccccccc");

    const ready = (await request(app).get("/health/ready")).body as object;
    expect(ready).not.toHaveProperty("commit");
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
