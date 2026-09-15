import type { ErrorRequestHandler, RequestHandler } from "express";
import { ZodError } from "zod";
import { HttpError } from "../errors.js";
import { isProduction } from "../env.js";

/**
 * Runs when no route matched. Express 5 has no built-in 404 JSON response, so
 * without this the client gets Express's HTML error page.
 */
export const notFoundHandler: RequestHandler = (req, res) => {
  res.status(404).json({
    error: {
      code: "NOT_FOUND",
      message: `Cannot ${req.method} ${req.path}`,
    },
  });
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

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  const bodyParserError = asBodyParserError(err);
  if (bodyParserError) {
    req.log.debug({ err }, bodyParserError.message);
    res.status(bodyParserError.status).json({
      error: { code: bodyParserError.code, message: bodyParserError.message },
    });
    return;
  }

  // Zod threw: the request body/query didn't match the schema. That's the
  // client's fault, so 422 with the specific field problems.
  if (err instanceof ZodError) {
    res.status(422).json({
      error: {
        code: "VALIDATION_FAILED",
        message: "Request validation failed",
        details: err.issues.map((issue) => ({
          field: issue.path.join(".") || "(root)",
          message: issue.message,
        })),
      },
    });
    return;
  }

  // An error we raised deliberately, with a status we chose.
  if (err instanceof HttpError) {
    // 5xx we caused is still a bug worth logging loudly; 4xx is just the client
    // being wrong, so it stays at debug level and doesn't pollute the logs.
    const log = err.status >= 500 ? req.log.error : req.log.debug;
    log.call(req.log, { err, code: err.code }, err.message);

    res.status(err.status).json({
      error: {
        code: err.code,
        message: err.message,
        ...(err.details !== undefined ? { details: err.details } : {}),
      },
    });
    return;
  }

  // Anything else is unanticipated: a real bug. Log the whole thing for us,
  // but never leak the message or stack to the client — internal errors have a
  // habit of containing table names, file paths and connection strings.
  req.log.error({ err }, "Unhandled error");

  res.status(500).json({
    error: {
      code: "INTERNAL",
      message: "Something went wrong",
      ...(isProduction
        ? {}
        : { details: err instanceof Error ? err.message : String(err) }),
    },
  });
};
