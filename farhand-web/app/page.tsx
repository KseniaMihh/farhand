"use client";

import { useEffect, useState } from "react";
import { apiGet, ApiFailure, type Page } from "@/lib/api";
import styles from "./page.module.css";

/**
 * Browse open needs — the one screen #93 asks for, end to end.
 *
 * WHY IT RUNS IN THE BROWSER rather than on the server, which is the more
 * idiomatic Next thing to do: the point of this screen is to prove the path a
 * *browser* takes. Fetching on the server would skip the rewrite in
 * next.config.ts, and the rewrite is the thing #93 had to decide
 * (decision 0031). Rendered server-side this page would still work if the
 * cookie arrangement were wrong, which would make it useless as proof.
 *
 * Screens that need a session will want the server-side shape instead, and
 * that is a question for the issue that adds the first one.
 */

/** Only the fields this card draws. The API sends the whole need (#15). */
interface NeedCard {
  id: string;
  title: string;
  description: string;
  buyCountry: string;
  deliverCountry: string;
  currency: string;
  estimatedPrice: number;
  coverPhoto: string | null;
  createdAt: string;
}

/**
 * Money is whole cents everywhere in this product
 * (farhand-api/docs/10-decisions/0006-money-as-integer-cents.md), so the
 * division belongs here, at the edge, and nowhere else.
 */
function price(amount: number, currency: string): string {
  return new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency,
  }).format(amount / 100);
}

type State =
  | { status: "loading" }
  | { status: "ready"; needs: NeedCard[] }
  | { status: "failed"; message: string; requestId?: string };

export default function BrowseNeeds() {
  const [state, setState] = useState<State>({ status: "loading" });

  useEffect(() => {
    const leaving = new AbortController();

    apiGet<Page<NeedCard>>("/needs", {
      signal: leaving.signal,
      query: { limit: 20 },
    })
      .then((page) => {
        setState({ status: "ready", needs: page.items });
      })
      .catch((error: unknown) => {
        // Every failure arrives here in one shape, because lib/api.ts is the
        // only thing in this app that knows what an error body looks like
        // (#4). A screen's job is to decide what to say about it.
        if (error instanceof ApiFailure) {
          setState({
            status: "failed",
            message: error.error.message,
            ...(error.error.requestId === undefined
              ? {}
              : { requestId: error.error.requestId }),
          });
          return;
        }

        // An abort is this component unmounting. Saying nothing is correct.
        if (error instanceof DOMException && error.name === "AbortError")
          return;

        throw error;
      });

    return () => {
      leaving.abort();
    };
  }, []);

  if (state.status === "loading") {
    return (
      <p className={styles.quiet}>
        Asking Farhand for what people need…
        <br />
        <small>
          The API sleeps when nobody is using it, so the first answer can take
          half a minute.
        </small>
      </p>
    );
  }

  if (state.status === "failed") {
    return (
      <div className={styles.failed} role="alert">
        <p>{state.message}</p>
        {state.requestId === undefined ? null : (
          <p className={styles.quiet}>
            If you report this, quote <code>{state.requestId}</code>.
          </p>
        )}
      </div>
    );
  }

  if (state.needs.length === 0) {
    return (
      <p className={styles.quiet}>
        Nobody is asking for anything just now. That is a real answer, not a
        failure.
      </p>
    );
  }

  return (
    <>
      <h1 className={styles.heading}>What people need</h1>
      <ul className={styles.cards}>
        {state.needs.map((need) => (
          <li key={need.id} className={styles.card}>
            {need.coverPhoto === null ? (
              <div className={styles.noPhoto} aria-hidden="true" />
            ) : (
              /* The API answers a path; a path under /api goes through the
                 proxy, which redirects to a signed link that dies in five
                 minutes (#79). An <img> follows that redirect on its own. */
              <img
                className={styles.photo}
                src={`/api${need.coverPhoto}`}
                alt=""
                loading="lazy"
              />
            )}
            <div className={styles.body}>
              <h2 className={styles.title}>{need.title}</h2>
              <p className={styles.route}>
                {need.buyCountry} → {need.deliverCountry} ·{" "}
                {price(need.estimatedPrice, need.currency)}
              </p>
              <p className={styles.description}>{need.description}</p>
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}
