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
 * Takes the request's headers off an event on its way out (#164).
 *
 * Exported so it can be tested as itself. Asserting on what Sentry's own
 * integrations do would be a test of somebody else's library; asserting that
 * this function removes what it is given is a test of ours, and it is the
 * thing standing between a secret and a third party either way.
 */
export function stripRequestHeaders<T extends Sentry.ErrorEvent>(event: T): T {
  if (event.request?.headers) {
    delete event.request.headers;
  }
  return event;
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

    /**
     * THE SECOND EXIT A SECRET HAS (#164), and it was already open.
     *
     * `requestDataIntegration` is one of @sentry/node's DEFAULT integrations,
     * and in version 11 its defaults are `httpHeaders: { request: true }` and
     * `cookies: true`. So an error report carried the request's headers — the
     * session cookie among them — before #164 added a secret to that list.
     * Redacting a header in logger.ts closes the log and leaves this open.
     *
     * Everything we actually want is in the context `reportError` passes
     * deliberately: a request id, a method, a path, a user id. None of it
     * needs a header, a cookie or a body, so none of them are collected.
     *
     * `userInfo` goes too: it populates `user.*` from instrumentation, and
     * what that means here is the caller's IP address.
     */
    dataCollection: {
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
      userInfo: false,
    },

    /**
     * And the same thing again, by hand, because the option above is somebody
     * else's API and has already changed once: this file said
     * `sendDefaultPii: false` for about ten minutes before the compiler
     * pointed out that version 11 renamed it. A setting that quietly becomes
     * a no-op on upgrade is precisely the failure this project keeps writing
     * down, and a key that is spelled wrong is indistinguishable from one
     * that works until something leaks.
     *
     * This half is ours, so it can be tested as ours.
     */
    beforeSend: stripRequestHeaders,
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
