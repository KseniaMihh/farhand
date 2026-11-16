"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { apiGet, apiSendEmpty } from "./api";
import {
  outcomeFor,
  RETRY_DELAYS_MS,
  type MeResponse,
  type Session,
} from "./session-state";

/**
 * Who is signed in, for every screen that needs to know.
 *
 * THE SHAPE DECISION #93 LEFT OPEN in app/(site)/page.tsx: a session can be
 * read on the server, in a React Server Component, or in the browser. This
 * picks the browser, and the reason is the one that decided the proxy in the
 * first place.
 *
 * The session cookie is `httpOnly` and `sameSite: "lax"`, set by the API and
 * reachable by the browser alone. A server component fetching `/auth/me`
 * would not go through next.config.ts's rewrite — rewrites are a browser-path
 * thing — so it would need the absolute API URL and would have to lift the
 * cookie out of the incoming request and re-attach it by hand. That is a
 * second way of talking to the API, with its own rules about which cookie
 * goes where, in an app whose one architectural decision (0031) is that there
 * is exactly one.
 *
 * The cost is honest and visible: the first paint does not know who you are,
 * so the header has a neutral state rather than a guess.
 *
 * WHAT A SESSION IS lives next door, in session-state.ts, with no React in
 * it. What is here is a `useState`, a `useEffect` and a context.
 */

export type { AccountStatus, Me, MeResponse, Session } from "./session-state";
export { isSettled, outcomeFor, RETRY_DELAYS_MS } from "./session-state";

export interface SessionValue {
  session: Session;
  /**
   * Called after signing in, registering or verifying — anything that changes
   * what `/auth/me` would answer. Re-asks rather than being handed a user, so
   * the API stays the only thing that decides who you are.
   */
  refresh: () => Promise<void>;
  /** `POST /auth/logout`, then back to signed-out. */
  signOut: () => Promise<void>;
}

const SessionContext = createContext<SessionValue | null>(null);

/**
 * A pause that gives up when the caller does, and says which happened.
 *
 * Reporting the reason rather than just resolving: the caller has to know
 * whether to carry on, and asking `signal.aborted` after awaiting is a check
 * TypeScript narrows away — it cannot see that waiting is when the answer
 * changes.
 */
function wait(ms: number, signal: AbortSignal): Promise<"waited" | "aborted"> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve("waited");
    }, ms);

    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve("aborted");
      },
      { once: true },
    );
  });
}

/**
 * Asks the API who the caller is, and holds the answer.
 */
export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session>({ status: "checking" });

  const load = useCallback(async (signal: AbortSignal) => {
    // `attempt` indexes RETRY_DELAYS_MS, so the loop ends when the delays do.
    for (let attempt = 0; ; attempt += 1) {
      try {
        const { user } = await apiGet<MeResponse>("/auth/me", { signal });

        setSession({ status: "signed-in", me: user });
        return;
      } catch (error) {
        // Not a failure: this component is going away, and whoever aborted it
        // does not want a state change out of us.
        if (signal.aborted) return;

        const outcome = outcomeFor(error);

        if (outcome === "signed-out") {
          setSession({ status: "signed-out" });
          return;
        }

        if (outcome === "unknown") {
          setSession({ status: "unknown" });
          return;
        }

        // "retry" — the API is probably waking up. Stay in "checking" and ask
        // again; fall to "unknown" only once the waiting runs out.
        const delay = RETRY_DELAYS_MS[attempt];

        if (delay === undefined) {
          setSession({ status: "unknown" });
          return;
        }

        if ((await wait(delay, signal)) === "aborted") return;
      }
    }
  }, []);

  useEffect(() => {
    const leaving = new AbortController();

    void load(leaving.signal);

    // Without this, a navigation during the retry loop leaves a timer running
    // that sets state on a component that is gone.
    return () => {
      leaving.abort();
    };
  }, [load]);

  const value = useMemo<SessionValue>(
    () => ({
      session,

      refresh: async () => {
        setSession({ status: "checking" });
        await load(new AbortController().signal);
      },

      signOut: async () => {
        try {
          await apiSendEmpty("POST", "/auth/logout");
        } catch {
          // Deliberately swallowed, and worth being honest about: if the API
          // cannot be reached, the row it would have deleted still exists and
          // the cookie still points at it. Showing somebody as signed in when
          // they have asked not to be is the worse of the two wrongs, so the
          // local state goes either way — and the next request will find out.
        }

        setSession({ status: "signed-out" });
      },
    }),
    [session, load],
  );

  return (
    <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
  );
}

/**
 * The session, from anywhere inside the provider.
 *
 * Throws outside it rather than returning a "signed-out" that is really "you
 * forgot the provider" — those are different bugs and only one of them is
 * worth finding at 3am.
 */
export function useSession(): SessionValue {
  const value = useContext(SessionContext);

  if (value === null) {
    throw new Error("useSession was called outside <SessionProvider>");
  }

  return value;
}
