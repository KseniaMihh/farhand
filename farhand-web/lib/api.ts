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
