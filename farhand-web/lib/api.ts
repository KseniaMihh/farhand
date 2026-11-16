/**
 * The one place that talks to the API, and the one place that reads an error.
 *
 * #4 gave every failure in the API the same JSON shape, so the client needs
 * exactly one function that understands it. The acceptance criterion for #93
 * says it plainly: handled once, in one place, rather than per request.
 *
 *     { "error": { "code": "VALIDATION_FAILED", "message": "…",
 *                  "requestId": "…", "details": [{ "field", "message" }] } }
 *
 * EVERY PATH IS RELATIVE, and that is load-bearing rather than tidy: requests
 * go to this app's own `/api/...`, which next.config.ts rewrites to the real
 * API. The browser therefore makes a same-site request and sends the session
 * cookie (decision 0031). An absolute API URL here would compile, work in
 * development against a local API, and quietly fail to stay signed in once
 * deployed.
 */

/** The error body the API promises (#4, docs/06-api-contract.md). */
export interface ApiError {
  code: string;
  message: string;
  /** Present on anything the API itself generated. Quote it when asking why. */
  requestId?: string;
  /** Only on `422`: which fields were wrong, and how. */
  details?: { field: string; message: string }[];
}

/**
 * A failed request, as something you can catch.
 *
 * The status is kept beside the body because the two answer different
 * questions — `401` means "sign in", `409` means "something changed under
 * you", and both can carry the same `code`.
 */
export class ApiFailure extends Error {
  constructor(
    readonly status: number,
    readonly error: ApiError,
  ) {
    super(error.message);
    this.name = "ApiFailure";
  }
}

/**
 * The code used when the failure did not come from the API at all.
 *
 * A free-plan service that has gone to sleep answers with the platform's own
 * HTML, a dropped connection answers with nothing, and a proxy in between can
 * answer `502` without ever reaching us. None of those carry our error shape,
 * and a client that assumed they did would throw a `TypeError` about JSON
 * while the real story — "the API did not answer" — is the thing worth
 * showing somebody.
 */
export const UNREACHABLE = "UNREACHABLE";

interface Options {
  /** Query parameters. `undefined` values are left out rather than sent empty. */
  query?: Record<string, string | number | undefined>;
  signal?: AbortSignal;
}

/** One page of a list endpoint: every one of them answers in this shape. */
export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

function urlFor(path: string, query: Options["query"]): string {
  const search = new URLSearchParams();

  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) search.set(key, String(value));
  }

  const queryString = search.toString();

  return `/api${path}${queryString === "" ? "" : `?${queryString}`}`;
}

/** Whether a parsed body is the API's error shape, rather than merely JSON. */
function errorIn(body: unknown): ApiError | null {
  if (typeof body !== "object" || body === null || !("error" in body)) {
    return null;
  }

  const error: unknown = body.error;

  if (
    typeof error !== "object" ||
    error === null ||
    typeof (error as { code?: unknown }).code !== "string" ||
    typeof (error as { message?: unknown }).message !== "string"
  ) {
    return null;
  }

  return error as ApiError;
}

/**
 * Reads something from the API.
 *
 * Throws `ApiFailure` for anything that is not a success, including the
 * failures that never reached the API. Nothing else in this app is allowed to
 * know that the error body has an `error` key.
 */
export async function apiGet<T>(
  path: string,
  options: Options = {},
): Promise<T> {
  let response: Response;

  try {
    response = await fetch(urlFor(path, options.query), {
      // The cookie is why the proxy exists. "same-origin" rather than
      // "include": after the rewrite there is no other origin, and asking for
      // credentials we do not need is how a client ends up working only while
      // third-party cookies are allowed.
      credentials: "same-origin",
      headers: { Accept: "application/json" },
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (cause) {
    // An abort is the caller's own doing — a screen that navigated away — and
    // must not be dressed up as the API failing.
    if (cause instanceof DOMException && cause.name === "AbortError")
      throw cause;

    throw new ApiFailure(0, {
      code: UNREACHABLE,
      message: "Could not reach Farhand. Check your connection and try again.",
    });
  }

  const body: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    throw new ApiFailure(
      response.status,
      errorIn(body) ?? {
        code: UNREACHABLE,
        message: `Farhand answered ${String(response.status)} without saying why.`,
      },
    );
  }

  return body as T;
}

/** The methods that carry a body. `GET` has `apiGet`; nothing here is a `PUT`
 *  by accident. */
export type SendMethod = "POST" | "PATCH" | "DELETE";

/**
 * Writes something to the API (#156).
 *
 * Everything `apiGet` is careful about applies unchanged — the relative path
 * that keeps the request same-site, `credentials: "same-origin"`, the single
 * reading of the error envelope, the abort that is not a failure. So this
 * must NOT be a second copy of it.
 *
 * TODO(#156): lift the fetch-and-read core out of `apiGet` into a private
 * `request(path, init, options)` and have both call it. Two near-identical
 * copies is how `credentials` ends up right on reads and wrong on writes,
 * which would fail in exactly one place — a deployed browser — and nowhere a
 * test would look.
 *
 * The core owes four things, and each is a place a second copy would drift:
 *
 *   0. `Content-Type: application/json` on anything with a body. Without it
 *      Express's JSON parser does not run, `req.body` is empty, and the API
 *      answers `422` naming every field as required — a failure that reads
 *      like a validation bug in the form and is nothing of the kind. It is
 *      first in this list because it is the one that costs an afternoon.
 *
 *   1. A `204` HAS NO BODY. `response.json()` on an empty one throws, which
 *      the `.catch(() => null)` already swallows — but the cast then hands
 *      back `null` dressed as a `T`. `POST /auth/logout` is the first
 *      endpoint here that does it, so the signature must return NOTHING for
 *      those rather than a lie the caller cannot see. Hence the `void`
 *      overload below.
 *   2. The error envelope, `requestId` included. It is the only thing that
 *      ties what somebody saw on a screen to a line in the API's log, so it
 *      survives all the way to the component that renders it (app/page.tsx
 *      already does this).
 *   3. "The server did not answer" is ITS OWN CASE, not a `4xx` with an
 *      invented number. A free-tier API cold-starting, a dropped connection
 *      and a proxy answering its own HTML all arrive here with no error
 *      shape; `UNREACHABLE` at status `0` keeps them distinguishable from
 *      anything the API itself decided, because they call for a different
 *      sentence — "try again" rather than "fix this field".
 *
 * TODO(#156): lift the fetch-and-read core out of `apiGet` into a private
 * `request(path, init, options)` and have both call it. Two near-identical
 * copies is how `credentials` ends up right on reads and wrong on writes,
 * which would fail in exactly one place — a deployed browser — and nowhere a
 * test would look.
 */
export function apiSend<T>(
  _method: SendMethod,
  _path: string,
  _body?: unknown,
  _options: Options = {},
): Promise<T> {
  // TODO(#156): the underscores come off when there is a body to write.
  return Promise.reject(new Error("apiSend is not written yet"));
}

/**
 * A write with nothing to read back — a `204`.
 *
 * TODO(#156): make this the real signature rather than `apiSend<void>`. A
 * caller that writes `apiSend<void>(…)` is asserting the response is empty;
 * a caller that writes `apiSendEmpty(…)` is asking for it, and the core
 * refuses a body that turns up anyway instead of discarding it quietly.
 */
export function apiSendEmpty(
  _method: SendMethod,
  _path: string,
  _body?: unknown,
  _options: Options = {},
): Promise<void> {
  // TODO(#156)
  return Promise.reject(new Error("apiSendEmpty is not written yet"));
}
