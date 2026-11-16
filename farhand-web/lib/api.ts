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
 * Nothing came back, and nothing was supposed to.
 *
 * A symbol rather than `null` or `undefined`, because both of those are also
 * valid JSON bodies: `null` is what a failed parse already produces here, and
 * the whole point of this value is to be distinguishable from one.
 */
const NO_BODY = Symbol("no body");

/**
 * One request, and the only place in this app that calls `fetch`.
 *
 * Both `apiGet` and `apiSend` go through here, which is the point. Two
 * near-identical copies is how `credentials` ends up right on reads and wrong
 * on writes — and that would fail in exactly one place, a deployed browser,
 * and nowhere a test would look.
 *
 * Returns the parsed body, or `NO_BODY` when the status says there is none.
 * Throws `ApiFailure` for everything that is not a success, including the
 * failures that never reached the API; lets an `AbortError` through as
 * itself.
 */
async function request(
  method: string,
  path: string,
  body: unknown,
  options: Options,
): Promise<unknown> {
  const headers: Record<string, string> = { Accept: "application/json" };

  // THE HEADER THAT COSTS AN AFTERNOON WHEN IT IS MISSING: without it
  // Express's JSON parser does not run, `req.body` is empty, and the API
  // answers 422 naming every field as required — which reads like a bug in
  // the form and is nothing of the kind.
  //
  // Only when there is something to describe. Announcing a JSON body that is
  // not there is a small lie, and some proxies treat a declared body of
  // length zero as a parse error.
  if (body !== undefined) headers["Content-Type"] = "application/json";

  let response: Response;

  try {
    response = await fetch(urlFor(path, options.query), {
      method,
      // The cookie is why the proxy exists. "same-origin" rather than
      // "include": after the rewrite there is no other origin, and asking for
      // credentials we do not need is how a client ends up working only while
      // third-party cookies are allowed.
      credentials: "same-origin",
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
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

  // Decided by the STATUS, not by whether parsing happened to fail. A 204
  // has no body by definition, and `response.json()` on an empty one
  // rejects; reading "it did not parse" as "it was empty" would also call a
  // truncated answer empty, which is a different thing entirely.
  const empty = response.status === 204 || response.status === 205;
  const parsed: unknown = empty
    ? null
    : await response.json().catch(() => null);

  if (!response.ok) {
    throw new ApiFailure(
      response.status,
      // `errorIn` keeps `requestId` — the only thing tying what somebody saw
      // on a screen to a line in the API's log. A body that is not our shape
      // at all (a proxy's HTML, a sleeping platform's error page) is
      // UNREACHABLE: it did not come from anything that read the request.
      errorIn(parsed) ?? {
        code: UNREACHABLE,
        message: `Farhand answered ${String(response.status)} without saying why.`,
      },
    );
  }

  return empty ? NO_BODY : parsed;
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
  const body = await request("GET", path, undefined, options);

  if (body === NO_BODY) {
    throw new Error(`GET ${path} answered with no body, and one was expected.`);
  }

  return body as T;
}

/** The methods that carry a body. `GET` has `apiGet`; nothing here is a `PUT`
 *  by accident. */
export type SendMethod = "POST" | "PATCH" | "DELETE";

/**
 * Writes something to the API, and reads what comes back (#156).
 *
 * Everything `apiGet` is careful about applies unchanged, because it is the
 * same `request` underneath: the relative path that keeps the request
 * same-site, the cookie, the single reading of the error envelope, the abort
 * that is not a failure.
 */
export async function apiSend<T>(
  method: SendMethod,
  path: string,
  body?: unknown,
  options: Options = {},
): Promise<T> {
  const answer = await request(method, path, body, options);

  // Refused rather than returned. The quiet version of this bug is the
  // reason the symbol exists: hand back the failed parse's `null`, cast it
  // to `T`, and the caller holds a value the type system swears is there and
  // the runtime says is not — a crash two screens away from the mistake.
  if (answer === NO_BODY) {
    throw new Error(
      `${method} ${path} answered with no body. Use apiSendEmpty for a write that returns nothing.`,
    );
  }

  return answer as T;
}

/**
 * A write with nothing to read back — a `204`, like `POST /auth/logout`.
 *
 * Separate from `apiSend<void>` on purpose. A caller writing `apiSend<void>`
 * is ASSERTING the response is empty; a caller writing `apiSendEmpty` is
 * asking for it, and gets told when it is not.
 */
export async function apiSendEmpty(
  method: SendMethod,
  path: string,
  body?: unknown,
  options: Options = {},
): Promise<void> {
  const answer = await request(method, path, body, options);

  if (answer !== NO_BODY) {
    throw new Error(
      `${method} ${path} answered with a body, which nothing will read. Use apiSend.`,
    );
  }
}
