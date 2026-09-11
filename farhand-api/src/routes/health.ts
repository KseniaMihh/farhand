import { Router } from "express";
import { pingDatabase } from "../db.js";

export const healthRouter: Router = Router();

/**
 * Liveness: is the process up and responding at all?
 *
 * Deliberately checks nothing else. A container platform uses this to decide
 * whether to restart the process, and restarting the API will not fix a
 * database that is down.
 */
healthRouter.get("/health", (_req, res) => {
  res.json({ status: "ok", uptime: Math.round(process.uptime()) });
});

/**
 * Readiness: can this instance actually serve traffic?
 *
 * This one does hit the database, so a load balancer can stop sending requests
 * to an instance that has lost its connection. Returns 503 rather than 500:
 * "not ready right now", not "this request was broken".
 */
healthRouter.get("/health/ready", async (_req, res) => {
  const startedAt = performance.now();

  try {
    await pingDatabase();
    res.json({
      status: "ok",
      database: { status: "ok", latencyMs: Math.round(performance.now() - startedAt) },
    });
  } catch (error) {
    // Handled here rather than thrown, because a failing dependency check is a
    // normal, expected answer from this endpoint — not an unhandled error.
    res.status(503).json({
      status: "degraded",
      database: {
        status: "unreachable",
        message: error instanceof Error ? error.message : "Unknown error",
      },
    });
  }
});
