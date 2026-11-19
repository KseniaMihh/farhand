"use client";

import { use, useEffect, useState } from "react";
import { notFound } from "next/navigation";
import { apiGet, ApiFailure } from "@/lib/api";
import { countryName } from "@/lib/countries";
import { photoSrc, price, type Need } from "@/lib/needs";

/**
 * One need's own page — screen 2.2, issue #166.
 *
 * WHAT "PUBLIC" MEANS HERE IS NOT ONE THING. `GET /needs/:id` answers
 * differently depending on who is asking:
 *
 *   its requester   any status, their own drafts included   → 2.2c
 *   anyone else     OPEN and MATCHED only                   → 2.2, 2.2a
 *   anything else   404, deliberately NOT 403
 *
 * The `404` is a decision, not an accident: a draft nobody published must not
 * be discoverable by trying ids, and `403` would confirm that one exists. So
 * this screen cannot tell "no such need" from "not yours to see", and it must
 * not try — both are the not-found page.
 */
type State =
  | { status: "loading" }
  | { status: "ready"; need: Need }
  | { status: "missing" }
  | { status: "failed"; message: string; requestId?: string };

export default function NeedPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const [state, setState] = useState<State>({ status: "loading" });
  const [categoryName, setCategoryName] = useState<string | undefined>(
    undefined,
  );

  useEffect(() => {
    const leaving = new AbortController();

    apiGet<{ need: Need }>(`/needs/${id}`, { signal: leaving.signal })
      .then((answer) => {
        setState({ status: "ready", need: answer.need });
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError")
          return;

        if (error instanceof ApiFailure) {
          // Both stories arrive as 404, and this screen must not try to tell
          // them apart — see the note above.
          setState(
            error.status === 404
              ? { status: "missing" }
              : {
                  status: "failed",
                  message: error.error.message,
                  ...(error.error.requestId === undefined
                    ? {}
                    : { requestId: error.error.requestId }),
                },
          );
          return;
        }

        throw error;
      });

    return () => {
      leaving.abort();
    };
  }, [id]);

  // The names live in `GET /categories` (#159), which is public and cached
  // for an hour, so asking for it here costs a page almost nothing and keeps
  // the need itself to one request.
  useEffect(() => {
    if (state.status !== "ready") return;

    const leaving = new AbortController();
    const wanted = state.need.categoryId;

    apiGet<{ categories: { id: string; name: string }[] }>("/categories", {
      signal: leaving.signal,
    })
      .then((answer) => {
        setCategoryName(
          answer.categories.find((category) => category.id === wanted)?.name,
        );
      })
      .catch(() => {
        // A missing label is not a broken page.
      });

    return () => {
      leaving.abort();
    };
  }, [state]);

  /*
    NOT FROM THE EFFECT. `notFound()` works by throwing, and a throw inside an
    effect is not the case its documentation is written about — the page has
    already rendered by then. Called here, during render, it is the shape Next
    supports, and `./not-found.tsx` is what it reaches.
  */
  if (state.status === "missing") notFound();

  if (state.status === "loading") {
    return <p className="text-muted">Looking for it…</p>;
  }

  if (state.status === "failed") {
    return (
      <div className="tint-error rounded-lg p-4" role="alert">
        <p>{state.message}</p>
        {state.requestId !== undefined && (
          <p className="mt-2 text-sm">
            If you report this, quote <code>{state.requestId}</code>.
          </p>
        )}
      </div>
    );
  }

  const { need } = state;

  return (
    <article>
      <h1 className="font-serif text-3xl text-pine">{need.title}</h1>

      <p className="mt-2 text-muted">
        {countryName(need.buyCountry)} → {countryName(need.deliverCountry)}
        {categoryName !== undefined && (
          <>
            {" · "}
            <span className="rounded-full bg-need-tint px-2 py-1 text-xs text-need-ink">
              {categoryName}
            </span>
          </>
        )}
      </p>

      {/*
        2.2a — MATCHED is still readable, because a deal is running on it and
        both sides need to see what was agreed. It has to SAY it is taken: a
        page identical to an open one is the defect here. There is no way to
        offer help from this screen in either case — that is the next issue —
        so this is a statement rather than a disabled button.
      */}
      {need.status === "MATCHED" && (
        <p className="tint-paused mt-4 rounded-lg px-4 py-3">
          Somebody is already helping with this one.
        </p>
      )}

      {/*
        2.2c — the requester's own view. `GET /needs/:id` gives them any
        status, including a draft nobody else can see, so the page says which
        it is. Read-only: editing and deleting belong to the posting issue,
        where PATCH and DELETE live.
      */}
      {need.status !== "OPEN" && need.status !== "MATCHED" && (
        <p className="tint-warning mt-4 rounded-lg px-4 py-3">
          Only you can see this. Its status is {need.status.toLowerCase()}.
        </p>
      )}

      {/* Oldest first — the order they were added — and `[]` is a real case. */}
      {need.photos.length > 0 && (
        <ul className="mt-6 grid list-none grid-cols-2 gap-3 p-0 sm:grid-cols-3">
          {need.photos.map((photo) => (
            <li key={photo.id}>
              <img
                className="aspect-square w-full rounded-lg object-cover"
                src={photoSrc(photo.url)}
                alt=""
                loading="lazy"
              />
            </li>
          ))}
        </ul>
      )}

      <div className="mt-6 rounded-xl border border-line bg-card p-5">
        {/* TWO LINES, NEVER A TOTAL — see the note in lib/needs.ts. */}
        <p className="font-serif text-2xl text-pine">
          {price(need.estimatedPrice, need.currency)}
          <span className="ml-2 align-middle text-sm text-muted">
            estimated for the product
          </span>
        </p>
        {need.thankYouAmount > 0 && (
          <p className="mt-1 text-pine">
            {price(need.thankYouAmount, need.currency)}
            <span className="ml-2 text-sm text-muted">
              offered as a thank-you
            </span>
          </p>
        )}
      </div>

      <p className="mt-6 whitespace-pre-line text-pine">{need.description}</p>

      {(need.storeName !== null || need.productUrl !== null) && (
        <p className="mt-4 text-sm text-muted">
          {need.storeName !== null && <>From {need.storeName}. </>}
          {need.productUrl !== null && (
            <a
              href={need.productUrl}
              // A link somebody else typed: it leaves this site, and it does
              // not get to know where it was followed from.
              rel="noreferrer noopener nofollow"
              target="_blank"
            >
              The product they linked to (opens elsewhere)
            </a>
          )}
        </p>
      )}

      {/*
        THE REQUESTER IS NOT NAMED HERE, and that is measured rather than
        chosen: this answer carries `requesterId` and nothing else about them.
        Naming them means a second request to the public profile — screen 2.5,
        not one of the seven, and nowhere for a link to point yet. Where the
        design asks for what the contract does not carry, build less.
      */}
    </article>
  );
}
