import type { NeedCard } from "./needs";

/**
 * What a browsing screen can be in the middle of — issue #166.
 *
 * No React, so the rule is testable on its own. `session-state.ts` is the
 * same shape and exists for the same reason.
 *
 * TWO IDEAS LIVE HERE, and both of them are bugs if they are left to a
 * component.
 *
 * **`appending` is not `loading`.** A list with a "show more" has two kinds
 * of waiting: the first page, where there is nothing on screen yet, and the
 * next page, where there is a list the person is reading and it must not be
 * replaced by a spinner. Collapsing them is how a list flickers back to the
 * top every time somebody asks for more.
 *
 * **Every state carries the `key` it was asked for.** Somebody presses
 * "more", then changes the country before the answer arrives — and the late
 * answer belongs to a question nobody is asking any more. An answer is only
 * ever taken when its key still matches, which is the classic bug in exactly
 * this kind of code and the reason the key is in the type rather than in a
 * ref somebody remembers to check.
 *
 * The key is `queryFrom(filters).toString()`: the same filters always make
 * the same string, and different ones never collide, because that function
 * already fixes the order for the URL's sake.
 */
export type Browse =
  | { status: "loading"; key: string }
  | {
      status: "ready";
      key: string;
      needs: NeedCard[];
      nextCursor: string | null;
    }
  | {
      status: "appending";
      key: string;
      needs: NeedCard[];
      /** The cursor being asked for, so a second click cannot send it twice. */
      cursor: string;
    }
  | { status: "failed"; key: string; message: string; requestId?: string };

/** The needs to draw right now, whatever is happening. */
export function visible(state: Browse): NeedCard[] {
  return state.status === "ready" || state.status === "appending"
    ? state.needs
    : [];
}

/**
 * Whether there is another page to ask for.
 *
 * Only when `ready` and a cursor came back. Never while appending — the
 * request is already in flight, and a control that stays clickable sends the
 * same cursor twice and shows the same page twice.
 */
export function canLoadMore(state: Browse): boolean {
  return state.status === "ready" && state.nextCursor !== null;
}

/**
 * One page has arrived, for the question `key` was asked about.
 *
 * A key that is not the current one is **ignored entirely** — the state comes
 * back unchanged. From `loading` the page replaces what is there; from
 * `appending` it is added to it. That difference is the whole function, and
 * it is why this is not a `setState` inside a component.
 */
export function pageArrived(
  state: Browse,
  page: { items: NeedCard[]; nextCursor: string | null },
  key: string,
): Browse {
  if (key !== state.key) return state;

  return {
    status: "ready",
    key,
    needs: [...visible(state), ...page.items],
    nextCursor: page.nextCursor,
  };
}

/**
 * A request failed, for the question `key` was asked about.
 *
 * A stale key is ignored, exactly as above.
 *
 * **Failing to append does not throw away the list.** Dropping what somebody
 * is reading because page four did not arrive is the wrong answer; going back
 * to `ready` with the needs kept, so they can press again, is the right one.
 * Only a failure of the FIRST page has nothing to keep.
 */
export function requestFailed(
  state: Browse,
  failure: { message: string; requestId?: string },
  key: string,
): Browse {
  if (key !== state.key) return state;

  const needs = visible(state);

  if (needs.length > 0) {
    // The cursor it failed on is still the next one to try, so the control
    // comes back rather than the list disappearing.
    return {
      status: "ready",
      key,
      needs,
      nextCursor: state.status === "appending" ? state.cursor : null,
    };
  }

  return {
    status: "failed",
    key,
    message: failure.message,
    ...(failure.requestId === undefined
      ? {}
      : { requestId: failure.requestId }),
  };
}

/**
 * The filters changed, so the list starts again under a new key.
 *
 * Back to `loading`, with nothing kept: the needs on screen answered a
 * different question, and showing them under a new filter is a lie for as
 * long as the request takes. Anything still in flight for the old key is
 * ignored when it lands, which is what the key is for.
 */
export function filtersChanged(key: string): Browse {
  return { status: "loading", key };
}
