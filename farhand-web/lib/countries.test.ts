import { describe, expect, it } from "vitest";
import { countries, countryName, COUNTRY_CODES } from "./countries";

/**
 * Countries, as words — issue #166 added `countryName`.
 *
 *   npm test -- countries
 *
 * The 249 codes ship with the app and `Intl.DisplayNames` names them; it does
 * not enumerate them, which is the correction that produced this file's
 * shape in #156.
 */

describe("the list a select is built from", () => {
  it("has every code the API will accept", () => {
    expect(countries()).toHaveLength(COUNTRY_CODES.length);
  });

  it("is sorted the way a reader expects, not by code point", () => {
    const names = countries().map((country) => country.name);
    const sorted = [...names].sort(new Intl.Collator("en").compare);

    expect(names).toEqual(sorted);
  });
});

describe("naming one country", () => {
  it("turns a code into a word", () => {
    expect(countryName("EE")).toBe("Estonia");
    expect(countryName("JP")).toBe("Japan");
  });

  /**
   * What `Intl.DisplayNames` does for a region it does not know, and the
   * reason this never throws: a worse label is not a broken screen.
   */
  it("falls back to the code it was given", () => {
    // `QQ` is well formed and unassigned, so `Intl.DisplayNames` hands the
    // code straight back. `ZZ` does NOT work here and was the first guess:
    // it is reserved, and it is named "Unknown Region".
    expect(countryName("QQ")).toBe("QQ");
  });

  it("is the same answer the list uses, so a card and a select agree", () => {
    const fromList = countries().find((country) => country.code === "EE");

    expect(countryName("EE")).toBe(fromList?.name);
  });
});
