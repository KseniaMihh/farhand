# 0032 — The session is read in the browser

## Context

[0031](0031-the-frontend-proxies-the-api.md) settled *where* the API lives
from the browser's point of view: under this app's own address, so that
`sameSite: "lax"` keeps protecting the session cookie. It left a smaller
question open, and `farhand-web/app/page.tsx` said so in a comment: screens
that need a session will want a different shape, "and that is a question for
the issue that adds the first one."

#156 is that issue. Three screens and a header all need to know who is signed
in, and Next's App Router offers two honest ways to find out:

- **On the server**, in a React Server Component, reading the incoming
  request's cookie and calling the API before any HTML is sent.
- **In the browser**, calling `GET /auth/me` after the page loads.

The session cookie is `httpOnly`, so only one party can read it either way:
the browser has it and cannot see it, the server can see it but only if the
request happens to carry it.

## Decision

**The browser asks.** `farhand-web/lib/session.tsx` calls `GET /auth/me` on
mount and holds the answer in a context that the header, the banner and every
form share.

The reason is the one that decided the proxy. **A server component would not
go through the rewrite** — `next.config.ts` rewrites are a browser-path thing
— so it would need the absolute API URL, and it would have to lift the session
cookie out of the incoming request and re-attach it to its own outgoing call
by hand. That is a second way of talking to the API, with its own rules about
which cookie travels where, in an app whose one architectural decision is that
there is exactly one way. The failure mode of getting that second path subtly
wrong is the failure mode 0031 exists to prevent: it works in development and
signs people out in production.

**Rejected: reading it on the server.** It is the more idiomatic App Router
answer and it has a real advantage — the first paint knows who you are, so
there is no neutral moment in the header. The cost is the second path above,
plus every page that reads a session becoming dynamic. Worth revisiting if a
screen ever needs the session *before* paint for a reason beyond tidiness; a
signed-in page that renders its furniture a beat late is not that reason.

**Rejected: remembering the last answer in `localStorage`.** It removes the
neutral moment by drawing the previous visit's header immediately. It is also
a lie whenever the session has since expired or been signed out on another
device, and the lie lasts exactly as long as the request it was meant to hide.
A header that is briefly honest beats one that is confidently wrong.

## Consequences

- **The session has four states, not two.** `checking` while the first request
  is in flight, `signed-in`, `signed-out`, and `unknown` when the API did not
  answer. The header draws `checking` and `unknown` identically — a hidden
  copy of the signed-out controls, so the row keeps its width and announces
  nothing.
- **Only a `401` means signed out.** This is the whole of
  `farhand-web/lib/session-state.ts` and the part that is easy to get wrong.
  On the free plan the API sleeps after fifteen quiet minutes and takes most
  of a minute to wake; treating that silence as "signed out" would show a
  signed-in person "Sign in" on their first visit of the day and, once screens
  sit behind a sign-in wall, redirect them off the page they asked for while
  their session is perfectly good. `UNREACHABLE` and any `5xx` retry with a
  backoff — five waits summing to just over a minute — and fall to `unknown`
  only when the waiting runs out.
- **`isSettled()` exists before anything calls it.** The first screen behind a
  sign-in wall will reach for `status !== "signed-in"` and redirect, which is
  the same mistake wearing a different hat. The rule it encodes: redirect only
  on `signed-out`; wait on `checking` and `unknown`.
- **The decision is testable without a DOM.** What a session *is* lives in
  `session-state.ts` with no React in it, so the rule above is pinned by
  ordinary unit tests; `session.tsx` is a `useState`, a `useEffect` and a
  context.
- **The API is unchanged by this**, as it was by 0031. No endpoint, no header,
  no setting.
