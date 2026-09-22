import express, { type RequestHandler } from "express";
import { pinoHttp } from "pino-http";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { prisma } from "../../src/db.js";
import { logger } from "../../src/logger.js";
import {
  requireActive,
  requireAuth,
  requireRole,
  requireVerified,
} from "../../src/middleware/auth.js";
import { errorHandler } from "../../src/middleware/error-handler.js";
import { signUpAndLogIn } from "../helpers/auth.js";

/**
 * requireVerified, requireActive and requireRole — issue #12.
 *
 * No real route uses these yet (needs arrive in #15, moderation in #27), so
 * each test builds a tiny app with one route behind exactly the middlewares
 * under test. The user is still created and logged in through the real app.
 *
 *   npm run test:watch -- guards
 */
const realApp = createApp();

/** A one-route app: GET /guarded, behind the given middlewares. */
function guarded(...middlewares: RequestHandler[]) {
  const app = express();
  // The error handler logs through req.log, which pino-http provides.
  app.use(pinoHttp({ logger }));
  app.get("/guarded", ...middlewares, (_req, res) => {
    res.json({ ok: true });
  });
  app.use(errorHandler);
  return app;
}

async function annaWith(
  data: Parameters<typeof prisma.user.update>[0]["data"],
) {
  const anna = await signUpAndLogIn(realApp, "anna@example.com");
  await prisma.user.update({ where: { id: anna.id }, data });
  return anna;
}

const DAY = 24 * 60 * 60 * 1000;

describe("requireVerified", () => {
  const app = guarded(requireAuth, requireVerified);

  it("stops a user who has not confirmed their email, with 403", async () => {
    const anna = await signUpAndLogIn(realApp, "anna@example.com");

    const response = await request(app)
      .get("/guarded")
      .set("Cookie", anna.cookie);

    expect(response.status).toBe(403);
  });

  it("lets a verified user through", async () => {
    const anna = await annaWith({ emailVerifiedAt: new Date() });

    const response = await request(app)
      .get("/guarded")
      .set("Cookie", anna.cookie);

    expect(response.status).toBe(200);
  });

  it("answers 401 first when nobody is logged in", async () => {
    const response = await request(app).get("/guarded");

    expect(response.status).toBe(401);
  });
});

describe("requireActive", () => {
  const app = guarded(requireAuth, requireActive);

  it("lets an active user through", async () => {
    const anna = await signUpAndLogIn(realApp, "anna@example.com");

    const response = await request(app)
      .get("/guarded")
      .set("Cookie", anna.cookie);

    expect(response.status).toBe(200);
  });

  it("stops a user suspended with no end date", async () => {
    const anna = await annaWith({ status: "SUSPENDED", suspendedUntil: null });

    const response = await request(app)
      .get("/guarded")
      .set("Cookie", anna.cookie);

    expect(response.status).toBe(403);
  });

  it("stops a user whose suspension ends tomorrow", async () => {
    const anna = await annaWith({
      status: "SUSPENDED",
      suspendedUntil: new Date(Date.now() + DAY),
    });

    const response = await request(app)
      .get("/guarded")
      .set("Cookie", anna.cookie);

    expect(response.status).toBe(403);
  });

  it("lets a user through once their suspension has ended", async () => {
    // Status still says SUSPENDED — nothing flips it back at midnight. The
    // date is what counts.
    const anna = await annaWith({
      status: "SUSPENDED",
      suspendedUntil: new Date(Date.now() - DAY),
    });

    const response = await request(app)
      .get("/guarded")
      .set("Cookie", anna.cookie);

    expect(response.status).toBe(200);
  });
});

describe("requireRole", () => {
  const moderatorsOnly = guarded(requireAuth, requireRole("MODERATOR"));
  const adminsOnly = guarded(requireAuth, requireRole("ADMIN"));

  it("stops a regular user from a moderator route, with 403", async () => {
    const anna = await signUpAndLogIn(realApp, "anna@example.com");

    const response = await request(moderatorsOnly)
      .get("/guarded")
      .set("Cookie", anna.cookie);

    expect(response.status).toBe(403);
  });

  it("lets a moderator through", async () => {
    const anna = await annaWith({ role: "MODERATOR" });

    const response = await request(moderatorsOnly)
      .get("/guarded")
      .set("Cookie", anna.cookie);

    expect(response.status).toBe(200);
  });

  it("lets an admin through a moderator route, since admins can do everything moderators can", async () => {
    const anna = await annaWith({ role: "ADMIN" });

    const response = await request(moderatorsOnly)
      .get("/guarded")
      .set("Cookie", anna.cookie);

    expect(response.status).toBe(200);
  });

  it("stops a moderator from an admin route", async () => {
    const anna = await annaWith({ role: "MODERATOR" });

    const response = await request(adminsOnly)
      .get("/guarded")
      .set("Cookie", anna.cookie);

    expect(response.status).toBe(403);
  });

  it("lets an admin through an admin route", async () => {
    const anna = await annaWith({ role: "ADMIN" });

    const response = await request(adminsOnly)
      .get("/guarded")
      .set("Cookie", anna.cookie);

    expect(response.status).toBe(200);
  });
});

describe("a guard used without requireAuth in front of it", () => {
  it("fails loudly with a 500 instead of guessing who is logged in", async () => {
    const forgotRequireAuth = guarded(requireVerified);

    const response = await request(forgotRequireAuth).get("/guarded");
    const body = response.body as { error: { details?: string } };

    expect(response.status).toBe(500);
    // Outside production the error handler includes the real message.
    expect(body.error.details).toContain("without requireAuth");
  });
});
