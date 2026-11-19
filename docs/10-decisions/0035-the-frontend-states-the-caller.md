# 0035 — The frontend states the caller's address, and proves it is the frontend

## Context

[0029](0029-the-address-we-believe.md) settled how this API learns who is
calling: `trust proxy` believes a **count** of hops of `X-Forwarded-For`,
measured rather than assumed, counted from the socket backwards so that
anything a caller invents for itself falls to the left and the count steps
over it. Three, since #145.

[0034](0034-the-proxy-moves-into-middleware.md) put a fourth machine in front
of this API. `farhand-web/middleware.ts` proxies `/api/*` to Render so the
browser sees one site and the `sameSite: "lax"` session cookie survives
([0031](0031-the-frontend-proxies-the-api.md)). It also shipped with #152's
last acceptance criterion failing: a session created through the deployed site
recorded **Vercel's** address, not the visitor's, so every visitor in the
world shared one login rate-limit bucket.

Three deploys tried to fix that and all three failed. This record exists
because the reason they failed is not the reason 0034 gives.

## What was measured

Read out of Render's own logs — pino-http logs the whole `req.headers` object,
so the chain was printed there the entire time:

| | |
|---|---|
| Chain the API receives through the site | **4 entries** |
| Its leftmost entry | **the visitor's** |
| Entry `trust proxy: 3` resolves | the second, which is Vercel's |
| Chain arriving at the middleware | **1 entry**, the visitor's |
| `x-vercel-forwarded-for` at the middleware | **absent** (`vercel-ffor=n`) |

And the arithmetic, checked against the `proxy-addr` Express actually uses —
Express compiles `trust proxy: N` to "trust a hop whose index from the socket
is below N", which resolves `XFF[length − N]`:

| chain the API sees | `hops=3` | `hops=4` |
|---|---|---|
| direct: `[caller, cloudflare, render-lb]` | **caller** | caller |
| via the site: `[visitor, vercel-out, cloudflare, render-lb]` | **vercel-out** | **visitor** |

**So the value was right and the count was wrong.** Two of the three attempts
put the visitor's address exactly where it needed to be, at the left of a
four-entry chain, and a count of three read one step past it every time.

## 0034's explanation was wrong, not merely superseded

0034 says the rightmost entry of the chain at the middleware is Vercel's,
because "a proxy *appends*", and argues from that. The measurement says the
opposite: **one** entry arrives at the middleware and it is the visitor's.
There was never a Vercel address at either end of it to read.

That matters more than the usual superseding, because the wrong explanation is
load-bearing: anyone reading 0034 and reasoning from "the rightmost is
Vercel's" will reach for the wrong end of the header, or conclude the fix is
to raise the count. Both were tried. The sentence in 0034 is wrong and this
record is where that is written down; 0034 itself stays as it is, by rule 2.

Also wrong, in the commit before this one: reading `x-vercel-forwarded-for`.
It is reserved, a client cannot write it, and it would have been the best
source of the three — but the probe says it never reaches middleware at all,
so that version could not have worked at any hop count.

## Why no hop count can be the fix

A direct caller to `farhand-api.onrender.com` who sends one invented
`X-Forwarded-For` entry produces `[FAKE, caller, cloudflare, render-lb]`:
four entries, the same length and the same shape as the proxied chain. At
`hops=4` the API resolves `FAKE`.

This is not a close call, it is the arithmetic above. **The chain carries no
evidence of which path it came down**, so one number cannot be right for both,
and the number that fixes the website is the number that hands anyone with
`curl` an unlimited login budget — or somebody else's. 0029 names this exact
trap: a count that is too large lands on a real address and passes every check
we have.

The two paths can only be told apart by something a stranger cannot produce.

## Decision

**The frontend states the caller's address and proves it is the frontend,
with a secret the two of them share.**

- `farhand-web/lib/vouched-caller.ts` takes the **rightmost non-empty entry**
  of the inbound `X-Forwarded-For` and sends it as `x-farhand-caller`, beside
  `x-farhand-vouch: <secret>`.
- `farhand-api/src/middleware/caller-address.ts` honours `x-farhand-caller`
  only when `x-farhand-vouch` matches `PROXY_VOUCH_SECRET` under
  `timingSafeEqual` over SHA-256 digests, and only when the value is an
  address. It sets `req.vouchedCaller`; `callerAddress(req)` returns that or
  falls back to `req.ip`.
- **`TRUSTED_PROXY_HOPS` stays 3.** It is now the rule for the direct path
  only, which is the one path it can be right about.
- **`X-Forwarded-For` is no longer rewritten by the middleware at all.**

**Rightmost is safe whichever way Vercel behaves**, and that is the point of
choosing that end. A browser sends no `X-Forwarded-For`, yet exactly one entry
arrives at the middleware holding the visitor's address — so Vercel's edge
*writes* this header rather than passing one through. If it replaces, there is
one entry and it is the visitor's; if it appends, the visitor's is the entry
Vercel added, last, and anything a caller invented sits to its left. No
assumption either way is needed, which is why `x-real-ip` was not used: it
holds the right value today, but it is not a reserved name, so trusting it
would need a forgeability measurement of its own.

**Rejected: raising the count to four.** The section above is why.

**Rejected: trusting `x-real-ip`.** It would work and it would need a
measurement this does not.

**Rejected: `timingSafeEqual` on the raw strings.** It throws unless both
buffers are the same length, so a length check would come first — and
"throws or not, by length" is a side channel telling a caller how long the
secret is. Digests are always 32 bytes.

## What this also closed

`requestDataIntegration` is one of `@sentry/node`'s **default** integrations,
and in version 11 its defaults are `httpHeaders: { request: true }` and
`cookies: true`. Error reports were therefore carrying request headers — the
session cookie among them — from the moment a DSN was set, before this issue
added a secret to that list. `src/observability.ts` now collects no headers,
cookies, bodies, query parameters or auto-populated user IP, and strips
request headers by hand in `beforeSend` as well, because the option above is
somebody else's API and has already been renamed once.

`src/logger.ts` redacts `x-farhand-vouch` beside the session cookie, for the
same reason and because pino-http logs the whole header object.

## Consequences

- **Rotating the secret needs a redeploy of the web side**, not just a
  dashboard save: Next inlines `process.env` into the edge bundle at build
  time, and Vercel applies an environment change only to new deployments. The
  order is: set it on the Render service, set it on the Vercel project,
  redeploy the web side. In the window where the two disagree, requests fall
  back to `req.ip` — which is the old shared-bucket bug, not an outage, and
  the API writes one `error` line saying exactly that.
- **Production without `PROXY_VOUCH_SECRET` is a silent degradation**, so
  `server.ts` says so at startup. A warning and not a crash: the site works,
  only the counting is wrong, and an API that refused to boot over this would
  be the bigger outage.
- **The setting is not treated as "blank means absent"**, unlike the mail
  settings, because it is half of a pair: an empty value is a secret somebody
  meant to set and got wrong. `.env.example` keeps the line commented out for
  that exact reason — copying that file is how everybody starts, and an empty
  value in it would stop the API from booting.
- **A vouched address that is private is believed, deliberately.** That is a
  frontend reading its own chain wrongly, and believing it is what makes the
  #145 alarm fire and say so — with a different message, naming
  `middleware.ts` rather than `TRUSTED_PROXY_HOPS`, because sending that
  reader to the hop count would cost them an afternoon in the wrong file.
  Refusing would fall back to `req.ip`, look almost right, and hide it.
- **The measurement has to be repeated after every change to what sits in
  front of the API.** 0029's standing instruction, and this is its third time
  earning it. The new form of the check is step 12 of
  [16-pre-launch-smoke-test.md](../16-pre-launch-smoke-test.md), which now has
  two halves: the address through the site, and a forged header direct to the
  API.
- **Read the log before deploying a probe.** The probe that finally produced
  the measurement above counted entries in a header whose full value Render
  had been printing all along. One deploy of the three was spent learning
  something already on screen.
