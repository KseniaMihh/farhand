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

  static unauthorized(message = "Authentication required"): HttpError {
    return new HttpError(401, "UNAUTHORIZED", message);
  }

  static forbidden(message = "You do not have access to this resource"): HttpError {
    return new HttpError(403, "FORBIDDEN", message);
  }

  static notFound(message = "Resource not found"): HttpError {
    return new HttpError(404, "NOT_FOUND", message);
  }

  static conflict(message: string, details?: unknown): HttpError {
    return new HttpError(409, "CONFLICT", message, details);
  }
}
