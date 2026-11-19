import { describe, expect, it } from "vitest";
import {
  filtersFrom,
  historyMode,
  hrefFor,
  isUnfiltered,
  queryFrom,
  type BrowseFilters,
} from "./browse-filters";

/**
 * What you are asking the list for — issue #166.
 *
 * These tests are the specification. They fail until the TODOs in
 * browse-filters.ts are filled in.
 *
 *   npm test -- browse-filters
 *
 * The filters live in the URL because a filtered list is a thing people send,
 * reload and press Back out of. That decision is what every test below is
 * about: a URL is read by a person, typed by a person, and arrives malformed.
 */

describe("reading the filters out of a URL", () => {
  it("takes the four the API understands", () => {
    const params = new URLSearchParams(
      "buyCountry=JP&deliverCountry=EE&categoryId=cm1abc&q=sunscreen",
    );

    expect(filtersFrom(params)).toEqual({
      buyCountry: "JP",
      deliverCountry: "EE",
      categoryId: "cm1abc",
      q: "sunscreen",
    });
  });

  it("leaves out what is not there, because an absent filter narrows nothing", () => {
    expect(filtersFrom(new URLSearchParams("q=sunscreen"))).toEqual({
      q: "sunscreen",
    });
  });

  /**
   * `?q=` is what somebody typing a letter and deleting it leaves behind. Read
   * as a filter it asks the API to match the empty string, which narrows the
   * list to nothing — and then the screen says "nothing matches your filters"
   * when the truth is that nothing has been posted.
   */
  it.each([
    ["q=", "an empty search"],
    ["q=%20%20", "spaces"],
    ["buyCountry=", "an empty country"],
    ["categoryId=", "an empty category"],
  ])("treats %s as absent (%s)", (query, _why) => {
    expect(filtersFrom(new URLSearchParams(query))).toEqual({});
  });

  it("normalises country codes, which the API compares without case", () => {
    const filters = filtersFrom(
      new URLSearchParams("buyCountry=jp&deliverCountry=ee"),
    );

    expect(filters).toEqual({ buyCountry: "JP", deliverCountry: "EE" });
  });

  it("keeps the search text as typed, because it is matched as text", () => {
    expect(filtersFrom(new URLSearchParams("q=Biore+UV")).q).toBe("Biore UV");
  });

  it("ignores anything in the URL that is not ours", () => {
    const filters = filtersFrom(
      new URLSearchParams("q=sun&utm_source=a-newsletter&cursor=abc"),
    );

    expect(filters).toEqual({ q: "sun" });
  });
});

describe("writing the filters back into a URL", () => {
  it("writes what is set", () => {
    const query = queryFrom({ buyCountry: "JP", q: "sunscreen" });

    expect(query.get("buyCountry")).toBe("JP");
    expect(query.get("q")).toBe("sunscreen");
  });

  /**
   * Clearing a filter has to give back the plain URL. Writing `?q=` instead
   * leaves something that reads as a filter, and `filtersFrom` would then have
   * to un-decide it on the way back in — one rule in two places.
   */
  it("removes what is absent rather than writing it empty", () => {
    expect(queryFrom({}).toString()).toBe("");
    expect(queryFrom({ q: "" }).toString()).toBe("");
    // A filter that is explicitly `undefined` is not even expressible —
    // `exactOptionalPropertyTypes` makes absent the only way to be absent,
    // so the compiler holds this half and the runtime only has to drop the
    // empty string.
    expect(queryFrom({ buyCountry: "JP" }).toString()).toBe("buyCountry=JP");
  });

  it("puts the keys in one fixed order, so the same filters make the same URL", () => {
    const one = queryFrom({ q: "sun", buyCountry: "JP" }).toString();
    const other = queryFrom({ buyCountry: "JP", q: "sun" }).toString();

    expect(one).toBe(other);
  });

  /**
   * A cursor in the URL would restore page three of a list that has changed
   * underneath it, and `nextCursor` is not a page number to begin with.
   */
  it("never writes a cursor", () => {
    const query = queryFrom({ q: "sun" });

    expect(query.has("cursor")).toBe(false);
  });

  it("survives the round trip", () => {
    const filters: BrowseFilters = {
      buyCountry: "JP",
      deliverCountry: "EE",
      categoryId: "cm1abc",
      q: "Biore UV",
    };

    expect(filtersFrom(queryFrom(filters))).toEqual(filters);
  });
});

describe("telling the two empty lists apart", () => {
  it("is unfiltered when nothing is set", () => {
    expect(isUnfiltered({})).toBe(true);
  });

  /** The case that decides whether somebody sees 2.1a or 2.1b. */
  it.each([
    [{ q: "" }, "an empty search box"],
    [{ q: "   " }, "spaces in the search box"],
    [{ categoryId: "" }, "a category that was cleared"],
  ])("is still unfiltered with %o (%s)", (filters, _why) => {
    expect(isUnfiltered(filters)).toBe(true);
  });

  it.each([
    [{ q: "sun" }, "a search"],
    [{ buyCountry: "JP" }, "a country"],
    [{ categoryId: "cm1abc" }, "a category"],
  ])("is filtered with %o (%s)", (filters, _why) => {
    expect(isUnfiltered(filters)).toBe(false);
  });
});

describe("whether a change deserves a step in the history", () => {
  /**
   * The bug this prevents: with a `push` per keystroke, Back walks the person
   * through "s", "su", "sun", "suns" before it leaves the page. That is not a
   * Back button, it is a transcript.
   */
  it("replaces while the search is being typed", () => {
    expect(historyMode({ q: "s" }, { q: "su" })).toBe("replace");
    expect(historyMode({ q: "su" }, { q: "sun" })).toBe("replace");
    expect(historyMode({}, { q: "s" })).toBe("replace");
    expect(historyMode({ q: "sun" }, {})).toBe("replace");
  });

  it("pushes when a filter is actually applied", () => {
    expect(historyMode({}, { buyCountry: "JP" })).toBe("push");
    expect(historyMode({}, { categoryId: "cm1abc" })).toBe("push");
    expect(historyMode({ buyCountry: "JP" }, { buyCountry: "EE" })).toBe(
      "push",
    );
    expect(historyMode({ buyCountry: "JP" }, {})).toBe("push");
  });

  it("pushes when the text changes alongside something else", () => {
    expect(
      historyMode({ q: "sun" }, { q: "sunscreen", buyCountry: "JP" }),
    ).toBe("push");
  });
});

/**
 * The address the list should be at — issue #168.
 *
 * Browse lived at `/` until the landing page took the root, and the line
 * that wrote `/` into the URL on every filter change is the kind of thing a
 * move leaves behind: no error, no 404, just the front door with a query
 * string on it. It is a function now, and this is what the function is for.
 */
describe("where a filtered list lives", () => {
  it("is the path it was given, not a path of its own", () => {
    expect(hrefFor("/needs", { buyCountry: "JP" })).toBe(
      "/needs?buyCountry=JP",
    );
    expect(hrefFor("/somewhere-else", { buyCountry: "JP" })).toBe(
      "/somewhere-else?buyCountry=JP",
    );
  });

  /**
   * NOT `"/needs?"`. A trailing question mark is a different URL from the
   * one without it — Back remembers both, and a shared link carries it
   * forever — and it is what string-joining produces when nobody thinks
   * about the empty case.
   */
  it("is the plain path when nothing is filtered", () => {
    expect(hrefFor("/needs", {})).toBe("/needs");
    expect(hrefFor("/needs", { q: "" })).toBe("/needs");
  });

  it("keeps the order queryFrom decided, so one filter set is one URL", () => {
    const filters: BrowseFilters = {
      q: "sunscreen",
      buyCountry: "JP",
      deliverCountry: "EE",
    };

    expect(hrefFor("/needs", filters)).toBe(
      `/needs?${queryFrom(filters).toString()}`,
    );
  });
});
