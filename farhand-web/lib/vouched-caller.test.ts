import { describe, expect, it } from "vitest";
import {
  applyVouch,
  CALLER_HEADER,
  visitorAddress,
  VOUCH_HEADER,
} from "./vouched-caller";

/**
 * Which address we tell the API about, and when we say nothing — issue #164.
 *
 * These tests are the specification.
 *
 *   npm test -- vouched-caller
 *
 * WHAT THEY EXIST FOR. Three deploys tried to get a visitor's address to the
 * API through `x-forwarded-for` and all three delivered a Vercel address.
 * Only the last one was measured properly, and the measurement said something
 * none of the three guesses had: the value this file picks was right in two of
 * them, and the API's hop count was reading one entry past it.
 *
 * So the rule here is small, and the part that matters is the part a chain
 * cannot carry — which end to read, and never sending a half-formed vouch.
 */

/** Long enough for the API's `env.ts` to accept it. */
const SECRET = "a-test-vouch-secret-of-ample-length";

describe("which entry of the chain is the visitor", () => {
  /**
   * What production actually sends, measured: one entry, and it is the
   * visitor's. A browser sends no `x-forwarded-for` at all, so Vercel's edge
   * wrote this.
   */
  it("is the only one, when Vercel replaced the header", () => {
    expect(visitorAddress("203.0.113.7")).toBe("203.0.113.7");
  });

  /**
   * And the other world, which the measurement cannot rule out: Vercel
   * appends instead of replacing. Then the visitor's is the one it added —
   * last — and the forgery is to its left. Rightmost is correct either way,
   * which is the whole reason for choosing that end.
   */
  it("is the last one, when a caller wrote entries of their own", () => {
    expect(visitorAddress("1.2.3.4, 203.0.113.7")).toBe("203.0.113.7");
    expect(visitorAddress("fake, also-fake, 203.0.113.7")).toBe("203.0.113.7");
  });

  it("survives the spacing a chain actually arrives with", () => {
    expect(visitorAddress("1.2.3.4,203.0.113.7")).toBe("203.0.113.7");
    expect(visitorAddress("  1.2.3.4 ,  203.0.113.7  ")).toBe("203.0.113.7");
  });

  it("ignores empty entries rather than returning one", () => {
    expect(visitorAddress("203.0.113.7, ")).toBe("203.0.113.7");
    expect(visitorAddress("203.0.113.7,,")).toBe("203.0.113.7");
  });

  it.each([
    [null, "no header at all"],
    ["", "an empty header"],
    ["   ", "whitespace"],
    [",", "a comma and nothing else"],
    [", ,", "commas and nothing else"],
  ])("is nothing for %s (%s)", (header, _why) => {
    expect(visitorAddress(header)).toBeNull();
  });
});

describe("stating the address, or stating nothing", () => {
  it("sends both headers when there is an address and a secret", () => {
    const headers = new Headers();

    applyVouch(headers, "203.0.113.7", SECRET);

    expect(headers.get(CALLER_HEADER)).toBe("203.0.113.7");
    expect(headers.get(VOUCH_HEADER)).toBe(SECRET);
  });

  /**
   * The state of every local `npm run dev`, and of a Vercel project where
   * somebody forgot the variable. Nothing is sent — not an empty header, and
   * above all not the string "undefined", which is what an unset variable
   * becomes the instant it is put in a template.
   */
  it.each([
    [undefined, "unset"],
    ["", "empty"],
  ])("sends neither header when the secret is %s (%s)", (secret, _why) => {
    const headers = new Headers();

    applyVouch(headers, "203.0.113.7", secret);

    expect(headers.has(CALLER_HEADER)).toBe(false);
    expect(headers.has(VOUCH_HEADER)).toBe(false);
  });

  it("sends neither header when there is no address to state", () => {
    const headers = new Headers();

    applyVouch(headers, null, SECRET);

    expect(headers.has(CALLER_HEADER)).toBe(false);
    expect(headers.has(VOUCH_HEADER)).toBe(false);
  });

  /**
   * THE ONE THAT IS ABOUT SOMEBODY ELSE'S REQUEST. A request arriving at this
   * middleware can carry any header a stranger chose, including these two
   * names. The API would refuse an unproven one — the secret is the entire
   * point — but a proxy that forwards a forgery and trusts the far end to
   * catch it is one audit away from being wrong.
   */
  it("strips a vouch a stranger wrote, when we are not vouching", () => {
    const headers = new Headers({
      [CALLER_HEADER]: "198.51.100.1",
      [VOUCH_HEADER]: "a secret somebody guessed at",
    });

    applyVouch(headers, null, SECRET);

    expect(headers.has(CALLER_HEADER)).toBe(false);
    expect(headers.has(VOUCH_HEADER)).toBe(false);
  });

  it("overwrites a vouch a stranger wrote, when we are", () => {
    const headers = new Headers({
      [CALLER_HEADER]: "198.51.100.1",
      [VOUCH_HEADER]: "a secret somebody guessed at",
    });

    applyVouch(headers, "203.0.113.7", SECRET);

    expect(headers.get(CALLER_HEADER)).toBe("203.0.113.7");
    expect(headers.get(VOUCH_HEADER)).toBe(SECRET);
  });

  /**
   * `x-forwarded-for` is left exactly as it arrives. Three attempts at
   * rewriting it are what #164 is for, and the API counts hops only on
   * requests that reach it directly.
   */
  it("leaves the chain itself untouched", () => {
    const headers = new Headers({ "x-forwarded-for": "203.0.113.7" });

    applyVouch(headers, "203.0.113.7", SECRET);

    expect(headers.get("x-forwarded-for")).toBe("203.0.113.7");
  });
});
