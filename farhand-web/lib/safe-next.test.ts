import { describe, expect, it } from "vitest";
import { HOME, safeNext } from "./safe-next.js";

/**
 * The specification for lib/safe-next.ts — issue #156.
 *
 * This is the security test in this issue. An open redirect on a page people
 * type their password into is a phishing page wearing our domain, so the
 * interesting cases here are all attacks, and the ordinary ones are only
 * present to prove the check does not refuse everything.
 */

const US = "https://farhand.example";

describe("addresses that are ours", () => {
  it("keeps a plain path", () => {
    expect(safeNext("/needs", US)).toBe("/needs");
  });

  it("keeps the query and the fragment with it", () => {
    expect(safeNext("/needs?deliverCountry=EE&limit=20#first", US)).toBe(
      "/needs?deliverCountry=EE&limit=20#first",
    );
  });

  /**
   * An absolute URL back to us is ours, and comes back as a path: handing
   * `router.replace` an absolute address would work and would also be the one
   * line somebody later copies for a `next` that is NOT ours.
   */
  it("reduces an absolute address of our own to a path", () => {
    expect(safeNext(`${US}/deals/cm1?tab=history`, US)).toBe(
      "/deals/cm1?tab=history",
    );
  });

  it("keeps a path that merely mentions another host", () => {
    expect(safeNext("/needs?q=evil.example", US)).toBe("/needs?q=evil.example");
  });
});

describe("addresses that are not", () => {
  it("refuses another site outright", () => {
    expect(safeNext("https://evil.example/login", US)).toBe(HOME);
  });

  it("refuses a protocol-relative address", () => {
    expect(safeNext("//evil.example", US)).toBe(HOME);
    expect(safeNext("//evil.example/sign-in", US)).toBe(HOME);
  });

  /**
   * THE ONE A CHARACTER TEST MISSES, and the reason this function parses.
   * `/\evil.example` starts with a single slash and is not `//`, so "starts
   * with / but not //" lets it through — and then the browser normalises the
   * backslash in the authority position and goes to `//evil.example`.
   */
  it("refuses a backslash the browser will read as a second slash", () => {
    expect(safeNext("/\\evil.example", US)).toBe(HOME);
    expect(safeNext("\\/evil.example", US)).toBe(HOME);
    expect(safeNext("/\\\\evil.example", US)).toBe(HOME);
  });

  it("refuses a scheme that is not a page", () => {
    expect(safeNext("javascript:alert(1)", US)).toBe(HOME);
    expect(safeNext("data:text/html,<script>alert(1)</script>", US)).toBe(HOME);
  });

  /**
   * Same host, different scheme, is a different origin — and downgrading
   * somebody to http straight after they have typed a password is the attack
   * this one is about.
   */
  it("refuses our own host over the wrong scheme", () => {
    expect(safeNext("http://farhand.example/needs", US)).toBe(HOME);
  });

  it("refuses a host that merely starts with ours", () => {
    expect(safeNext("https://farhand.example.evil.test/x", US)).toBe(HOME);
  });

  it("refuses credentials smuggled before an @", () => {
    expect(safeNext("https://farhand.example@evil.example/x", US)).toBe(HOME);
  });
});

describe("addresses that are nothing", () => {
  it("sends a missing next home", () => {
    expect(safeNext(null, US)).toBe(HOME);
    expect(safeNext(undefined, US)).toBe(HOME);
    expect(safeNext("", US)).toBe(HOME);
  });

  /**
   * `new URL` throws on input it cannot parse. Letting that escape would turn
   * a junk querystring into a crashed sign-in page — the one page somebody
   * cannot route around.
   */
  it("sends something unparseable home instead of throwing", () => {
    expect(() => safeNext("http://[", US)).not.toThrow();
    expect(safeNext("http://[", US)).toBe(HOME);
    expect(safeNext("%", US)).toBe(HOME);
  });
});

/**
 * Signing in and landing back on the sign-in page is a loop, and landing on
 * /register is a dead end. The API has no opinion about this; it is ours.
 */
describe("addresses that are ours but pointless", () => {
  it("sends the account screens home", () => {
    expect(safeNext("/sign-in", US)).toBe(HOME);
    expect(safeNext("/sign-in?next=%2Fneeds", US)).toBe(HOME);
    expect(safeNext("/register", US)).toBe(HOME);
    expect(safeNext("/verify", US)).toBe(HOME);
  });

  it("does not mistake a longer path for one of them", () => {
    expect(safeNext("/sign-in-help", US)).toBe("/sign-in-help");
    expect(safeNext("/registered-offers", US)).toBe("/registered-offers");
  });
});
