import express, { type Express } from "express";
import { pinoHttp } from "pino-http";
import { logger } from "./logger.js";
import { errorHandler, notFoundHandler } from "./middleware/error-handler.js";
import { authRouter } from "./routes/auth.js";
import { conversationsRouter } from "./routes/conversations.js";
import { dealsRouter } from "./routes/deals.js";
import { healthRouter } from "./routes/health.js";
import { helpsRouter } from "./routes/helps.js";
import { needsRouter } from "./routes/needs.js";
import { proposalsRouter } from "./routes/proposals.js";

/**
 * Builds the Express app.
 *
 * This is a function returning an app, not a running server — `server.ts` is
 * what opens the port. Keeping them apart means the tests can import the app
 * and make requests against it (with Supertest) without binding a real port,
 * which is what makes running tests in parallel possible later.
 *
 * ORDER MATTERS in Express: middleware runs top to bottom, so the logger has to
 * be registered before the routes it logs, and the error handler has to come
 * last or it will never see the errors.
 */
export function createApp(): Express {
  const app = express();

  // We will sit behind a reverse proxy in production (Cloud Run, nginx).
  // Without this, req.ip is the proxy's address and "secure" cookies are not
  // recognised as secure — which quietly breaks auth. Set to 1 hop, not `true`:
  // trusting every hop lets a client spoof its own IP via X-Forwarded-For.
  app.set("trust proxy", 1);

  // Don't advertise the framework. Free, and one less hint for a scanner.
  app.disable("x-powered-by");

  // One log line per request, with a generated request id, method, path,
  // status and duration. Attaches `req.log` for use inside handlers.
  app.use(pinoHttp({ logger }));

  // Parse JSON bodies. The limit is deliberate: without it a single large
  // request can chew through memory. Image uploads will not go through here.
  app.use(express.json({ limit: "100kb" }));

  app.use(healthRouter);
  app.use(authRouter);
  app.use(needsRouter);
  app.use(helpsRouter);
  app.use(proposalsRouter);
  app.use(conversationsRouter);
  app.use(dealsRouter);

  // Both of these must stay at the bottom, in this order.
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
