# 0027 — Counters that survive a second machine

## Context

`src/middleware/rate-limit.ts` has said since #14 that the counters live in
one process's memory, and `docs/14-deployment.md` gave that as one of the two
reasons `numInstances` is `1`. Two instances would mean two tallies: the
documented 20 login attempts per address becomes 40, somebody refused by one
machine tries again and is served by the other, and the `RateLimit` headers
disagree with each other request by request.

That is a correctness argument rather than a cost one, and it was the only
thing in the code standing between this project and a second machine. The
other reason — Render's free plan does not scale past one instance — is not
something code can fix.

Three questions: where the counters go, which limiters move, and what happens
when the store cannot be reached.

## Decision

**A `RateLimit` table of our own, not Redis.** Decision 0019 made this
argument about the job queue and it applies here unchanged: a second piece of
infrastructure is a second thing to run, pay for, watch and explain, and the
database is already shared by every instance. Upstash's free tier would have
worked and needs no card, but its 10,000 commands a day would have become the
real rate limit — the global ceiling alone spends one per request.

The npm package `rate-limit-postgresql` is rejected for 0019's *other* reason:
it creates and migrates its own tables, and `schema.prisma` is authoritative
here (rule 1). The store is about a hundred lines, and the half that matters
is one statement.

**All of them, not just the security ones.** The tempting shape was to share
the login and email limits and leave the two crude flood ceilings in memory,
keeping the database off the hot path. Rejected because of what it does to
the document: `06-api-contract.md` would have to say that 300 requests a
minute means 300 *per instance*, which is a number that changes meaning when
somebody changes a setting in `render.yaml`. One short statement per request
is a real cost and an honest one.

**One statement, and the database's clock.** A limiter is a
read-modify-write, and two requests arriving together must not both read 19
and both write 20. `INSERT … ON CONFLICT DO UPDATE … RETURNING` does the
reading, the deciding and the writing inside one statement, so PostgreSQL's
row lock settles the race rather than a transaction of ours. The same
statement restarts a window that has run out — a `CASE` on `expiresAt <=
now()` — and every instant in it is `now()` rather than a JavaScript `Date`,
because several instances means several clocks and the only one they can all
agree on is the database's (#85 learned this about job rows; the test here
moves the process's clock five minutes and watches the deadline stay right).

**Fail open, and loudly.** A counter that cannot be read or written allows the
request, and writes `logger.error`. The argument is that the store **is** the
application's database: when it is unreachable, every endpoint behind the
limiter is already answering 500, so refusing as well turns a blip into a
certain outage instead of a likely one. What keeps that from being careless is
the line — a limiter that has quietly stopped limiting is the worst of both
worlds, so the failure is at error level, where it is seen, rather than
swallowed.

**A daily sweep, in the workflow that already exists.** Live windows are
rewritten in place, so what accumulates is windows nobody came back for. The
sweep is a third step in the same run as the deal sweep and the export sweep
(#101, #89), with `if: always()`, for the reason #114 found: a second schedule
is a second thing that can silently stop firing.

## Alternatives

**Redis — Upstash's free tier.** What rate limiting is normally built on:
atomic `INCR`, expiry for free, no table to sweep. A free plan that needs no
card, capped at 10,000 commands a day — which the global ceiling would spend
on 10,000 requests, making the quota the real limit. And it is the second
infrastructure 0019 refused, for a problem the database can hold.

**Keep memory, divide the numbers by the instance count.** No dependency, no
table, no statement per request. It is also a lie that drifts: the division is
only right while the instance count is, and a client's budget would depend on
which machine answered. The headers would still disagree.

**Security limits shared, flood ceilings local.** The efficient middle, and it
costs the one thing this project will not spend: a documented number that
means something different depending on a deployment setting.

**Fail closed.** Nothing can brute-force its way through a database outage,
which sounds right until you notice what it buys. The endpoints being
protected cannot work without the database either, so the attack it prevents
is guessing at passwords that cannot be checked. The cost is turning a few
seconds of Neon trouble into a deliberate, total outage.

**A transaction instead of one statement.** `SELECT … FOR UPDATE`, then
`UPDATE`. Correct, and two round trips on the hot path instead of one, holding
a row lock across both.

## Consequences

- **`numInstances` is now a plan question, not a correctness one.** Nothing in
  the code has to change to run two. What would want thinking about: every
  instance runs #85's worker, which is built for it (`FOR UPDATE SKIP
  LOCKED`), and nothing is sticky, because a session is a hashed cookie
  checked against a table.
- **Every limited request now writes to the database**, on top of the session
  lookup it already does. One short upsert against a primary key, and the
  first thing to measure if this project ever has traffic worth measuring.
- **The counters survive a restart**, which they did not before. A deploy or
  Render's 15-minute sleep used to reset everybody's budget; now somebody who
  has spent their login attempts cannot clear them by waiting for a cold
  start. That is the rule working, and it is a behaviour change worth
  knowing.
- **The test for this is unusual, and the unusual part is the point.** Calling
  `createApp()` twice is not two processes — the limiters are module-level, so
  both apps share the same objects. The test resets Vitest's module registry
  and imports a second copy of the whole graph, which is as close to a second
  instance as one process can get. Two seams leaked while writing it: the
  fresh copy has its own `env` (so its limiters were disabled) and its own
  `HttpError` class (so `instanceof` in this file's error handler was false
  and a 429 came out as a 500). Both are written down in the test, because
  anybody simulating a second instance again will meet them.
- **One table holds every limiter's counters**, so the limiter's name is part
  of the key: `login-ip:1.2.3.4`. The library's `prefix` field is declared for
  its own double-counting check and is **not** prepended by it — the store
  has to, and until it did, spending the login budget spent the registration
  budget too. Two tests written in #14 caught that, which is the best argument
  for keeping old tests that there is.
