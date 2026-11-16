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
 * is exactly one.
 *
 * The cost of choosing the browser is honest and visible: the first paint
 * does not know who you are, so the header renders a third state —
 * "checking" — rather than flickering from signed-out to signed-in. That is
 * why `Session` has three cases and not two.
 */

/** `AccountStatus` in schema.prisma. `DELETED` cannot sign in, but the type
 *  is the database's and not a subset invented here. */
export type AccountStatus = "ACTIVE" | "SUSPENDED" | "BANNED" | "DELETED";

/**
 * What `GET /auth/me` answers, trimmed to what the screens in this issue
 * draw. The API sends more (`role`, `emailNotifications`); a field arrives
 * here when a screen needs it, the same habit as `NeedCard` in app/page.tsx.
 *
 * `status` and `suspendedUntil` ARE here, and the API put them there for this
 * exact purpose — routes/auth.ts says so: "so the frontend can show 'your
 * account is suspended until …'". What is deliberately absent from a profile
 * is the PUBLIC one, `GET /users/:id`; this is the caller's own account and
 * holds more.
 *
 * `profile` is nullable because the API types it that way. Registering always
 * makes one, so this is a case nothing here can produce — which is exactly
 * why it must not be asserted away.
 */
export interface Me {
  id: string;
  email: string;
  emailVerified: boolean;
  status: AccountStatus;
  /** ISO 8601, or null. Null with `SUSPENDED` means "until a moderator lifts
   *  it", not "not suspended" — the status is what says that. */
  suspendedUntil: string | null;
  profile: {
    displayName: string;
    countryCode: string;
  } | null;
}

/** The envelope. Every reply in this API is a named object, never a bare one. */
export interface MeResponse {
  user: Me;
}

/**
 * Four states, and the fourth is the one that is easy to get wrong.
 *
 * "checking" is a real answer, and the header must have something to say
 * during it, or a signed-in person sees "Sign in" for a moment on every cold
 * load and learns not to trust the header.
 *
 * "unknown" is what happens when the API did not answer at all, and it must
 * NOT collapse into "signed-out". On the free plan the API sleeps after
 * fifteen quiet minutes and takes most of a minute to wake; treating that
 * silence as "signed out" means a signed-in person who comes back after lunch
 * is shown "Sign in", and — once there are protected screens — redirected to
 * it, while their session is perfectly valid. That is precisely the false
 * answer "checking" exists to prevent, arriving by a different door.
 *
 * ONLY A 401 MEANS SIGNED OUT. Everything else means "not known yet".
 */
export type Session =
  | { status: "checking" }
  | { status: "signed-in"; me: Me }
  | { status: "signed-out" }
  | { status: "unknown" };

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

/**
 * Whether a screen may act on the session yet.
 *
 * TODO(#156): nothing in this issue is behind a sign-in wall, so nothing
 * calls this. It is here because the first screen that IS — "my needs", in a
 * later issue — will reach for `status !== "signed-in"` and redirect, which
 * sends somebody with a valid session to /sign-in every time the API is cold.
 * A guard that has to be remembered is one that will not be. The rule:
 * redirect only on `signed-out`; wait on `checking` and `unknown`.
 */
export function isSettled(session: Session): boolean {
  return session.status === "signed-in" || session.status === "signed-out";
}

const SessionContext = createContext<SessionValue | null>(null);

/**
 * Asks the API who the caller is, once, and holds the answer.
 *
 * TODO(#156): call `GET /auth/me` on mount.
 *   - `200` → signed-in
 *   - `401` → signed-out. This is the ordinary answer for a visitor, NOT a
 *     failure, and must never reach a screen as an error. It is also the ONLY
 *     answer that produces "signed-out".
 *   - `UNREACHABLE` or any `5xx` → the API is probably asleep. Stay in
 *     "checking" and retry with a backoff — 2s, 4s, 8s, 16s, 32s — because a
 *     Render free instance takes most of a minute to wake and the right
 *     behaviour is to wait, not to decide. Give up after that into "unknown".
 *   - anything else → "unknown". The app cannot claim a session it could not
 *     confirm, and it must not deny one either.
 *
 * TODO(#156): "unknown" renders as the neutral placeholder, exactly like
 * "checking". The two are kept apart because they call for different words
 * once there is something to say — "still waiting" versus "Farhand is not
 * answering; try again" — not because they look different today.
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
