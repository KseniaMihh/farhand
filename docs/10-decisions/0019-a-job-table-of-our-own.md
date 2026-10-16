# 0019 — A job table of our own

## Context

Three separate things had been waiting on a background queue, and they wanted
different amounts of it.

`docs/08-scope.md` has said since the beginning that email goes out "through a
background job queue". #86's notifications need the same machinery and need it
to be ordinary. And `docs/06-api-contract.md` carried an admission that was
getting harder to read every time somebody looked at it: `POST
/auth/forgot-password` answers the same sentence to every address, so that
nobody can use it to discover who has an account — and then does one more
database write when the address is real, and so answers a few milliseconds
slower. The sentence lied by being slow. That is a timing oracle, and the fix
is not a faster query: it is for the request to do the same work in both cases
and leave the deciding to something nobody is holding a stopwatch against.

Underneath all three was something plainer. Until #85, an email was sent
**inside the request that caused it**, and if the provider was having a bad
minute the email was simply gone. #119 made that failure survivable by
swallowing it — a registration must not become a 500 because somebody else's
server was unwell — which is the right answer when a route is waiting and the
wrong answer in general. Nothing retried. Nobody was owed anything.

Two questions had to be settled before any code: what the queue **is**, and
where it **runs**.

## Decision

**A table of our own, about 150 lines, rather than a library.** `Job` is in
`schema.prisma` beside everything else: `kind`, a JSON `payload`, `runAfter`,
`attempts`, `lastError`, and the two timestamps that say how it ended.

The deciding argument is this repository's first rule — `schema.prisma` is
authoritative for the data model. pg-boss, the obvious choice, creates its own
schema and runs its own migrations on first use; the data model would then be
"what `schema.prisma` says, plus whatever a dependency installed", and the
first rule would be false rather than merely inconvenient. A queue is a table,
an index, and `FOR UPDATE SKIP LOCKED`, and this project already uses
`FOR UPDATE` for the photo and receipt limits (#81, #82).

**A job's state is told by timestamps, not by a status column.** `doneAt` and
`failedAt` both null means waiting; one of them set says which way it ended.
The same shape as `Message.removedAt` and `Review.removedAt` (#125): the row
records when something happened rather than naming the state it left behind,
and "when did this stop working" is a question a timestamp can answer and an
enum cannot.

**The claim pushes `runAfter` forward.** Claiming is a short transaction that
locks one due row, increments `attempts` and sets `runAfter` to the end of the
lease, and then releases the lock before the handler talks to anybody. So a
worker that dies mid-job holds nothing: the row is not due again for a while,
and then it is. Nothing is lost, only late. It is also why the handler can
take seconds on somebody else's server without holding a database connection —
the limit #82 ran into.

**Five attempts, waiting a minute, then five, then twenty-five.** The usual
reason a job fails is that a provider is having a bad minute, and immediate
retries are how a bad minute becomes a bad hour. After the fifth, the row is
left alone with `failedAt` set and **reported once** through #29's Sentry — not
once per attempt, or a blip becomes five issues.

**The handler decides, the request does not.** `enqueue` writes one row and
looks nothing up: it does not know whether the address has an account, and
that is precisely the point. The handler asks — and an address with nobody
behind it is not a failure, it is the answer, so the job is **done**. Otherwise
every stranger's typo becomes an incident report.

**The worker runs inside the web service, with a GitHub Actions cron as a
backstop.** Render's free plan has no background workers; one costs $7 a month
and nothing here is paid (#96, 0010). So `server.ts` starts the loop after it
opens the port — `app.ts` only builds, so no test ever starts a worker — and
the service is awake because the uptime monitor pings it every five minutes.
`.github/workflows/drain-queue.yml` runs the same `drain()` every six hours for
the case where it is not: asleep, crash-looping, mid-deploy. Not for latency,
which the in-process worker gives in about two seconds, but so that a queue
cannot silently stop draining.

**And `mailer.deliver` now throws, reversing #119.** With the queue as its only
caller, swallowing a failure would mark the job done, lose the email, and leave
every retry above as unreachable code that only looks tested. The guarantee
#119 wanted is still there and comes from somewhere better: a request that
sends nothing cannot be spoiled by a provider. What did not change is the
redaction — a provider that quotes the message back at us must not get a token
into a log, into Sentry, or into `Job.lastError`.

## Alternatives

**pg-boss.** Mature, correct, in PostgreSQL, and roughly the design above
written by people who have run it. Rejected over its migrations, as above. It
is the right answer for a project whose first rule is different, and if
`Job` ever grows scheduling, priorities and cron expressions, that is the sign
to look at it again rather than keep going.

**Redis and BullMQ.** The default answer in the Node world, and it needs
Redis: Upstash's free tier would do it, and it would make the queue a second
piece of infrastructure to hold state that PostgreSQL is already holding
transactionally — including the part that matters most, enqueueing a job in the
same transaction as the row it is about.

**A Render background worker.** The clean separation: the web service answers,
the worker works, neither can starve the other. $7 a month, so not now. The
code is ready for it — `npm run job:drain` is the whole worker — and this is
the first thing to buy when anything here is paid.

**Actions cron only, no in-process worker.** Tempting for its simplicity, and
it makes "a verification email" mean "within six hours". Email that arrives
after somebody has given up is worse than no feature. Running the cron every
five minutes instead would cost about four times the 2,000 free minutes a
private repository gets, which CI on pull requests is already spending.

**`void somePromise()` after the response.** The zero-infrastructure version:
answer, then send without awaiting. It fixes the timing oracle and nothing
else — no retry, no record, and work that vanishes when the process restarts.
It is what the code effectively did before #85, minus the honesty.

## Consequences

- **`POST /auth/forgot-password` now does the same work for every address**:
  one insert, the same sentence. The paragraph in `docs/06-api-contract.md`
  admitting otherwise is gone, because it is no longer true.
- **Email is late by about two seconds** and in exchange it is owed rather
  than hoped for. A provider outage delays verification codes instead of
  destroying them.
- **A token is created by the job, not by the request**, and issuing one
  retires the previous one (`tokens.ts`). So if an attempt fails *after* the
  provider actually accepted the message — a timeout on a delivered email —
  the person can receive a code that a later retry has already invalidated,
  and the newest email is the one that works. Rare, self-correcting, and worth
  knowing before somebody reports it as a bug.
- **Two drainers can run at once** — the in-process worker and the Actions
  backstop — and that is harmless by construction: `SKIP LOCKED` means they
  take different rows rather than the same one twice.
- **The backstop cannot send email**, deliberately: `MAIL_API_KEY` lives in
  Render, not in Actions secrets (0014, 0015). A drain there fails the mail
  jobs rather than consuming them, which is why "no provider configured" had
  to become a failure instead of a quiet success. It proves the queue is
  moving; it is not a second worker.
- **Nothing sweeps the table yet.** Done rows accumulate. At this volume that
  is arithmetic nobody needs to worry about, and #114's scheduled sweep is the
  place to add it when somebody does.
- **Every test that reads a token out of the mailer now calls
  `runQueuedJobs()`** first (`tests/helpers/jobs.ts`), because the request no
  longer sends anything. Six auth test files changed, and that is the honest
  cost of moving work out of the request: the tests have to stand in for two
  seconds passing.
