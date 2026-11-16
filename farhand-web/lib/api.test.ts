import { afterEach, describe, expect, it, vi } from "vitest";
import {
  apiGet,
  apiSend,
  apiSendEmpty,
  ApiFailure,
  UNREACHABLE,
} from "./api.js";

/**
 * The one place that reads an error — issue #93.
 *
 * These tests are the specification for lib/api.ts. The screens are not
 * tested here: what is worth pinning at this size is the layer every screen
 * depends on, because a mistake in it is a mistake on every page at once.
 *
 * `fetch` is stubbed rather than a server being started. The question these
 * ask is "given this response, what does the caller get?", and that question
 * has nothing to do with HTTP working.
 */

/**
 * Stands in for one answer from the API.
 *
 * The parameters are declared even though the stub ignores them: without
 * them `mock.calls` is a list of empty tuples, and then asking "what URL was
 * requested?" does not compile. Which is the point of asking.
 */
function answering(status: number, body: unknown, ok = status < 400) {
  const fetching = vi.fn((_url: string | URL, _init?: RequestInit) =>
    Promise.resolve({
      status,
      ok,
      json: () => Promise.resolve(body),
    } as unknown as Response),
  );

  vi.stubGlobal("fetch", fetching);

  return fetching;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("where it sends the request", () => {
  /**
   * The cookie test, as far as a unit test can take it: an absolute API URL
   * here would make every request cross-site, and the session would stop
   * surviving one (decision 0031). A relative `/api/...` is the whole fix.
   */
  it("asks this app, under /api, and never the API's own address", async () => {
    const fetching = answering(200, { items: [], nextCursor: null });

    await apiGet("/needs");

    expect(fetching.mock.calls[0]?.[0]).toBe("/api/needs");
    expect(String(fetching.mock.calls[0]?.[0])).not.toContain("onrender.com");
  });

  it("sends the cookie, as a same-origin request", async () => {
    const fetching = answering(200, { items: [], nextCursor: null });

    await apiGet("/needs");

    expect(fetching.mock.calls[0]?.[1]?.credentials).toBe("same-origin");
  });

  it("puts the filters in the query string", async () => {
    const fetching = answering(200, { items: [], nextCursor: null });

    await apiGet("/needs", { query: { deliverCountry: "EE", limit: 20 } });

    expect(fetching.mock.calls[0]?.[0]).toBe(
      "/api/needs?deliverCountry=EE&limit=20",
    );
  });

  /**
   * An absent filter narrows nothing (docs/06-api-contract.md). Sending
   * `?q=` instead of leaving it out would be a filter matching the empty
   * string, which is a different request.
   */
  it("leaves out a filter nobody set", async () => {
    const fetching = answering(200, { items: [], nextCursor: null });

    await apiGet("/needs", { query: { q: undefined, limit: 5 } });

    expect(fetching.mock.calls[0]?.[0]).toBe("/api/needs?limit=5");
  });
});

describe("what it does with an answer", () => {
  it("hands back the body when the API is happy", async () => {
    answering(200, { items: [{ id: "cm1" }], nextCursor: null });

    const page = await apiGet<{ items: { id: string }[] }>("/needs");

    expect(page.items[0]?.id).toBe("cm1");
  });

  it("turns the API's error shape into something catchable", async () => {
    answering(422, {
      error: {
        code: "VALIDATION_FAILED",
        message: "Acknowledging the prohibited items is required",
        requestId: "51de6d13",
        details: [{ field: "prohibitedVersion", message: "Send the version" }],
      },
    });

    const failure = await apiGet("/needs").catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ApiFailure);
    const thrown = failure as ApiFailure;
    expect(thrown.status).toBe(422);
    expect(thrown.error.code).toBe("VALIDATION_FAILED");
    // The message is the Error's message too, so anything that logs or
    // displays a caught error says something true without unwrapping it.
    expect(thrown.message).toContain("prohibited items");
    expect(thrown.error.details?.[0]?.field).toBe("prohibitedVersion");
    // #4 puts a request id on every error the API generates, and it is what
    // you quote when you ask why. Losing it here loses it for good.
    expect(thrown.error.requestId).toBe("51de6d13");
  });

  /**
   * The case a client written against the happy path gets wrong: the body is
   * not ours. A sleeping free-plan service answers with the platform's HTML,
   * and the proxy in front of the API can answer `502` on its own.
   */
  it("still reports a failure that never reached the API", async () => {
    answering(502, null, false);

    const failure = (await apiGet("/needs").catch(
      (error: unknown) => error,
    )) as ApiFailure;

    expect(failure).toBeInstanceOf(ApiFailure);
    expect(failure.status).toBe(502);
    expect(failure.error.code).toBe(UNREACHABLE);
    // It says the status, because "502" is the one fact there is.
    expect(failure.error.message).toContain("502");
  });

  it("refuses a body that is JSON but not our shape", async () => {
    answering(500, { message: "Internal Server Error" }, false);

    const failure = (await apiGet("/needs").catch(
      (error: unknown) => error,
    )) as ApiFailure;

    // Half a shape is not the shape: `error.code` is what everything
    // downstream switches on, so a body without one is not ours.
    expect(failure.error.code).toBe(UNREACHABLE);
  });

  it("reports a connection that failed before any answer", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new TypeError("Failed to fetch"))),
    );

    const failure = (await apiGet("/needs").catch(
      (error: unknown) => error,
    )) as ApiFailure;

    expect(failure.status).toBe(0);
    expect(failure.error.code).toBe(UNREACHABLE);
    expect(failure.error.message).toContain("Could not reach Farhand");
  });

  /**
   * A screen that navigates away aborts its own request. Reporting that as
   * "could not reach Farhand" would put an error on the page somebody has
   * just left.
   */
  it("lets an abort through as an abort", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.reject(
          new DOMException("The user aborted a request.", "AbortError"),
        ),
      ),
    );

    const failure = await apiGet("/needs").catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(DOMException);
    expect(failure).not.toBeInstanceOf(ApiFailure);
  });
});

/**
 * Writing — issue #156.
 *
 * `apiSend` is the half of this module that forms depend on, and the whole
 * risk is that it quietly becomes a SECOND implementation of the reading
 * half. So these tests deliberately re-ask the questions already answered
 * above — the relative path, the cookie, the error envelope, the abort —
 * because a copy that drifts drifts in exactly those places, and it would
 * drift in a deployed browser and nowhere a happier test would look.
 */

/** An answer with no body at all, which is what a 204 really is. */
function answeringEmpty(status = 204) {
  const fetching = vi.fn((_url: string | URL, _init?: RequestInit) =>
    Promise.resolve({
      status,
      ok: status < 400,
      // A real empty body does not parse. The code must not depend on the
      // rejection — it must look at the status — but it must survive it.
      json: () => Promise.reject(new SyntaxError("Unexpected end of JSON")),
    } as unknown as Response),
  );

  vi.stubGlobal("fetch", fetching);

  return fetching;
}

/** What `fetch` was asked to send, as headers you can look things up in. */
function headersOf(init: RequestInit | undefined): Headers {
  return new Headers(init?.headers);
}

describe("how it sends a write", () => {
  it("uses the method it was given", async () => {
    const fetching = answering(200, { user: { id: "cm1" } });

    await apiSend("POST", "/auth/login", { email: "a@b.c", password: "x" });

    expect(fetching.mock.calls[0]?.[1]?.method).toBe("POST");
  });

  /**
   * THE ONE THAT COSTS AN AFTERNOON. Without this header Express's JSON
   * parser does not run, `req.body` is empty, and the API answers 422 naming
   * every field as required — which reads like a bug in the form and is
   * nothing of the kind.
   */
  it("says the body is JSON", async () => {
    const fetching = answering(200, {});

    await apiSend("POST", "/auth/login", { email: "a@b.c" });

    expect(headersOf(fetching.mock.calls[0]?.[1]).get("content-type")).toBe(
      "application/json",
    );
  });

  it("sends the body as JSON", async () => {
    const fetching = answering(200, {});

    await apiSend("POST", "/auth/register", {
      email: "kadri@example.com",
      countryCode: "EE",
    });

    const sent = fetching.mock.calls[0]?.[1]?.body;

    // A string, not the object itself: handing `fetch` an object sends the
    // literal "[object Object]", which the API reads as a body it cannot
    // parse rather than as the fields somebody typed.
    expect(typeof sent).toBe("string");
    expect(JSON.parse(sent as string)).toEqual({
      email: "kadri@example.com",
      countryCode: "EE",
    });
  });

  /**
   * `POST /auth/logout` carries nothing. A `Content-Type` announcing a body
   * that is not there is a small lie, and some proxies treat a declared JSON
   * body of length zero as a parse error.
   */
  it("sends neither a body nor a content type when there is nothing to send", async () => {
    const fetching = answeringEmpty();

    await apiSendEmpty("POST", "/auth/logout");

    expect(fetching.mock.calls[0]?.[1]?.body).toBeUndefined();
    expect(headersOf(fetching.mock.calls[0]?.[1]).has("content-type")).toBe(
      false,
    );
  });

  /** The same two rules the reading half obeys, asked again of the copy. */
  it("asks this app under /api, with the cookie", async () => {
    const fetching = answering(200, {});

    await apiSend("POST", "/auth/login", {});

    expect(fetching.mock.calls[0]?.[0]).toBe("/api/auth/login");
    expect(fetching.mock.calls[0]?.[1]?.credentials).toBe("same-origin");
  });
});

describe("what it does with an answer to a write", () => {
  it("hands back the body when there is one", async () => {
    answering(200, { user: { id: "cm1", email: "kadri@example.com" } });

    const body = await apiSend<{ user: { id: string } }>(
      "POST",
      "/auth/login",
      {},
    );

    expect(body.user.id).toBe("cm1");
  });

  /**
   * A 204 has nothing to read. The failure this prevents is subtle: the
   * reading half catches the parse error and hands back `null`, which the
   * cast then calls a `T`. The caller gets a value the type system swears is
   * there and the runtime says is not.
   */
  it("finishes a 204 with nothing, rather than null pretending to be data", async () => {
    answeringEmpty();

    await expect(apiSendEmpty("POST", "/auth/logout")).resolves.toBeUndefined();
  });

  it("refuses to pass a 204 off as a body somebody asked for", async () => {
    answeringEmpty();

    await expect(apiSend("POST", "/auth/logout")).rejects.toThrow();
  });

  it("reads the error envelope the same way a read does", async () => {
    answering(422, {
      error: {
        code: "VALIDATION_FAILED",
        message: "Some of that is not right",
        requestId: "51de6d13",
        details: [{ field: "email", message: "Enter a full email address" }],
      },
    });

    const failure = (await apiSend("POST", "/auth/register", {}).catch(
      (error: unknown) => error,
    )) as ApiFailure;

    expect(failure).toBeInstanceOf(ApiFailure);
    expect(failure.status).toBe(422);
    expect(failure.error.requestId).toBe("51de6d13");
    expect(failure.error.details?.[0]?.field).toBe("email");
  });

  /**
   * A banned account with the right password (routes/auth.ts). The sign-in
   * screen needs to tell it apart from a wrong password, so the status has to
   * survive the trip.
   */
  it("keeps the status, so a screen can tell 403 from 401", async () => {
    answering(403, {
      error: { code: "FORBIDDEN", message: "This account has been banned" },
    });

    const failure = (await apiSend("POST", "/auth/login", {}).catch(
      (error: unknown) => error,
    )) as ApiFailure;

    expect(failure.status).toBe(403);
    expect(failure.message).toContain("banned");
  });

  it("still reports a write that never reached the API", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new TypeError("Failed to fetch"))),
    );

    const failure = (await apiSend("POST", "/auth/login", {}).catch(
      (error: unknown) => error,
    )) as ApiFailure;

    expect(failure.status).toBe(0);
    expect(failure.error.code).toBe(UNREACHABLE);
  });

  it("refuses a write's error body that is not our shape", async () => {
    answering(502, "<html>Bad Gateway</html>", false);

    const failure = (await apiSend("POST", "/auth/login", {}).catch(
      (error: unknown) => error,
    )) as ApiFailure;

    expect(failure.error.code).toBe(UNREACHABLE);
    expect(failure.error.message).toContain("502");
  });

  it("lets an abort through as an abort", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.reject(
          new DOMException("The user aborted a request.", "AbortError"),
        ),
      ),
    );

    const failure = await apiSend("POST", "/auth/login", {}).catch(
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(DOMException);
    expect(failure).not.toBeInstanceOf(ApiFailure);
  });
});
