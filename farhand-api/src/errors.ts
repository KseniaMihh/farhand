/**
 * The API's error contract.
 *
 * Every failure — expected or not — leaves the API as the same JSON shape:
 *
 *   { "error": { "code": "NOT_FOUND", "message": "Need not found" } }
 *
 * A stable shape is what lets the frontend write one error handler instead of
 * guessing per endpoint. `code` is for the code to branch on, `message` is for
 * a human to read.
 */
export type ErrorCode =
  | "BAD_REQUEST"
  | "VALIDATION_FAILED"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  /**
   * A posting was ticked against a prohibited list that is no longer the
   * current one (#87). Its own code rather than plain `CONFLICT` because a
   * client can do something specific about it — show the new list and ask
   * again — and `details` carries that list.
   */
  | "PROHIBITED_LIST_CHANGED"
  /**
   * It was here and it is gone, and asking again is the fix (#89). A `404`
   * would say the wrong thing about a data export that expired on purpose:
   * that it never existed, when in fact it was built, downloaded or not, and
   * destroyed on a clock.
   */
  | "GONE"
  | "PAYLOAD_TOO_LARGE"
  | "TOO_MANY_REQUESTS"
  | "INTERNAL";

/**
 * An error we threw on purpose, with an HTTP status we chose.
 *
 * Anything that is NOT an HttpError is by definition a bug we did not
 * anticipate, and the error handler treats it accordingly: 500, and the real
 * message never reaches the client.
 */
export class HttpError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly details?: unknown;

  constructor(
    status: number,
    code: ErrorCode,
    message: string,
    details?: unknown,
  ) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    if (details !== undefined) this.details = details;
  }

  static badRequest(message: string, details?: unknown): HttpError {
    return new HttpError(400, "BAD_REQUEST", message, details);
  }

  /**
   * The request was well-formed but its contents are wrong — the same answer a
   * failed Zod parse produces, for the cases a schema cannot decide on its own.
   *
   * A deal transition is one: which fields it needs depends on where the deal
   * is coming from, which the schema does not know. See docs/04-deal-lifecycle.
   */
  static validationFailed(message: string, details?: unknown): HttpError {
    return new HttpError(422, "VALIDATION_FAILED", message, details);
  }

  static unauthorized(message = "Authentication required"): HttpError {
    return new HttpError(401, "UNAUTHORIZED", message);
  }

  static forbidden(
    message = "You do not have access to this resource",
  ): HttpError {
    return new HttpError(403, "FORBIDDEN", message);
  }

  static notFound(message = "Resource not found"): HttpError {
    return new HttpError(404, "NOT_FOUND", message);
  }

  /**
   * It existed, it does not now, and that was the plan (#89). Distinct from
   * `404` because the answer tells a caller to ask again rather than to stop.
   */
  static gone(message: string): HttpError {
    return new HttpError(410, "GONE", message);
  }

  static tooManyRequests(
    message = "Too many requests, please try again later",
  ): HttpError {
    return new HttpError(429, "TOO_MANY_REQUESTS", message);
  }

  static conflict(message: string, details?: unknown): HttpError {
    return new HttpError(409, "CONFLICT", message, details);
  }

  /**
   * The prohibited list changed between somebody reading it and posting
   * against it (#87). A `409`, because the request was right when it was
   * written and the world moved — and the new list travels with the refusal,
   * so the next attempt can be an informed one.
   */
  static prohibitedListChanged(list: unknown): HttpError {
    return new HttpError(
      409,
      "PROHIBITED_LIST_CHANGED",
      "The prohibited list has changed since you read it",
      list,
    );
  }
}
