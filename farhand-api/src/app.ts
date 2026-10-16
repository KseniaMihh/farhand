import express, { type Express } from "express";
import { pinoHttp } from "pino-http";
import { logger } from "./logger.js";
import { errorHandler, notFoundHandler } from "./middleware/error-handler.js";
import { limiters } from "./middleware/rate-limit.js";
import { echoRequestId, requestIdFor } from "./middleware/request-id.js";
import {
  crossOrigin,
  sameOriginWrites,
  securityHeaders,
} from "./middleware/security.js";
import { adminRouter } from "./routes/admin.js";
import { authRouter } from "./routes/auth.js";
import { conversationsRouter } from "./routes/conversations.js";
import { dealsRouter } from "./routes/deals.js";
import { filesRouter } from "./routes/files.js";
import { healthRouter } from "./routes/health.js";
import { helpsRouter } from "./routes/helps.js";
import { needsRouter } from "./routes/needs.js";
import { notificationsRouter } from "./routes/notifications.js";
import { profilesRouter } from "./routes/profiles.js";
import { prohibitedRouter } from "./routes/prohibited.js";
import { proposalsRouter } from "./routes/proposals.js";
import { reportsRouter } from "./routes/reports.js";

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

  // In production Render terminates HTTPS at its edge and forwards a plain
  // HTTP request here, so every connection Express sees comes from the proxy.
  // This tells Express to believe the X-Forwarded-* headers from exactly one
  // hop (docs/15-architecture.md).
  //
  // What depends on it is `req.ip`, and that is the rate limiters: without it
  // every caller in the world shares one bucket, so 20 login attempts per
  // address per 15 minutes becomes 20 for the whole of Farhand, and one person
  // with a script locks everybody out. The address recorded on each session
  // (routes/auth.ts, "logged in from…") would be the proxy's too.
  //
  // NOT the session cookie, despite what this comment used to claim: that is
  // written with plain res.cookie, which sets `Secure` without consulting
  // req.secure — unlike express-session, which refuses. The browser's own
  // connection really is HTTPS, so it stores the cookie either way (#100).
  //
  // 1 hop, not `true`: X-Forwarded-For is a header, and a header is written by
  // whoever sends the request. Trusting the whole chain lets a caller name any
  // address it likes and take a fresh bucket for every request.
  app.set("trust proxy", 1);

  // Don't advertise the framework. Free, and one less hint for a scanner.
  app.disable("x-powered-by");

  // One log line per request, with a generated request id, method, path,
  // status and duration. Attaches `req.log` for use inside handlers.
  app.use(pinoHttp({ logger, genReqId: requestIdFor }));

  // Straight after the logger, so the id is on every answer — including the
  // ones a limiter or a guard refuses before any route sees them.
  app.use(echoRequestId);

  // Headers first: they belong on every answer, including the ones that never
  // reach a route because a limiter or a guard refused them.
  app.use(securityHeaders);

  // Then who may call us at all. cors() answers the browser's preflight here,
  // before anything below can refuse an OPTIONS request it was never meant to
  // see.
  app.use(crossOrigin);

  // A ceiling for one address, above the specific limits on login and
  // messages. Before the body parser, so a flood costs us no parsing.
  app.use(limiters.globalByIp);

  // Parse JSON bodies. The limit is deliberate: without it a single large
  // request can chew through memory. Image uploads will not go through here.
  app.use(express.json({ limit: "100kb" }));

  // And last before the routes: a write has to prove it came from our own
  // site. After the body parser only because it reads nothing from the body —
  // it is the headers it cares about (docs/10-decisions/0007).
  app.use(sameOriginWrites);

  app.use(healthRouter);
  app.use(authRouter);
  app.use(profilesRouter);
  app.use(notificationsRouter);
  app.use(prohibitedRouter);
  app.use(needsRouter);
  app.use(helpsRouter);
  app.use(proposalsRouter);
  app.use(conversationsRouter);
  app.use(dealsRouter);
  app.use(reportsRouter);
  app.use(filesRouter);
  app.use(adminRouter);

  // Both of these must stay at the bottom, in this order.
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
