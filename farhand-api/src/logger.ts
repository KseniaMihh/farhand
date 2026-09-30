import { pino } from "pino";
import { env, isProduction, isTest } from "./env.js";

/**
 * Structured logging.
 *
 * In production this writes one JSON object per line, which is what log
 * aggregators (Cloud Logging, Datadog, Sentry) can actually search. In
 * development that's unreadable, so pino-pretty reformats it for humans.
 *
 * Use `logger.info({ dealId }, "message")` — the object first, then the text.
 * Searching for `dealId=123` beats grepping through interpolated strings.
 */
export const logger = pino({
  level: env.LOG_LEVEL,

  // Never log these, even if they arrive nested inside a request object.
  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers.cookie",
      "res.headers['set-cookie']",
      "*.password",
      "*.passwordHash",
      "*.tokenHash",
    ],
    censor: "[redacted]",
  },

  // Pretty-printing only in development, and NOT in tests (#70).
  //
  // A pino `transport` is not a formatting option: it starts a WORKER THREAD
  // and pipes the log through it. Under test that bought nothing — LOG_LEVEL
  // is `silent`, so the worker was started, handed nothing, and torn down —
  // once per test file, roughly thirty times a run.
  //
  // It also matched the symptom in #70: a test FILE failing while every test
  // in it passes alone, never the same file twice. Vitest attributes an
  // unhandled error to whichever file is loading when it arrives, and a worker
  // torn down at the wrong moment is a well-known source of exactly that.
  // Unproven as the cause — the flake was seen twice in weeks — but the worker
  // was pure cost either way, so there is nothing to trade off.
  ...(isProduction || isTest
    ? {}
    : {
        transport: {
          target: "pino-pretty",
          options: {
            colorize: true,
            translateTime: "HH:MM:ss",
            ignore: "pid,hostname",
          },
        },
      }),
});
