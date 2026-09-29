import { afterEach, describe, expect, it, vi } from "vitest";
import { env } from "../../src/env.js";
import { logger } from "../../src/logger.js";
import { reportError } from "../../src/observability.js";

/**
 * What happens when the thing that records failures fails — issue #29.
 *
 * Its own file because of how it has to be done: `@sentry/node` is a real ESM
 * package, and Vitest cannot spy on one's exports ("module namespace is not
 * configurable"). Replacing the module wholesale is the way, and doing that in
 * the main spec would mean every test in it ran against a Sentry that always
 * throws. So the replacement lives here, where it is the point.
 */
vi.mock("@sentry/node", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@sentry/node")>();

  return {
    ...actual,
    withScope: () => {
      throw new Error("sentry.io is unreachable");
    },
  };
});

afterEach(() => {
  env.SENTRY_DSN = undefined;
  vi.restoreAllMocks();
});

describe("a monitoring service having a bad day", () => {
  it("does not turn a 500 into a crash", () => {
    env.SENTRY_DSN = "https://examplePublicKey@o0.ingest.sentry.io/0";

    expect(() => {
      reportError(new Error("the real problem"), { requestId: "abc-123" });
    }).not.toThrow();
  });

  it("complains in the log instead, so the silence is explained", () => {
    env.SENTRY_DSN = "https://examplePublicKey@o0.ingest.sentry.io/0";
    const complained = vi.spyOn(logger, "error");

    reportError(new Error("the real problem"), { requestId: "abc-123" });

    // Otherwise error reporting fails quietly, which is the one thing error
    // reporting must never do.
    expect(complained).toHaveBeenCalled();
  });
});
