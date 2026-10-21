# 0029 — The address we believe

## Context

`req.ip` is not something this API observes. Render terminates TLS at its edge
and the request reaches this process over loopback, so the caller's address
arrives as a claim in `X-Forwarded-For` — a header, written by whoever sent the
request. What `app.set("trust proxy", …)` decides is how much of that claim to
believe.

It said `1` from the first deploy, inherited from a Fly setup with one proxy
and never checked. `docs/15-architecture.md` carried a row admitting exactly
that: *"`trust proxy 1` assumes exactly one proxy … a CDN in front would make
it two."* Step 12 of `docs/16-pre-launch-smoke-test.md` existed to ask the
question once, before launch.

It was asked on 21 October 2026, and the answer was `10.195.187.131` — one of
Render's internal balancers. The chain is **three** hops: a caller, Cloudflare
in front of every `onrender.com` host, and Render's balancer. Express counts
hops from the socket backwards, so a count of `1` resolved to the rightmost
entry, which is the machine nearest us.

What that cost, for a year, in both directions at once:

- **Too strict.** Everyone behind a given balancer shared one budget. The
  global ceiling is 300 requests a minute *per address* — which was 300 a
  minute for the whole of Farhand, and a frontend spends several per page view
  (#93).
- **Too lax.** There are several balancer addresses, so one caller's attempts
  scattered between buckets by chance instead of accumulating. A per-address
  limit that cannot name an address limits nobody in particular.
- **And a record that was never true.** `Session.ipAddress` is the "logged in
  from…" line, and #89 puts it in the data export. We handed people an address
  that was never theirs.

Three questions, then: what to believe, what to do when the answer is wrong
again, and why no test noticed in a year.

## Decision

**A measured hop count, in code: three.** Not configuration. The number is a
fact about a deployment that changes when somebody changes the deployment, and
a variable would put it somewhere a reader of `app.ts` cannot see while
sounding like something an operator is meant to tune. `TRUSTED_PROXY_HOPS` in
`src/middleware/caller-address.ts` carries the measurement, the date and the
two intermediaries beside it, so the next person to read the number finds the
argument attached — which is precisely what `1` never had.

**Not `true`, and the direction of counting is why.** Cloudflare *appends* the
address it sees to whatever `X-Forwarded-For` already said, so anything a
caller invents for itself ends up to the **left** of its real address. A count
from the right steps over it. `true` believes the leftmost entry, which is an
unlimited budget for anybody who can write a header — or somebody else's
address and a lockout for them.

**Not `CF-Connecting-IP`, which was the real alternative.** Cloudflare
overwrites that header rather than appending to it, so it survives a change in
the chain, and it is what Cloudflare's own documentation recommends. Rejected
because trusting it requires first knowing that the request came through
Cloudflare, and we cannot: the origin is addressed as
`farhand-api.onrender.com` and `remoteAddress` is loopback, so there is nothing
to check a sender against. Making it safe would mean carrying Cloudflare's IP
ranges and keeping them current — a list to maintain, in exchange for being
robust against a hop we would notice anyway.

The honest limit of a count, written down because it is the cost of this
choice: **a caller that can reach the origin directly can still name itself**,
since Express clamps the count to the chain it is given and a one-entry chain
resolves to that entry. On Render the origin is only reachable through the
chain. If that ever stops being true, this decision is wrong rather than
imprecise.

**Something notices when it is wrong again: a private address cannot be a
caller.** `createCallerAddressCheck` logs at error level — once per process,
not once per request — when the resolved address is loopback, RFC 1918 or
link-local, with the whole chain in the line. It needs no knowledge of the
right count, which is what makes it useful: it is true of *every* count that
is too small, including the one we had. It reports to Sentry as well when
there is a DSN, because this is a fault that is silent in every way a user
could notice.

It does **not** catch a count that is too large — a fourth hop added in front
would resolve to Cloudflare's address, which is a real one. Nothing cheap
catches that, and saying so here is better than implying the check is
complete. Step 12 of the walk is what asks.

**Tests that build chains as long as production's.** This is the part worth
keeping. Every request in the suite arrives from the same machine, so a test
that sends one `X-Forwarded-For` entry and reads the same address back passes
under *any* hop count — Express clamps a count to the chain it is given. That
is why 1181 tests were green while production had been wrong since the first
deploy. `tests/security/caller-address.test.ts` sends three entries, and every
test app that stands in for the real one now sets the same
`TRUSTED_PROXY_HOPS` rather than a literal `1`.

## Consequences

- **Rate limits now count callers.** On production this is the first time
  `RATE_LIMITS` has meant what `docs/06-api-contract.md` says it means. One
  consequence is worth expecting: a limit that was shared is now per caller,
  so the global ceiling stops being something a single busy afternoon could
  trip for everybody.
- **`Session.ipAddress` is a real address from now on**, and the rows written
  before this are not. Nothing migrates them: they say `10.x`, and that is
  the truth about what we knew at the time. The data export (#89) hands people
  what is stored, including the old ones.
- **A number in the code is a maintenance promise.** If Render changes its
  edge, `req.ip` becomes Cloudflare's address and the check above stays quiet.
  The things that would say so are step 12 of the walk and a run of
  `caller-address.test.ts` against a chain of the new length.
- **One more middleware on every request**, which is a string comparison and a
  boolean that is false after the first time. Mounted before the limiters,
  because what it checks is what they are about to count.
- **The check is production-only.** Development resolves `127.0.0.1` every
  time, and a check that complained about `npm run dev` would be switched off
  within the week — so the test suite sets `NODE_ENV` itself to exercise it.
- **The "proof the hop count is right" row in `docs/15-architecture.md` is
  retired.** It asked for one measurement for a year; the measurement took two
  minutes once somebody ran the walk, and it was wrong. The lesson is not about
  proxies: a deployment fact that no test can see needs something that asks on
  a schedule, and for this project that something is a document somebody walks
  through by hand before launch.
