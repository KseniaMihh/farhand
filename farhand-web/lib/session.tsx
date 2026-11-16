"use client";

import { createContext, useContext, type ReactNode } from "react";
import type { Session } from "./session-state";

/**
 * Who is signed in, for every screen that needs to know.
 *
 * THE SHAPE DECISION THIS ISSUE OWES AN ANSWER (#93 left it open in
 * app/page.tsx): a session can be read on the server, in a React Server
 * Component, or in the browser. This picks the browser, and the reason is the
 * one that decided the proxy in the first place.
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
 * The cost of choosing the browser is honest and visible: the first paint
 * does not know who you are, so the header renders a third state —
 * "checking" — rather than flickering from signed-out to signed-in.
 *
 * WHAT A SESSION IS lives next door, in session-state.ts, with no React in
 * it. The rule that decides whether somebody sees their own name or a
 * sign-in link is worth stating and testing on its own; what is left here is
 * a `useState`, a `useEffect` and a context.
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
 * Asks the API who the caller is, once, and holds the answer.
 *
 * TODO(#156): `GET /auth/me` on mount.
 *   - `200` → signed-in
 *   - a failure → `outcomeFor(error)`, which is where the rule lives:
 *     "signed-out" and "unknown" are final; "retry" means wait for the next
 *     `RETRY_DELAYS_MS` and ask again, STAYING IN "checking" meanwhile, then
 *     fall to "unknown" once the delays run out.
 *
 * TODO(#156): "unknown" renders as the neutral placeholder, exactly like
 * "checking". The two are kept apart because they call for different words
 * once there is something to say — "still waiting" versus "Farhand is not
 * answering; try again" — not because they look different today.
 *
 * TODO(#156): the retry loop must stop when the provider unmounts, or a
 * test and a navigation both leave a timer running that sets state on
 * something that is gone.
 */
export function SessionProvider({ children }: { children: ReactNode }) {
  // TODO(#156): useState<Session>({ status: "checking" }) + useEffect.
  const value: SessionValue = {
    session: { status: "checking" },
    refresh: () => Promise.resolve(),
    signOut: () => Promise.resolve(),
  };

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
