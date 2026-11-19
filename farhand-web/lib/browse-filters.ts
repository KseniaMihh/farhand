/**
 * What you are asking the list for, and where that lives — issue #166.
 *
 * IN THE URL, not in a `useState`. A filtered list is a thing people send to
 * each other, reload, and press Back out of. Keeping the filters in the query
 * string gets all three for free and costs nothing; keeping them in component
 * state means a reload silently shows a different list from the one the
 * address bar claims.
 *
 * This file is the whole rule, with no React in it, so it can be tested
 * directly — the same reason `safe-next.ts` exists.
 *
 * THE FOUR FILTERS ARE THE API'S FOUR (docs/06-api-contract.md): an absent
 * one narrows nothing, and the ones that are present all have to match. There
 * is deliberately no fifth: a readable `?category=beauty-care` is a version 2
 * idea, and a sort order is not in the design — the list is newest first and
 * that is the only order the API has.
 */

/** Exactly the filters `GET /needs` understands. */
export interface BrowseFilters {
  /** Two letters. Where the product must be bought. */
  buyCountry?: string;
  /** Two letters. Where it must be shipped. */
  deliverCountry?: string;
  /** A category id — not a slug. The slug filter is a version 2 idea. */
  categoryId?: string;
  /** Free text, matched against the title and the description. */
  q?: string;
}

/** The query keys this screen owns, so nothing else in the URL is disturbed. */
export const FILTER_KEYS = [
  "buyCountry",
  "deliverCountry",
  "categoryId",
  "q",
] as const;

/**
 * Reads the filters out of a URL's query string.
 *
 * A key that is absent, empty, or only spaces is **not a filter**. `?q=` is
 * what somebody typing a letter and deleting it leaves behind, and read as a
 * filter it asks the API to match the empty string — which narrows the list
 * to nothing and then tells them nothing matches their filters.
 *
 * Anything else in the query string is left alone and never echoed back, so a
 * link with a newsletter's tracking on it does not become a filter.
 */
export function filtersFrom(params: URLSearchParams): BrowseFilters {
  const filters: BrowseFilters = {};

  const text = (key: string): string | undefined => {
    const raw = params.get(key);
    if (raw === null) return undefined;
    const trimmed = raw.trim();
    return trimmed === "" ? undefined : trimmed;
  };

  // Countries are compared without case at the API, so they are normalised
  // here rather than sent as typed — otherwise `?buyCountry=jp` and
  // `?buyCountry=JP` are two different cache keys for one question.
  const buyCountry = text("buyCountry")?.toUpperCase();
  const deliverCountry = text("deliverCountry")?.toUpperCase();
  const categoryId = text("categoryId");
  const q = text("q");

  if (buyCountry !== undefined) filters.buyCountry = buyCountry;
  if (deliverCountry !== undefined) filters.deliverCountry = deliverCountry;
  if (categoryId !== undefined) filters.categoryId = categoryId;
  if (q !== undefined) filters.q = q;

  return filters;
}

/**
 * Writes the filters back into a query string.
 *
 * An empty filter is **removed**, never written as empty, so clearing one
 * gives back the plain URL a person can read — and `filtersFrom` does not
 * have to un-decide it on the way back in.
 *
 * The key order is `FILTER_KEYS`, so the same filters always produce the same
 * string. That is what makes this usable as the state machine's key as well
 * as the URL's query.
 *
 * A cursor never appears here. Paging is not a filter, and a URL carrying one
 * would restore page three of a list that has changed underneath it.
 */
export function queryFrom(filters: BrowseFilters): URLSearchParams {
  const query = new URLSearchParams();

  for (const key of FILTER_KEYS) {
    const value = filters[key]?.trim();
    if (value !== undefined && value !== "") query.set(key, value);
  }

  return query;
}

/**
 * Whether anything is being asked for at all.
 *
 * THIS IS WHAT TELLS 2.1a FROM 2.1b. An empty list means two completely
 * different things: nobody has posted anything, or nothing matches what you
 * asked for — and only the second one has a way out of it. A screen cannot
 * tell them apart from the answer alone, because both answers are `[]`.
 *
 * **An empty search box counts as absent.** Somebody who typed a letter and
 * deleted it must not be told "nothing matches your filters" when the truth
 * is that nothing has been posted.
 *
 * Asking `queryFrom` rather than checking the four fields again means there
 * is one definition of "a filter that counts", and this cannot drift from
 * what is actually sent to the API.
 */
export function isUnfiltered(filters: BrowseFilters): boolean {
  return queryFrom(filters).toString() === "";
}

/**
 * Whether a change to the filters is worth a step in the browser's history.
 *
 * TYPING IS NOT NAVIGATION. With the filters in the URL — which is right,
 * and the reason is at the top of this file — a `push` per keystroke makes
 * Back walk the person through "s", "su", "sun", "suns" before it leaves the
 * page. That is not a Back button any more, it is a transcript.
 *
 * TODO (#166): `"replace"` while the text is being typed, `"push"` when a
 * filter is actually applied — a country or a category chosen, the search
 * submitted, everything cleared. The test worth writing is the one that
 * shows two successive edits of `q` leaving ONE history entry.
 */
export type HistoryMode = "push" | "replace";

/**
 * `"replace"` when the ONLY thing that differs is `q`, and `"push"`
 * otherwise. Typing is editing one thing; choosing a country or a category is
 * going somewhere.
 *
 * A pure function rather than a flag the component sets, so the rule can be
 * tested without a browser.
 */
export function historyMode(
  previous: BrowseFilters,
  next: BrowseFilters,
): HistoryMode {
  const sameBut = (key: keyof BrowseFilters): boolean =>
    FILTER_KEYS.filter((other) => other !== key).every(
      (other) => (previous[other] ?? "") === (next[other] ?? ""),
    );

  return sameBut("q") ? "replace" : "push";
}

/**
 * The address the browse list should be at, given where it already is —
 * issue #168.
 *
 * THE PATH IS PASSED IN, NOT WRITTEN DOWN. This used to be `"/"` inside the
 * page, because browse WAS the root; #168 gave the root to the landing page
 * and moved browse to `/needs`, and the symptom of missing this line would
 * have been silent — applying a filter navigates to the front door carrying
 * a query string it has no use for. No error, no 404, just the wrong screen.
 *
 * A function rather than two lines in the component so that the one thing
 * worth saying about it can be said in a test: an empty filter set is the
 * plain path, and NOT the plain path with a `?` stuck on the end, which is a
 * different URL that every Back button and every share remembers separately.
 */
export function hrefFor(pathname: string, filters: BrowseFilters): string {
  const query = queryFrom(filters).toString();

  return query === "" ? pathname : `${pathname}?${query}`;
}
