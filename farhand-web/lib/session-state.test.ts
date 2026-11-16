import { describe, expect, it } from "vitest";
import { ApiFailure, UNREACHABLE } from "./api.js";
import {
  isSettled,
  outcomeFor,
  RETRY_DELAYS_MS,
  type Me,
} from "./session-state.js";

/**
 * The specification for lib/session-state.ts — issue #156.
 *
 * One rule, and these tests exist because breaking it is invisible: if a
 * silent API counted as "signed out", everything would look right in
 * development against a local API that always answers, and go wrong on the
 * free plan every morning, for the people who are signed in.
 *
 * ONLY A 401 MEANS SIGNED OUT.
 */

/** A failure as lib/api.ts would throw it. */
function failing(status: number, code = "SOMETHING") {
  return new ApiFailure(status, { code, message: "…" });
}

/** The failure a sleeping API produces: no answer at all. */
function silence() {
  return new ApiFailure(0, {
    code: UNREACHABLE,
    message: "Could not reach Farhand. Check your connection and try again.",
  });
}

describe("the one answer that means signed out", () => {
  it("reads a 401 as signed out", () => {
    expect(outcomeFor(failing(401, "UNAUTHORIZED"))).toBe("signed-out");
  });

  /**
   * The point of the whole module. A Render free instance sleeps after
   * fifteen quiet minutes and takes most of a minute to wake; during that
   * minute every request fails with no answer. Calling it "signed out" shows
   * a signed-in person "Sign in" on their first visit of the day, and later —
   * once screens sit behind a sign-in wall — redirects them off the page
   * they asked for while their session is perfectly good.
   */
  it("does not read silence as signed out", () => {
    expect(outcomeFor(silence())).not.toBe("signed-out");
    expect(outcomeFor(silence())).toBe("retry");
  });

  it("does not read a server fault as signed out", () => {
    for (const status of [500, 502, 503, 504]) {
      expect(outcomeFor(failing(status))).toBe("retry");
    }
  });

  /**
   * A 403 from this endpoint would be strange — `requireAuth` answers 401 —
   * but "strange" is not "signed out". Guessing in the direction that logs
   * somebody out is the guess with a cost.
   */
  it("does not read any other refusal as signed out", () => {
    for (const status of [400, 403, 404, 409, 418, 422, 429]) {
      expect(outcomeFor(failing(status))).toBe("unknown");
    }
  });

  it("does not read a thrown anything as signed out", () => {
    expect(outcomeFor(new TypeError("Failed to fetch"))).toBe("unknown");
    expect(outcomeFor("nope")).toBe("unknown");
    expect(outcomeFor(null)).toBe("unknown");
    expect(outcomeFor(undefined)).toBe("unknown");
  });
});

/**
 * The delays are not decoration: with one short retry the loop gives up
 * before a cold instance has finished waking, which is the bug this whole
 * state exists to avoid, written a second way.
 */
describe("how long it is willing to wait", () => {
  it("waits longer each time", () => {
    const rising = RETRY_DELAYS_MS.every(
      (delay, i) => i === 0 || delay > (RETRY_DELAYS_MS[i - 1] ?? 0),
    );

    // Several waits, not one long one. A single 60-second delay would satisfy
    // the sum below and show somebody a blank header for a minute, when the
    // API may well have woken in ten seconds.
    expect(RETRY_DELAYS_MS.length).toBeGreaterThanOrEqual(3);
    expect(rising).toBe(true);
  });

  it("waits long enough for a sleeping instance to wake", () => {
    const total = RETRY_DELAYS_MS.reduce((sum, delay) => sum + delay, 0);

    // Render's own figure for a free instance is "up to about a minute".
    expect(total).toBeGreaterThanOrEqual(60_000);
  });
});

/**
 * The guard the first protected screen will want. It is tested now, with no
 * caller, because the shape of the mistake is known: `status !== "signed-in"`
 * reads as "not signed in" and is really "not signed in YET" twice out of
 * four.
 */
describe("whether a screen may act on the session", () => {
  const me: Me = {
    id: "cm1",
    email: "kadri@example.com",
    emailVerified: true,
    status: "ACTIVE",
    suspendedUntil: null,
    profile: { displayName: "Kadri", countryCode: "EE" },
  };

  it("is settled once there is an answer either way", () => {
    expect(isSettled({ status: "signed-in", me })).toBe(true);
    expect(isSettled({ status: "signed-out" })).toBe(true);
  });

  it("is not settled while the answer is still missing", () => {
    expect(isSettled({ status: "checking" })).toBe(false);
    expect(isSettled({ status: "unknown" })).toBe(false);
  });
});
