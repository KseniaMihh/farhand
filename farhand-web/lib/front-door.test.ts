import { describe, expect, it } from "vitest";
import { frontDoor, FRONT_DOOR, THE_PRODUCT } from "./front-door";

/**
 * The landing page is for people who are not signed in — issue #170.
 *
 *   npm test -- front-door
 */

describe("the front door", () => {
  it("sends somebody with a session to the product", () => {
    expect(frontDoor(FRONT_DOOR, true)).toBe(THE_PRODUCT);
  });

  it("lets somebody without one through to it", () => {
    expect(frontDoor(FRONT_DOOR, false)).toBe(null);
  });

  /**
   * THE MISTAKE THIS EXISTS FOR. A guard that forgets to check the path
   * redirects the whole site, including the page it redirects TO — and that
   * is a loop, on the one screen a stranger sees first. It is also the
   * easiest edit to make by accident when somebody later wants to gate a
   * second page.
   */
  it("guards one path and no other", () => {
    expect(frontDoor(THE_PRODUCT, true)).toBe(null);
    expect(frontDoor("/needs/abc", true)).toBe(null);
    expect(frontDoor("/sign-in", true)).toBe(null);
    expect(frontDoor("/api/auth/me", true)).toBe(null);
  });

  /**
   * `/` and nothing that merely starts with it. Without the exact
   * comparison every path in the product is the front door.
   */
  it("does not treat a path that starts with a slash as the front door", () => {
    expect(frontDoor("/register", true)).toBe(null);
    expect(frontDoor("//", true)).toBe(null);
  });

  it("never sends anybody somewhere that would redirect them again", () => {
    // Stated as two facts about the same constant rather than by feeding the
    // first answer back in, because narrowing a `string | null` to satisfy
    // the second call is the kind of ceremony that makes a test unreadable.
    expect(frontDoor(FRONT_DOOR, true)).toBe(THE_PRODUCT);
    expect(frontDoor(THE_PRODUCT, true)).toBe(null);
  });
});
