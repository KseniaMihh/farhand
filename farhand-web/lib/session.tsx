"use client";

import { createContext, useContext, type ReactNode } from "react";

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
 * is exactly one way.
 *
 * The cost of choosing the browser is honest and visible: the first paint
 * does not know who you are, so the header renders a third state —
 * "checking" — rather than flickering from signed-out to signed-in. That is
 * why `Session` has three cases and not two.
 */

/** What `GET /auth/me` answers. Only the fields a screen in this issue draws. */
export interface Me {
  id: string;
  email: string;
  emailVerified: boolean;
  profile: {
    displayName: string;
    countryCode: string;
  };
}

/**
 * Three states, not two.
 *
 * "checking" is a real answer and the header must have something to say
 * during it, or a signed-in person sees "Sign in" for a moment on every cold
 * load and learns not to trust the header.
 */
export type Session =
  | { status: "checking" }
  | { status: "signed-in"; me: Me }
  | { status: "signed-out" };

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
 * TODO(#156): call `GET /auth/me` on mount.
 *   - `200` → signed-in
 *   - `401` → signed-out. This is the ordinary answer for a visitor, NOT a
 *     failure, and must never reach a screen as an error.
 *   - anything else (including `UNREACHABLE`, a sleeping free-tier API) →
 *     also signed-out, because the app cannot claim a session it could not
 *     confirm. Worth a console line and nothing louder: a signed-out home
 *     page is a usable page.
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
