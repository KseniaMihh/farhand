import { pino } from "pino";
import { env, isProduction } from "./env.js";

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

  ...(isProduction
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
