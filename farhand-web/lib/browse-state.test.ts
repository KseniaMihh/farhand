import { describe, expect, it } from "vitest";
import {
  canLoadMore,
  filtersChanged,
  pageArrived,
  requestFailed,
  visible,
  type Browse,
} from "./browse-state";
import type { NeedCard } from "./needs";

/**
 * What a browsing screen can be in the middle of — issue #166.
 *
 * These tests are the specification. They fail until the TODOs in
 * browse-state.ts are filled in.
 *
 *   npm test -- browse-state
 *
 * THE ONE THAT MATTERS MOST is the stale answer. Somebody presses "more",
 * then changes the country before the answer arrives. Aborting the request
 * covers the ordinary case and not the race — a response already on the wire
 * still resolves — so the state machine has to recognise an answer to a
 * question nobody is asking any more and drop it. It is the classic bug in
 * this exact kind of code, and the only reason the `key` is in the type.
 */

let n = 0;
function need(title = `A need ${String((n += 1))}`): NeedCard {
  return {
    id: `cm${String(n)}`,
    title,
    description: "…",
    buyCountry: "JP",
    deliverCountry: "EE",
    currency: "EUR",
    estimatedPrice: 2400,
    thankYouAmount: 0,
    coverPhoto: null,
    categoryId: "cm1cat",
    createdAt: "2026-11-19T10:00:00.000Z",
  };
}

const JP = "buyCountry=JP";
const EE = "buyCountry=EE";

describe("what is on screen", () => {
  it("is nothing while the first page is still coming", () => {
    expect(visible({ status: "loading", key: JP })).toEqual([]);
  });

  it("is the list once it is here", () => {
    const needs = [need(), need()];

    expect(
      visible({ status: "ready", key: JP, needs, nextCursor: null }),
    ).toEqual(needs);
  });

  /** The whole point of a separate appending state: the list stays up. */
  it("is still the list while the NEXT page is coming", () => {
    const needs = [need(), need()];

    expect(
      visible({ status: "appending", key: JP, needs, cursor: "abc" }),
    ).toEqual(needs);
  });

  it("is nothing when the first page failed", () => {
    expect(visible({ status: "failed", key: JP, message: "No" })).toEqual([]);
  });
});

describe("whether there is more to ask for", () => {
  it("there is, when a cursor came back", () => {
    expect(
      canLoadMore({ status: "ready", key: JP, needs: [], nextCursor: "abc" }),
    ).toBe(true);
  });

  it("there is not, on the last page", () => {
    expect(
      canLoadMore({ status: "ready", key: JP, needs: [], nextCursor: null }),
    ).toBe(false);
  });

  /**
   * A control that stays live while the request is in flight sends the same
   * cursor twice, and the same page appears twice in the list.
   */
  it("there is not, while one is already being asked for", () => {
    expect(
      canLoadMore({
        status: "appending",
        key: JP,
        needs: [need()],
        cursor: "abc",
      }),
    ).toBe(false);
  });

  it("there is not, before anything has arrived", () => {
    expect(canLoadMore({ status: "loading", key: JP })).toBe(false);
  });
});

describe("a page arriving", () => {
  it("replaces, when it is the first one", () => {
    const needs = [need(), need()];

    const next = pageArrived(
      { status: "loading", key: JP },
      { items: needs, nextCursor: "abc" },
      JP,
    );

    expect(next).toEqual({
      status: "ready",
      key: JP,
      needs,
      nextCursor: "abc",
    });
  });

  it("appends, when it is the next one", () => {
    const first = [need("First"), need("Second")];
    const second = [need("Third")];

    const next = pageArrived(
      { status: "appending", key: JP, needs: first, cursor: "abc" },
      { items: second, nextCursor: null },
      JP,
    );

    expect(visible(next).map((item) => item.title)).toEqual([
      "First",
      "Second",
      "Third",
    ]);
    expect(next).toMatchObject({ status: "ready", nextCursor: null });
  });

  it("an empty last page just ends the list", () => {
    const first = [need("First")];

    const next = pageArrived(
      { status: "appending", key: JP, needs: first, cursor: "abc" },
      { items: [], nextCursor: null },
      JP,
    );

    expect(visible(next)).toEqual(first);
    expect(canLoadMore(next)).toBe(false);
  });

  /**
   * THE RACE. "More" is pressed, the country is changed, and then the page
   * that was already on its way arrives. It belongs to the old list and must
   * not be added to the new one.
   */
  it("is ignored when the filters have moved on", () => {
    const fresh: Browse = { status: "loading", key: EE };

    const next = pageArrived(
      fresh,
      { items: [need("From the old filter")], nextCursor: "abc" },
      JP,
    );

    expect(next).toEqual(fresh);
  });

  it("is ignored even when it would have appended", () => {
    const current: Browse = {
      status: "appending",
      key: EE,
      needs: [need("Kept")],
      cursor: "xyz",
    };

    const next = pageArrived(
      current,
      { items: [need("Stale")], nextCursor: null },
      JP,
    );

    expect(next).toEqual(current);
  });
});

describe("a request failing", () => {
  it("is the whole screen, when the first page failed", () => {
    const next = requestFailed(
      { status: "loading", key: JP },
      { message: "The API did not answer", requestId: "req-1" },
      JP,
    );

    expect(next).toEqual({
      status: "failed",
      key: JP,
      message: "The API did not answer",
      requestId: "req-1",
    });
  });

  /**
   * Taking away the list somebody is reading because page four did not arrive
   * is the wrong answer. They keep what they have and can press again.
   */
  it("keeps the list, when it was the next page that failed", () => {
    const needs = [need("First"), need("Second")];

    const next = requestFailed(
      { status: "appending", key: JP, needs, cursor: "abc" },
      { message: "The API did not answer" },
      JP,
    );

    expect(visible(next)).toEqual(needs);
    expect(next.status).toBe("ready");
    expect(canLoadMore(next)).toBe(true);
  });

  it("is ignored when the filters have moved on", () => {
    const fresh: Browse = { status: "loading", key: EE };

    const next = requestFailed(fresh, { message: "Too late" }, JP);

    expect(next).toEqual(fresh);
  });
});

describe("changing the filters", () => {
  /**
   * The needs on screen answered a different question, and showing them under
   * a new filter is a lie for as long as the request takes.
   */
  it("starts again, keeping nothing", () => {
    expect(filtersChanged(EE)).toEqual({ status: "loading", key: EE });
  });
});
