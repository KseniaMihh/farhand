/**
 * What the session IS, and how to read an answer about it — with no React in
 * it (#156).
 *
 * Split from session.tsx so that the decision "what does this failure mean?"
 * can be stated and tested on its own. It is the part worth pinning: the
 * provider around it is a `useState` and a `useEffect`, while this is the
 * rule that decides whether somebody is shown their own name or a sign-in
 * link, and getting it wrong is invisible until the API has a slow morning.
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

/**
 * What to do about a failed `GET /auth/me`.
 *
 * "retry" is not a state a screen ever sees — it is an instruction to the
 * provider to wait and ask again, during which the session stays "checking".
 */
export type MeOutcome = "signed-out" | "retry" | "unknown";

/**
 * How long to wait before each retry, in milliseconds.
 *
 * Five waits adding up to just over a minute, which is about how long a
 * sleeping Render free instance takes to answer its first request. Backing
 * off rather than hammering: a waking service does not answer faster for
 * being asked more often, and the retries are the only requests it will get
 * before somebody gives up and reloads.
 */
export const RETRY_DELAYS_MS: readonly number[] = [
  2000, 4000, 8000, 16000, 32000,
];

/**
 * Reads a failure from `GET /auth/me`.
 *
 * TODO(#156):
 *   - `401` → "signed-out". THE ONLY ANSWER THAT PRODUCES IT. Not a failure
 *     at all: it is what the API says to every visitor who has never signed
 *     in, and it must never reach a screen as an error.
 *   - status `0` (`UNREACHABLE`) or any `5xx` → "retry". The API is probably
 *     waking up, and the right response to that is to wait.
 *   - anything else, including a failure that is not an `ApiFailure` at all
 *     → "unknown". The app cannot claim a session it could not confirm, and
 *     it must not deny one either.
 */
export function outcomeFor(_error: unknown): MeOutcome {
  // TODO(#156): narrow with `instanceof ApiFailure` from ./api.
  return "unknown";
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
export function isSettled(_session: Session): boolean {
  // TODO(#156)
  return false;
}
