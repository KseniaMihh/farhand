import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { RequestHandler } from "express";

/**
 * One id per request, in four places.
 *
 * A person says "it failed at about two o'clock". There were nine hundred
 * requests in that minute. The id is what turns that into one line: it goes in
 * every log line for the request, in the `X-Request-Id` response header, in the
 * body of any error, and on the report sent to Sentry — so a screenshot of an
 * error message leads straight to the log line and the stack trace behind it.
 */

/** The header, spelled once. */
export const REQUEST_ID_HEADER = "X-Request-Id";

/**
 * The id for a request: the caller's, if it looks sane, otherwise a new one.
 */
const VALID_REQUEST_ID = /^[A-Za-z0-9_-]{8,128}$/;

export function requestIdFor(
  req: IncomingMessage,
  _res: ServerResponse,
): string {
  const incoming = req.headers["x-request-id"];
  const candidate = Array.isArray(incoming) ? incoming[0] : incoming;

  if (candidate !== undefined && VALID_REQUEST_ID.test(candidate)) {
    return candidate;
  }

  return randomUUID();
}

/**
 * The id pino-http attached, if it is one.
 *
 * pino-http types `req.id` as `number | string | object`, because it lets you
 * return anything from `genReqId`. Ours always returns a string, but `String()`
 * on that type would quietly render `[object Object]` if that ever stopped
 * being true — so the narrowing is real rather than a cast, and the places
 * that use the id decide what to do when there is not one.
 */
export function requestIdOf(req: { id?: unknown }): string | undefined {
  return typeof req.id === "string" ? req.id : undefined;
}

export const echoRequestId: RequestHandler = (req, res, next) => {
  const id = requestIdOf(req);
  if (id !== undefined) {
    res.setHeader(REQUEST_ID_HEADER, id);
  }
  next();
};
