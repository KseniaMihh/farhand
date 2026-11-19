import { describe, expect, it } from "vitest";
import * as needs from "./needs";
import { photoSrc, price } from "./needs";

/**
 * What a need looks like to a screen that draws one — issue #166.
 *
 * These tests are the specification. They fail until the TODOs in needs.ts
 * are filled in.
 *
 *   npm test -- needs
 */

describe("money, as a person reads it", () => {
  /** Whole cents everywhere in this product — decision 0006. */
  it("divides by a hundred, because the API counts in cents", () => {
    expect(price(2400, "EUR")).toContain("24.00");
    expect(price(950, "EUR")).toContain("9.50");
  });

  it("names the currency the need is in, not a currency of ours", () => {
    expect(price(2400, "JPY")).not.toEqual(price(2400, "EUR"));
  });

  it("handles nothing at all, which is what most thank-yous are", () => {
    expect(price(0, "EUR")).toContain("0.00");
  });
});

/**
 * THE TEST THAT LOOKS ABSURD, and is the cheapest way to make the next person
 * argue for it.
 *
 * `estimatedPrice` is what the product costs. `thankYouAmount` is what is
 * offered for the trouble. They are two amounts beside one currency, and the
 * design review found a panel showing both as lines and then a total that
 * silently included the second — €24.00 and €9.50 reading as €38.50.
 *
 * Adding them up is a decision about what a total MEANS here. Until somebody
 * makes it deliberately, this module must not quietly offer one.
 */
describe("the two amounts are never added up", () => {
  it("exports no total", () => {
    const names = Object.keys(needs);

    expect(names).not.toContain("total");
    expect(names.filter((name) => /total|sum/i.test(name))).toEqual([]);
  });
});

describe("a photo path, as an <img> can load it", () => {
  /**
   * The API answers paths relative to ITSELF — `/files/3f1c…` — and in a
   * browser those resolve against our own origin, where nothing serves
   * `/files`. Without the prefix every picture on both screens is broken, and
   * it stays invisible until a need actually has one.
   */
  it("puts it under /api, where the proxy is", () => {
    expect(photoSrc("/files/3f1c")).toBe("/api/files/3f1c");
  });

  it("is the same rule for a cover and for a photo on the page", () => {
    // `coverPhoto` and `photos[].url` are the same kind of path, so there is
    // one function and not two that drift apart.
    expect(photoSrc("/files/aaa")).toBe("/api/files/aaa");
    expect(photoSrc("/files/bbb")).toBe("/api/files/bbb");
  });

  it("does not prefix twice", () => {
    expect(photoSrc("/api/files/3f1c")).toBe("/api/files/3f1c");
  });
});
