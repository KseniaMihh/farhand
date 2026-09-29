import * as Sentry from "@sentry/node";
import { env } from "./env.js";
import { logger } from "./logger.js";

/**
 * Where errors go when nobody is watching the terminal.
 *
 * ONE FILE KNOWS ABOUT SENTRY. Everything else calls `reportError`, which is
 * why this exists at all: an error handler that imports a vendor's SDK is an
 * error handler that cannot be tested without mocking one, and a project that
 * mentions Sentry in fifteen files is a project that will never change
 * provider. The seam costs ten lines and buys both.
 *
 * NOTHING LEAVES THE MACHINE WITHOUT A DSN. No `SENTRY_DSN`, no initialisation,
 * no network — which is the state in development, in the test suite, and on any
 * clone somebody makes of this repository. Reporting is a production concern;
 * failing to report must never be one.
 */

/** What we can say about an error beyond the error itself. */
export interface ErrorContext {
  requestId?: string | undefined;
  method?: string | undefined;
  path?: string | undefined;
  userId?: string | undefined;
}

/**
 * Starts error reporting, once, at boot.
 */
export function initErrorReporting(): void {
  if (!env.SENTRY_DSN) {
    logger.info("Error reporting is off (no SENTRY_DSN)");
    return;
  }

  Sentry.init({
    dsn: env.SENTRY_DSN,
    environment: env.NODE_ENV,
  });

  logger.info({ environment: env.NODE_ENV }, "Error reporting started");
}

/**
 * Reports an error that nobody asked for.
 */
export function reportError(error: unknown, context: ErrorContext): void {
  if (!env.SENTRY_DSN) return;

  try {
    Sentry.withScope((scope) => {
      if (context.requestId !== undefined) {
        scope.setTag("requestId", context.requestId);
      }
      if (context.method !== undefined) {
        scope.setTag("method", context.method);
      }
      if (context.path !== undefined) {
        scope.setTag("path", context.path);
      }
      if (context.userId !== undefined) {
        scope.setTag("userId", context.userId);
      }

      Sentry.captureException(error);
    });
  } catch (reportingError) {
    // A monitoring outage must not turn a 500 into a crash.
    logger.error(
      { err: reportingError },
      "Failed to report an error to Sentry",
    );
  }
}
