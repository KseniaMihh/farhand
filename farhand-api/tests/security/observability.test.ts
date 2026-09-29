import express from "express";
import { pino } from "pino";
import { pinoHttp } from "pino-http";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/app.js";
import { errorHandler } from "../../src/middleware/error-handler.js";
import { requestIdFor } from "../../src/middleware/request-id.js";
import { HttpError } from "../../src/errors.js";
import { logger } from "../../src/logger.js";
import * as observability from "../../src/observability.js";

/**
 * Request ids and error reporting — issue #29.
 *
 * These tests are the specification. They fail until the TODOs in
 * src/middleware/request-id.ts, src/observability.ts and the error handler are
 * filled in.
 *
 *   npm run test:watch -- observability
 *
 * Nothing here talks to the network. `reportError` is spied on, and without a
 * SENTRY_DSN — which .env.test does not set — the real one sends nothing
 * anyway.
 */
const app = createApp();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("every answer carries an id", () => {
  it("puts one on a perfectly ordinary response", async () => {
    const response = await request(app).get("/health");

    expect(response.headers["x-request-id"]).toMatch(UUID);
  });

  it("puts one on answers no route ever saw", async () => {
    const missing = await request(app).get("/no-such-route");
    const refused = await request(app).post("/needs").send({});

    // A 404 and a 401 are exactly the answers somebody will ask about, so the
    // header goes on before the routes rather than inside them.
    expect(missing.headers["x-request-id"]).toMatch(UUID);
    expect(refused.headers["x-request-id"]).toMatch(UUID);
  });

  it("gives every request its own", async () => {
    const one = await request(app).get("/health");
    const two = await request(app).get("/health");

    expect(one.headers["x-request-id"]).not.toBe(two.headers["x-request-id"]);
  });
});

describe("an id the caller brought with them", () => {
  it("keeps it, so two systems can be searched with one string", async () => {
    const response = await request(app)
      .get("/health")
      .set("X-Request-Id", "frontend-7f3a9c21");

    // A proxy or the frontend may have started the trace already.
    expect(response.headers["x-request-id"]).toBe("frontend-7f3a9c21");
  });

  it("refuses one that could forge a log line", async () => {
    const response = await request(app)
      .get("/health")
      .set("X-Request-Id", "abc123def\\n2026-09-29 FATAL everything is fine");

    // It ends up in log lines and in a response header. A newline in either is
    // how one request writes a second, convincing entry.
    expect(response.headers["x-request-id"]).toMatch(UUID);
  });

  it("refuses one that is absurd, in either direction", async () => {
    const tooLong = await request(app)
      .get("/health")
      .set("X-Request-Id", "a".repeat(500));
    const tooShort = await request(app).get("/health").set("X-Request-Id", "x");

    expect(tooLong.headers["x-request-id"]).toMatch(UUID);
    expect(tooShort.headers["x-request-id"]).toMatch(UUID);
  });

  it("refuses one with characters that do not belong in a header", async () => {
    const response = await request(app)
      .get("/health")
      .set("X-Request-Id", "id-with-<script>-and-spaces");

    expect(response.headers["x-request-id"]).toMatch(UUID);
  });

  it("decides the same way when asked directly", () => {
    const req = (headers: Record<string, string>) =>
      ({ headers }) as unknown as Parameters<typeof requestIdFor>[0];
    const res = {} as unknown as Parameters<typeof requestIdFor>[1];

    expect(requestIdFor(req({ "x-request-id": "good-one_123" }), res)).toBe(
      "good-one_123",
    );
    expect(requestIdFor(req({}), res)).toMatch(UUID);
  });
});

describe("the same id, everywhere", () => {
  it("matches the header, the body and the log line", async () => {
    // A logger writing into memory, so the line can actually be read.
    const lines: string[] = [];
    const stream = {
      write(line: string) {
        lines.push(line);
      },
    };
    const inner = express();
    inner.use(
      pinoHttp({
        logger: pino({ level: "info" }, stream),
        genReqId: requestIdFor,
      }),
    );
    inner.get("/boom", () => {
      throw new Error("something internal");
    });
    inner.use(errorHandler);

    const response = await request(inner)
      .get("/boom")
      .set("X-Request-Id", "trace-abc-123");
    const body = response.body as { error: { requestId?: string } };

    expect(response.status).toBe(500);
    // The three places the issue asks for, holding one string.
    expect(body.error.requestId).toBe("trace-abc-123");
    expect(lines.join("")).toContain("trace-abc-123");
  });

  it("is on ordinary refusals too, not only on crashes", async () => {
    const missing = await request(app).get("/no-such-route");
    const validation = await request(app)
      .post("/auth/register")
      .send({ email: "not-an-email" });

    const missingBody = missing.body as { error: { requestId?: string } };
    const validationBody = validation.body as { error: { requestId?: string } };

    // "It says 409" is a sentence somebody will type into a support form. It
    // needs the same thread to pull as a 500 does.
    //
    // Both halves are pinned before they are compared: with neither present,
    // `undefined === undefined` and this test would pass against an endpoint
    // that had never heard of a request id.
    expect(missingBody.error.requestId).toMatch(UUID);
    expect(validationBody.error.requestId).toMatch(UUID);
    expect(missingBody.error.requestId).toBe(missing.headers["x-request-id"]);
    expect(validationBody.error.requestId).toBe(
      validation.headers["x-request-id"],
    );
  });
});

describe("what gets reported, and what does not", () => {
  function brokenApp() {
    const inner = express();
    inner.use(pinoHttp({ logger, genReqId: requestIdFor }));
    inner.get("/boom", () => {
      throw new Error("the database is on fire");
    });
    inner.use(errorHandler);
    return inner;
  }

  it("reports an unexpected error, with the id and the route", async () => {
    const reported = vi.spyOn(observability, "reportError");

    const response = await request(brokenApp())
      .get("/boom")
      .set("X-Request-Id", "trace-xyz-789");

    expect(response.status).toBe(500);
    expect(reported).toHaveBeenCalledTimes(1);
    expect(reported.mock.calls[0]?.[1]).toMatchObject({
      requestId: "trace-xyz-789",
      method: "GET",
      path: "/boom",
    });
  });

  it("says nothing about the client being wrong", async () => {
    const reported = vi.spyOn(observability, "reportError");

    await request(app).get("/no-such-route");
    await request(app).post("/needs").send({});
    await request(app).post("/auth/register").send({ email: "nope" });

    // A 404, a 401 and a failed validation are not incidents. A monitor that
    // pages somebody for a typo in a URL is muted within a week, and then it
    // is not a monitor.
    expect(reported).not.toHaveBeenCalled();
  });

  it("reports a 500 we raised on purpose", async () => {
    const reported = vi.spyOn(observability, "reportError");
    const inner = express();
    inner.use(pinoHttp({ logger, genReqId: requestIdFor }));
    inner.get("/deliberate", (_req, _res, next) => {
      // A real HttpError, deliberately: an anonymous error carrying a `status`
      // field falls through to the unhandled branch instead, and this test
      // would quietly be a second copy of the one above.
      next(new HttpError(503, "INTERNAL", "The database is unavailable"));
    });
    inner.use(errorHandler);

    const response = await request(inner).get("/deliberate");

    // We chose the status; we did not choose the failure.
    expect(response.status).toBe(503);
    expect(reported).toHaveBeenCalledTimes(1);
  });

  it("stays quiet about a 4xx we raised on purpose", async () => {
    const reported = vi.spyOn(observability, "reportError");
    const inner = express();
    inner.use(pinoHttp({ logger, genReqId: requestIdFor }));
    inner.get("/refused", (_req, _res, next) => {
      next(HttpError.conflict("This need is no longer open"));
    });
    inner.use(errorHandler);

    const response = await request(inner).get("/refused");

    expect(response.status).toBe(409);
    expect(reported).not.toHaveBeenCalled();
  });
});

describe("reporting stays off without somewhere to report to", () => {
  it("sends nothing when there is no DSN", () => {
    // .env.test sets none, which is what keeps the whole suite offline.
    expect(() => {
      observability.reportError(new Error("nowhere to go"), {
        requestId: "abc",
      });
    }).not.toThrow();
  });

  it("starts up quietly rather than failing, and says so", () => {
    const said = vi.spyOn(logger, "info");

    expect(() => {
      observability.initErrorReporting();
    }).not.toThrow();

    // Silence here is how somebody spends an afternoon wondering why
    // production reports nothing.
    const lines = said.mock.calls.map((call) => String(call.at(-1)));
    expect(lines.join(" ")).toMatch(/SENTRY_DSN|reporting is off/i);
  });
});
