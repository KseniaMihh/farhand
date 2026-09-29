import type { ErrorRequestHandler, RequestHandler } from "express";
import { ZodError } from "zod";
import { HttpError } from "../errors.js";
import { env } from "../env.js";
import { reportError } from "../observability.js";
import { requestIdOf } from "./request-id.js";

/**
 * Runs when no route matched. Express 5 has no built-in 404 JSON response, so
 * without this the client gets Express's HTML error page.
 */
export const notFoundHandler: RequestHandler = (req, res) => {
  res
    .status(404)
    .json(
      errorBody(
        "NOT_FOUND",
        `Cannot ${req.method} ${req.path}`,
        requestIdOf(req),
      ),
    );
};

/**
 * The single place where an error becomes an HTTP response.
 *
 * Express recognises this as an error handler only because it takes FOUR
 * arguments — remove `_next` and Express silently treats it as normal
 * middleware and it stops working. That is the classic Express gotcha.
 *
 * Express 5 improved one thing significantly: errors thrown inside an `async`
 * route handler are forwarded here automatically. In Express 4 they were
 * swallowed and the request hung forever, which is why older code is full of
 * `catch (e) { next(e) }`.
 */
/**
 * express.json() throws before any route runs — unparseable body, or a body
 * over the size limit. These are client mistakes with a known status, but they
 * arrive as plain Errors carrying a `type` field, so they need recognising
 * explicitly or they get reported as a 500 server bug.
 */
interface BodyParserError {
  status: number;
  code: "BAD_REQUEST" | "PAYLOAD_TOO_LARGE";
  message: string;
}

function asBodyParserError(err: unknown): BodyParserError | null {
  if (!(err instanceof Error) || !("type" in err)) return null;

  switch ((err as { type: unknown }).type) {
    case "entity.parse.failed":
      return {
        status: 400,
        code: "BAD_REQUEST",
        message: "Request body is not valid JSON",
      };
    case "entity.too.large":
      return {
        status: 413,
        code: "PAYLOAD_TOO_LARGE",
        message: "Request body is too large",
      };
    default:
      return null;
  }
}

function errorBody(
  code: string,
  message: string,
  requestId: string | undefined,
  details?: unknown,
): {
  error: {
    code: string;
    message: string;
    requestId?: string;
    details?: unknown;
  };
} {
  return {
    error: {
      code,
      message,
      ...(requestId === undefined ? {} : { requestId }),
      ...(details !== undefined ? { details } : {}),
    },
  };
}

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  const requestId = requestIdOf(req);

  const bodyParserError = asBodyParserError(err);
  if (bodyParserError) {
    req.log.debug({ err }, bodyParserError.message);
    res
      .status(bodyParserError.status)
      .json(
        errorBody(bodyParserError.code, bodyParserError.message, requestId),
      );
    return;
  }

  if (err instanceof ZodError) {
    res.status(422).json(
      errorBody(
        "VALIDATION_FAILED",
        "Request validation failed",
        requestId,
        err.issues.map((issue) => ({
          field: issue.path.join(".") || "(root)",
          message: issue.message,
        })),
      ),
    );
    return;
  }

  if (err instanceof HttpError) {
    const log = err.status >= 500 ? req.log.error : req.log.debug;
    log.call(req.log, { err, code: err.code }, err.message);

    if (err.status >= 500) {
      reportError(err, { requestId, method: req.method, path: req.path });
    }

    res
      .status(err.status)
      .json(errorBody(err.code, err.message, requestId, err.details));
    return;
  }

  req.log.error({ err }, "Unhandled error");
  reportError(err, { requestId, method: req.method, path: req.path });

  res
    .status(500)
    .json(
      errorBody(
        "INTERNAL",
        "Something went wrong",
        requestId,
        env.NODE_ENV === "production"
          ? undefined
          : err instanceof Error
            ? err.message
            : String(err),
      ),
    );
};
