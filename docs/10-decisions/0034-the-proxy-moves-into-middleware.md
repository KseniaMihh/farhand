# 0034 — Vercel in Frankfurt, and the proxy moves into middleware

## Context

[0031](0031-the-frontend-proxies-the-api.md) settled that the frontend serves
the API under its own address, so the browser sees one site and the
`sameSite: "lax"` session cookie survives. It left where to host it open, and
#152 is where that was decided and then where the decision met production.

Two candidates, both free and neither needing a card:

| | Vercel (Hobby) | Render (free) |
|---|---|---|
| Cold start | None for the page | **Chained**: the web app wakes, then the API |
| Region | Frankfurt selectable, **United States by default** | Frankfurt, beside the API |
| Accounts | A second provider | The one we have |

## Decision

**Vercel, with the function region pinned to `fra1`.**

The region is pinned in `vercel.json` even though the `/api` rewrite is
handled by Vercel's routing layer rather than by a function, so in principle
the setting does not apply to it. *In principle* is not a thing to deploy on:
anything that does invoke a function — a server component, a route handler
added later — would otherwise default to Washington, and a function in the
United States forwarding to an API in Frankfurt puts the Atlantic in every
request on the page. One line removes the default.

**And the proxy moved from `next.config.ts` into `middleware.ts`**, which was
not part of the plan. It is here rather than in a new decision of its own
because it is the same decision meeting a fact.

## What the first deploy measured

Signing in worked, and a reload kept the session — 0031 proved in production
rather than argued, which was the point of the issue.

The address did not. The API saw **Vercel's** address, not the visitor's:
three entries in `X-Forwarded-For`, Vercel's leftmost, the visitor's nowhere
in the chain and not under any other header name either. A rewrite declared
in `next.config.ts` is performed by Vercel's routing layer, and that layer
makes the outbound request *as though it were the client*.

The consequence is specific. Every by-address rate limit would have counted
every visitor into one bucket: ten people signing in from ten countries
exhausting a limit meant for one, with a symptom — "signing in sometimes says
too many attempts" — that looks nothing like its cause.

**The obvious fix was wrong, and that is the part worth keeping.** The chain
looked one hop short, so raising `TRUSTED_PROXY_HOPS` from 3 to 4 was the
plausible answer. It would have resolved one step *further left*, into the
part of the header a caller writes for themselves —
[0029](0029-the-address-we-believe.md) says exactly this: a count is a fact
about somebody else's infrastructure, a count that is too large lands on a
real address and passes every check we have, so it is measured rather than
inferred. It was measured, and it said something different from the story.
`TRUSTED_PROXY_HOPS` stays at **3**.

## The shape of the fix

`farhand-web/middleware.ts` matches `/api/:path*`, sets `x-forwarded-for`
from the address Vercel saw, and rewrites to the API.

**It forwards the rightmost entry, not the header.** A proxy *appends* the
address it saw, so the last entry is the one the nearest proxy vouches for
and everything left of it is whatever the caller chose to write. The first
version copied the header wholesale — and a local test, with a made-up
address, watched the forgery sail through to the API untouched. Reading from
the right is the same rule the API's own count follows, for the same reason.
It also holds whichever way Vercel behaves: replace the header and there is
one entry which is the right one; append to it and the appended one is last.

**Rejected: a catch-all route handler** at `app/api/[...path]/route.ts`,
which is what #152 wrote down as the fallback before any of this was
measured. Middleware is smaller and keeps more of the platform's behaviour:
the body still streams, a `302` from `GET /files/:id` still passes through
untouched, and `Set-Cookie` is not something this app copies by hand — which
matters more here than usual, since that cookie is what 0031 exists to
protect. The handler stays written down as the escalation.

**Rejected: leaving the `next.config.ts` rewrite as a fallback.** Two
mechanisms for one job means the quiet one wins when the other breaks, and
the quiet one here is the one that drops the address. A `404` is a louder
failure than a rate limit everybody shares.

## Consequences

- **Every proxied call now costs a middleware invocation**, which is what the
  pinned region is for. Pages, fonts and Next's own assets are excluded by
  the matcher and pay nothing.
- **`next.config.ts` has no rewrite**, and says so, because that is the first
  place anybody will look for one.
- **The measurement has to be repeated after every change to what sits in
  front of the API.** That is 0029's standing instruction and this is its
  second time proving itself — the chain has now behaved differently from the
  obvious story twice, once in #145 and once here.
- **Local development exercises the same path**, because the middleware runs
  in `next dev` too. That is how the forged-header bug was found before it
  reached production rather than after.
