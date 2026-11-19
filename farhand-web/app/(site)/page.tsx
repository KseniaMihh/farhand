"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { NeedCard } from "@/components/need-card";
import { NeedFilters, type Category } from "@/components/need-filters";
import { apiGet, ApiFailure, type Page } from "@/lib/api";
import {
  canLoadMore,
  filtersChanged,
  pageArrived,
  requestFailed,
  visible,
  type Browse,
} from "@/lib/browse-state";
import {
  filtersFrom,
  historyMode,
  isUnfiltered,
  queryFrom,
  type BrowseFilters,
} from "@/lib/browse-filters";
import type { NeedCard as Card } from "@/lib/needs";

/**
 * Browse needs — screen 2.1, issue #166.
 *
 * This replaces the version #93 left here, which was a proof rather than a
 * screen: one request, twenty needs, no filters, no second page, and one
 * empty state where the design has two.
 *
 * WHY IT STILL RUNS IN THE BROWSER, now that the reason has changed. #93
 * fetched here to prove the path a browser takes, which was that issue's
 * whole point. That is settled, and two live reasons replace it:
 *
 * **The vouch.** A server component would fetch from Vercel's own machine
 * with no vouch header (#164), so every visitor's browsing would count as ONE
 * caller against the global by-address limit — the bug #164 closed, back by
 * another door.
 *
 * **The cold start, which matters more day to day.** A server component
 * cannot send the page until the API has answered, and this API sleeps when
 * nobody is using it. That is up to a minute of blank tab. Fetching in the
 * browser puts the header, the filters and a loading state on screen at once,
 * and only the list waits. It is the same reasoning as decision 0032.
 *
 * Doing it on the server is a version 2 idea with the vouch to solve first,
 * and it is written down in docs/08-scope.md so that nobody optimises this
 * into a server component and quietly undoes #164.
 */
function Browsing() {
  const router = useRouter();
  const params = useSearchParams();

  // The filters are read from the URL on every render rather than copied into
  // state: the URL is the one that survives a reload and a Back press, so a
  // second copy could only ever disagree with it.
  const filters = filtersFrom(new URLSearchParams(params.toString()));
  const key = queryFrom(filters).toString();

  const [state, setState] = useState<Browse>({ status: "loading", key });
  const [categories, setCategories] = useState<Category[]>([]);

  const ask = useCallback(
    (forKey: string, cursor: string | null, signal: AbortSignal) => {
      apiGet<Page<Card>>("/needs", {
        signal,
        query: {
          ...Object.fromEntries(new URLSearchParams(forKey)),
          limit: 20,
          ...(cursor === null ? {} : { cursor }),
        },
      })
        .then((page) => {
          setState((current) => pageArrived(current, page, forKey));
        })
        .catch((error: unknown) => {
          // An abort is this component unmounting, or a filter moving on.
          // Saying nothing is correct.
          if (error instanceof DOMException && error.name === "AbortError")
            return;

          if (error instanceof ApiFailure) {
            setState((current) =>
              requestFailed(
                current,
                {
                  message: error.error.message,
                  ...(error.error.requestId === undefined
                    ? {}
                    : { requestId: error.error.requestId }),
                },
                forKey,
              ),
            );
            return;
          }

          throw error;
        });
    },
    [],
  );

  /**
   * One request per question, and `key` is the question.
   *
   * NO "HAVE I ALREADY ASKED THIS" GUARD IN A REF. The first version kept one
   * and the screen hung on every load: Strict Mode runs an effect, cleans it
   * up and runs it again, so the first request was aborted by its own cleanup
   * and the second run saw the ref already set and never asked at all. The
   * dependency list is the guard — `key` only changes when the filters do.
   */
  useEffect(() => {
    const leaving = new AbortController();
    setState(filtersChanged(key));
    ask(key, null, leaving.signal);

    return () => {
      leaving.abort();
    };
  }, [key, ask]);

  useEffect(() => {
    const leaving = new AbortController();

    apiGet<{ categories: Category[] }>("/categories", {
      signal: leaving.signal,
    })
      .then((answer) => {
        setCategories(answer.categories);
      })
      .catch(() => {
        // A filter that cannot be offered is not a broken screen. The list
        // still works; the select stays empty.
      });

    return () => {
      leaving.abort();
    };
  }, []);

  function go(next: BrowseFilters, mode: "push" | "replace") {
    const query = queryFrom(next).toString();
    const href = query === "" ? "/" : `/?${query}`;

    if (mode === "replace") router.replace(href, { scroll: false });
    else router.push(href, { scroll: false });
  }

  function more() {
    if (state.status !== "ready" || state.nextCursor === null) return;

    const cursor = state.nextCursor;
    setState({ status: "appending", key, needs: visible(state), cursor });
    ask(key, cursor, new AbortController().signal);
  }

  const needs = visible(state);

  return (
    <>
      <h1 className="mb-6 font-serif text-3xl text-pine">What people need</h1>

      <NeedFilters
        filters={filters}
        categories={categories}
        onChange={(next) => {
          go(next, historyMode(filters, next));
        }}
        onSubmit={(next) => {
          go(next, "push");
        }}
      />

      {state.status === "loading" && (
        <p className="text-muted">
          Asking Farhand for what people need…
          <br />
          <small>
            The API sleeps when nobody is using it, so the first answer can take
            half a minute.
          </small>
        </p>
      )}

      {state.status === "failed" && (
        <div className="tint-error rounded-lg p-4" role="alert">
          <p>{state.message}</p>
          {state.requestId !== undefined && (
            <p className="mt-2 text-sm">
              If you report this, quote <code>{state.requestId}</code>.
            </p>
          )}
        </div>
      )}

      {/*
        THE TWO EMPTY STATES, which is the part of this screen with an idea in
        it. Both answers are `[]`; only the filters say which story it is, and
        only one of the two has a way out.
      */}
      {state.status === "ready" && needs.length === 0 && (
        <div className="rounded-xl border border-line bg-card p-8 text-center">
          {isUnfiltered(filters) ? (
            <p className="text-muted">
              Nobody is asking for anything just now. That is a real answer, not
              a failure.
            </p>
          ) : (
            <>
              <p className="text-pine">Nothing matches what you asked for.</p>
              <p className="mt-3">
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => {
                    go({}, "push");
                  }}
                >
                  Clear the filters
                </button>
              </p>
            </>
          )}
        </div>
      )}

      {needs.length > 0 && (
        <ul className="grid list-none grid-cols-1 gap-5 p-0 sm:grid-cols-2 lg:grid-cols-3">
          {needs.map((need) => (
            <NeedCard
              key={need.id}
              need={need}
              categoryName={
                categories.find((category) => category.id === need.categoryId)
                  ?.name
              }
            />
          ))}
        </ul>
      )}

      {/*
        "Show more", never page numbers: a cursor has no page count and cannot
        jump, and a control implying otherwise is a lie about the API.
      */}
      {(canLoadMore(state) || state.status === "appending") && (
        <p className="mt-8 text-center">
          <button
            type="button"
            className="btn btn-secondary"
            onClick={more}
            disabled={state.status === "appending"}
          >
            {state.status === "appending" ? "Looking…" : "Show more"}
          </button>
        </p>
      )}
    </>
  );
}

/**
 * `useSearchParams` asks for a Suspense boundary, because it is the one hook
 * that cannot be answered while the page is being prerendered.
 */
export default function BrowseNeeds() {
  return (
    <Suspense fallback={<p className="text-muted">Loading…</p>}>
      <Browsing />
    </Suspense>
  );
}
