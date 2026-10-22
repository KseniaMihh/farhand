# 0031 — The frontend proxies the API

## Context

The session cookie is `sameSite: "lax"`, which means a browser will not attach
it to a request aimed at a **different site**. That is the browser's own
decision, made before CORS is consulted, so no amount of configuring the API
changes it.

`onrender.com` and `vercel.app` are public suffixes, so every subdomain counts
as its own site. A frontend at `farhand-web.vercel.app` calling
`farhand-api.onrender.com` would log in to a `200` and appear signed out on
the very next request, with nothing in either log to explain it. The exact
mechanism varies with the browser and its third-party-cookie settings — the
cookie may be refused on the way in or on the way out — and the outcome is the
same either way.

This was found while drawing `docs/15-architecture.md`, which listed three
ways out and said #93 should pick one before building anything. This is #93
picking one.

## Decision

**The frontend serves the API under its own address.** `next.config.ts`
rewrites `/api/:path*` to the deployed API, so the browser only ever talks to
one origin and `sameSite: "lax"` keeps doing its job. Every request in
`farhand-web/lib/api.ts` is therefore relative, and that is load-bearing
rather than tidy: an absolute API URL would compile, work against a local API
in development, and quietly fail to stay signed in once deployed.

**Rejected: a registrable domain of our own**, `app.example.ee` beside
`api.example.ee`. Technically the best answer — no proxy hop, no extra
machine in front of the API — and it is also half the fix for #121, where an
unsubscribe click on a verification email locks somebody out for good, and it
fixes the rewritten mail sender from #119. It costs money, perhaps ten euros a
year, and this project runs on free tiers with no card on file by a standing
rule. **Worth revisiting the day that rule changes**: the proxy is reversible
in one file, which is part of why it is a safe first answer.

**Rejected: `sameSite: "none"`.** It is one attribute, it keeps the two
origins separate, and it would work today for some people. Safari blocks
third-party cookies by default and Firefox partitions them, so signing in
would silently stop working for a large share of real visitors — not only the
privacy-minded ones — and Chrome has been narrowing the same ground for years.
It also gives up exactly what Lax was doing: a browser-level defence against
another site making a request as you, leaving the `Origin` check from #28
carrying that alone. A trade of a real defence for something that does not
reliably work is not a trade.

## Consequences

- **Every browser request costs a hop.** Browser → this app → the API, instead
  of browser → API. At this size that is latency rather than cost, and the
  deploy issue has to care about *where* the hop happens: a serverless
  function in the United States proxying to an API in Frankfurt would add a
  transatlantic round trip to every request on the page.
- **The API's `trust proxy` hop count has to be re-measured when the frontend
  is deployed.** #145 measured three hops — caller, Cloudflare, Render's
  balancer — and hard-coded it. This app becomes another machine in front of
  the API, so the count may change, and getting it wrong means every visitor
  shares one rate-limit bucket again. Two things will say so: the
  private-address check from #145 logs once per process if the resolved
  address is internal, and the bucket key in the `ratelimit` response headers
  shows from outside whether callers are being counted separately.
- **Local development against production is read-only, and that is correct.**
  A write from `http://localhost:3100` reaches production carrying that
  `Origin`, and the site-wide origin guard (#28) refuses it with `403`.
  Production's `APP_ORIGIN` is **not** to be changed to make a local page
  work; screens that sign in or write are built against a local API.
- **`APP_ORIGIN` on Render becomes the frontend's address**, once the frontend
  has one. Until then it is still the API's own URL, which is the placeholder
  `docs/15-architecture.md` has described since #96.
- **The API is unchanged by this.** No CORS entry, no cookie attribute, no new
  setting: the whole decision lives in one file in the frontend. That is the
  property that makes it reversible if a domain arrives later.
