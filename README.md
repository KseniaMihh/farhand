# Farhand

[![CI](https://github.com/KseniaMihh/farhand/actions/workflows/ci.yml/badge.svg)](https://github.com/KseniaMihh/farhand/actions/workflows/ci.yml)

A platform for people who can't order the thing they want, and people who live where they can.

> **Status: work in progress.** The version 1 API is feature-complete and deployed, and version 2 — files,
> reviews, notifications, trust, saved searches — is built on top of it. What is left is the frontend.
> See [Roadmap](#roadmap).

**Live:** [`https://farhand-api.onrender.com`](https://farhand-api.onrender.com/health) —
[`/health`](https://farhand-api.onrender.com/health) ·
[`/health/ready`](https://farhand-api.onrender.com/health/ready) ·
[`/needs`](https://farhand-api.onrender.com/needs)

Frankfurt, on Render's free tier, with a managed PostgreSQL in the same region.
The service sleeps when nothing is happening, so the first request after a
quiet spell can take up to a minute. Nothing about the hosting is paid.

Merging to `master` deploys, after the tests and the image build both pass.
How that is set up, and what to do when it breaks, is in
[docs/14-deployment.md](docs/14-deployment.md).

## The problem

You find the product you want. You reach the checkout. The shop doesn't deliver to your country. The usual
answers are unsatisfying: package forwarders like MyUS or Stackry charge for an address abroad and still ship
the parcel internationally, and traveller marketplaces like Grabr or Glocalzone depend on somebody happening to
fly your way with room in their luggage.

What people actually do instead is ask in an expat Facebook group: *"Is anyone in Germany who could order this
and post it to me? I'll cover everything."* That works, but it's unsearchable, unaccountable, and there's no
record of who kept their word.

Farhand is that informal arrangement given structure. The difference from the traveller marketplaces is
deliberate: helpers here are **people who live in the country**, who buy the item and post it — no flight
required, so the pool of possible helpers is everyone in that country rather than everyone flying to yours.

## How it works

```
  Requester posts a Need  ─┐
                           ├─►  Proposal  ──►  Conversation  ──►  Deal  ──►  Review
  Helper posts a Help     ─┘   (handshake)      (agree terms)   (lifecycle)   (trust)
```

1. A **Need** is a request: *"I want this from this shop in Germany, shipped to Estonia."*
2. A **Help** is a standing offer: *"I live in Germany, I can buy cosmetics and electronics, I ship to the EU."*
3. Either side can start the contact, and both routes produce a **Proposal** — the handshake between one Need
   and one helper.
4. Accepting a proposal opens a **Conversation** (size? colour? total cost?) and creates a **Deal**, which moves
   through a fixed lifecycle from matched to completed.
5. After a completed deal, both sides can leave a **Review**.

## Why this repo exists

Farhand is a real product idea, built as the vehicle for a deliberate move from frontend to full stack. That
means the parts that are easy to skip in a tutorial project are the parts being taken seriously here: a
normalised schema, hand-written SQL constraints, migrations that are reviewed before they run, tests and CI from
early on rather than bolted on at the end, and the reasoning behind each decision written down while it's still
fresh. Where a choice was a trade-off, this README says which way it went and why.

## Tech stack

| Layer | Choice |
| --- | --- |
| Runtime | Node.js 24 |
| Language | TypeScript 7 |
| Database | PostgreSQL 18 (Alpine), via Docker Compose |
| ORM / migrations | Prisma 7.10, configured through `prisma.config.ts` (the Prisma 7 style) |
| API | Express 5, Zod for request validation, pino for logging |
| Tests | Vitest + Supertest, against a real PostgreSQL database |
| CI | GitHub Actions: lint, formatting, typecheck, tests on every pull request; then migrate and deploy |
| Hosting | Render (the API, free plan) and Neon (PostgreSQL, free plan) — decision 0010 |
| Files | Backblaze B2 over the S3 protocol, `sharp` for re-encoding — decision 0011 |
| Email | Brevo's HTTP API, because the free plan blocks outbound SMTP — decision 0014 |
| Errors | Sentry, with a request id in every error body |
| Dev tooling | `tsx`, `dotenv`, ESLint 10 with type-aware `typescript-eslint` rules, Prettier |
| Planned | Playwright, Next.js frontend |

## Data model

Twenty-three models. Rather than list every field — `farhand-api/prisma/schema.prisma` is commented and is the
source of truth — here are the six decisions behind the shape.

**Private and public data are separate tables.** `User` holds email, password hash, role and account status, and
is never serialised to another user. `Profile` holds what everyone sees: display name, country, city, bio. The
split means leaking an email address through a careless API response takes real effort rather than one forgotten
`select`.

**Everything revolves around a Need.** A helper can answer a Need, or a requester can approach a Help offer.
Both routes end in the same `Proposal` row, with `initiatedBy` recording which side started it and an optional
`helpId` when the requester came from a Help listing. One table, one set of rules, instead of two near-identical
flows that drift apart.

**`Deal` repeats three foreign keys on purpose.** `needId`, `requesterId` and `helperId` are all reachable
through the proposal, but storing them directly on the deal turns "show me my deals" into a single indexed
query. This is intentional denormalisation, accepted because deals are read far more often than they're created.

**Status is a column; history is a table.** `Deal.status` answers *where is this deal now*. `DealEvent` is
append-only and answers *how did it get here, and who did it* — including system actions, where `actorId` is
null. Disputes and the admin panel both depend on that history existing.

**Nothing is hard-deleted.** A deleted account becomes `AccountStatus.DELETED` and is anonymised, but its deals
survive, because the other party's history shouldn't disappear when someone exercises their right to erasure.
A moderated message gets `removedAt` — hidden from the conversation, kept as evidence.

**Money is integer cents plus an ISO 4217 currency code.** No floats anywhere near a price.

The models, grouped as the schema groups them:

- **Accounts** — `User`, `Profile`, `Session`, `VerificationToken`
- **Listings** — `Category`, `Need`, `Help`
- **Matching & messaging** — `Proposal`, `Conversation`, `Message`
- **Deals** — `Deal`, `Quote`, `DealEvent`
- **Admin** — `AdminAction`
- **Trust & files (v2)** — `Review`, `Report`, `File`, `ProhibitedItem`
- **Work and word (v2)** — `Job`, `Notification`, `SavedSearch`, `DataExport`, `RateLimit`

Sessions store a **hash** of the cookie value, never the value itself — so a database leak doesn't hand an
attacker a set of working sessions. `VerificationToken` follows the same rule.

## Rules enforced by the database

Some invariants are too important to leave to application code, where one missed check or one concurrent
request breaks them. These live in `farhand-api/prisma/migrations/20260910123946_add_constraints/migration.sql`:

```sql
-- Only one non-cancelled deal per need
CREATE UNIQUE INDEX "one_active_deal_per_need"
    ON "Deal" ("needId") WHERE "status" <> 'CANCELLED';

-- Ratings must be 1-5
ALTER TABLE "Review" ADD CONSTRAINT "rating_range"
    CHECK ("rating" BETWEEN 1 AND 5);

-- Money can never be negative
ALTER TABLE "Need" ADD CONSTRAINT "need_amounts_non_negative"
    CHECK ("estimatedPrice" >= 0 AND "thankYouAmount" >= 0);

ALTER TABLE "Deal" ADD CONSTRAINT "deal_amounts_non_negative"
    CHECK (COALESCE("productAmount", 0) >= 0
        AND COALESCE("shippingEstimate", 0) >= 0
        AND COALESCE("shippingActual", 0) >= 0
        AND "thankYouAmount" >= 0);
```

Two working rules follow from this:

- Prisma doesn't know about the partial index, because a `WHERE` clause on an index can't be expressed in
  `schema.prisma`. So **read every generated migration before applying it**. If one contains
  `DROP INDEX "one_active_deal_per_need"`, delete that line.
- **An applied migration is never edited.** Prisma stores a checksum of each file in `_prisma_migrations` and
  refuses to continue if one changes. Fix mistakes with a new migration.

## Deal lifecycle

```
MATCHED → QUOTE_AGREED → PRODUCT_PAID → PURCHASED → SHIPPED → DELIVERED → COMPLETED
                                                         ↘ CANCELLED / DISPUTED
```

Which transitions are legal, and which side is allowed to make each one, is enforced in application code as a
state machine — a helper can mark a deal `SHIPPED`, only the requester can confirm `DELIVERED`. Every transition
writes a `DealEvent`.

## Getting started

**Prerequisites:** Node.js 22 or newer, Docker Desktop (on Windows: WSL2 enabled), Git.

```powershell
git clone <repo-url> farhand
cd farhand

# 1. Environment file
cp farhand-api/.env.example farhand-api/.env

# 2. Start PostgreSQL and the local file store - from the ROOT folder
docker compose up -d db storage
docker compose ps          # wait until the status shows (healthy)

# 3. Install and set up the database - from farhand-api
cd farhand-api
npm install
npx prisma migrate dev
npx prisma generate
npm run seed               # the category list and the prohibited list; safe to re-run

# 4. Check it works
npm test                   # creates farhand_test on first run

# 5. Browse the tables
npx prisma studio
```

> Two easy mistakes: **`docker compose` runs from the repo root**, where `docker-compose.yml` lives, while
> **npm and Prisma run from `farhand-api`**. IntelliJ's terminal opens at the repo root, so most sessions start
> with `cd farhand-api`.

The default credentials in `.env.example` match `docker-compose.yml`, so a fresh clone works without edits.
They are local-development-only and must never be reused anywhere real.

## Running the API

With the database up, from `farhand-api`:

```powershell
npm run dev        # tsx watch - restarts on every save
```

**The endpoint list is not repeated here.** [`docs/06-api-contract.md`](docs/06-api-contract.md)
is the specification — there is no OpenAPI file, that document is it — and
`tests/contract/endpoints.test.ts` fails if the API and that document disagree
about an endpoint or about who may call it (#69). A second list in this file
would be a third place to forget, which is the mistake this README has already
made once (#92).

Enough to see it working:

| Endpoint | Purpose |
| --- | --- |
| `GET /health` | Liveness. Is the process responding? Checks nothing else, because restarting the API won't fix a database that is down. Also reports the commit it runs, so a deploy can tell the new version from the old. |
| `GET /health/ready` | Readiness. Round-trips the database and returns 503 if it's unreachable, so a load balancer can route around a broken instance. |
| `POST /auth/register` | Creates an account and its profile. Answers `201` identically whether or not the email was already registered, so it cannot be used to discover who has an account. Queues a verification email — printed to the terminal in development, sent through Brevo in production. |
| `POST /auth/verify-email` | Confirms the address with the emailed token. Tokens are single use, expire after 24 hours, and are stored only as a hash. |
| `POST /auth/login` | Checks the password and sets an httpOnly session cookie. An unknown email and a wrong password get the same answer, in the same time. |
| `GET /auth/me` | Who is logged in: the user and their profile, never the password hash. |
| `GET /needs` | The public list: open needs, newest first, filtered by country, category or text, paged by cursor. |
| `POST /needs` | Posts a need. Five open per account; drafts do not count; a public one must tick the prohibited list. |
| `GET /files/:id` | A redirect to a signed link that works for five minutes. Avatars follow their owner's profile, need photos their need, receipts only the two people in the deal and moderators — anyone else gets the same `404` as for a file that does not exist. |

> **Writing to the API by hand?** Every `POST`, `PATCH` and `DELETE` must arrive
> with an `Origin` (or `Referer`) matching `APP_ORIGIN`, or it is refused with
> `403` — that is what stops another website posting with your session cookie.
> A browser always sends one; `curl` and Postman do not:
>
> ```powershell
> curl -X POST http://localhost:3000/needs -H "Origin: http://localhost:5173" ...
> ```
>
> Setting `CSRF_ENABLED=false` in `.env` turns it off for an afternoon of
> poking about. Never anywhere real.

Every error response uses the same shape, so the frontend can write one handler
rather than guessing per endpoint:

```json
{ "error": { "code": "NOT_FOUND", "message": "Need not found" } }
```

Every response also carries an `X-Request-Id` header, and every error body
repeats it as `requestId`: the same string appears in the log line and on the
error report, so "it failed, here is the id" leads straight to the one request
out of the nine hundred that minute.

`code` is for code to branch on; `message` is for a human. Validation failures
return `422` with a `details` array naming the fields that failed; `400` is kept
for a body that could not be parsed at all. Unexpected errors return `INTERNAL`
and the real message is logged, never sent — internal errors have a habit of
containing table names and connection strings. In development the message is
attached under `details`, because there it reaches the person who can fix it;
in production the body is `{ code, message }` and nothing else, which
`tests/security/hardening.test.ts` checks by running the handler with
`NODE_ENV=production` and looking for the host, the port and the user in what
comes back.

## Tests

Vitest as the runner, Supertest for HTTP. From `farhand-api`, with Docker running:

```powershell
npm test           # once
npm run test:watch # re-runs on save
```

**They run against a real PostgreSQL database, not a mock.** `farhand_test` is a
second database inside the same container as the development one — created by
`scripts/init-test-db.sql` on a fresh volume, and by the test bootstrap on a
machine where the stack has already run. Mocking Prisma would test our idea of
what Postgres does; the interesting rules in this project are transactions,
unique constraints and cascades, which only the database can answer for.

Before each test, every table is emptied with `TRUNCATE ... RESTART IDENTITY
CASCADE`. Truncation rather than wrapping each test in a transaction and rolling
it back: a rollback never lets you observe what a `COMMIT` inside the code under
test actually did, and accepting a proposal — the rule this project most needs
to get right — is a transaction. Slower, and honest.

Truncation also clears the seeded categories, deliberately. A test that needs a
category creates the one it needs, rather than depending on seed data that may
change.

**The prohibited list is the one exception**, and it is written down here so
nobody wonders why. Since #87 a public listing cannot be posted without ticking
the current list, and the version it ticks is a fingerprint of the rows in the
database — so an empty table makes every posting in the suite impossible.
`tests/setup/truncate.ts` re-seeds three lines after each truncation. The rule
is still "a test creates what it needs"; this is the one thing no test can
create for itself without re-stating the rule it is testing.

`tests/setup/truncate.ts` refuses to run unless `NODE_ENV=test` **and** the
database name ends in `_test`, so a mistyped connection string stops the suite
instead of emptying your development data. `tests/isolation.test.ts` tests the
harness itself: one test writes a row, the next asserts it is gone.

**A test that uses a fixed instant must pin everything to it.** Rows written
by the database carry *its* `now()`, not the constant at the top of your file,
and the two agree only by luck. #85's queue tests drained at a literal
`2026-10-16T12:00:00Z` while `Job.runAfter` defaulted to the real clock: they
passed all morning, failed eleven tests in CI at 12:01 UTC, and would have
failed every run after that. Three more were passing for the wrong reason —
"nothing was sent" is also true of a job nobody looked at. The fix is a helper
that sets every row's timestamp to the test's own clock (`due()` in
`tests/jobs/queue.test.ts`), so the file never reads the time of day. Use a
real `new Date()` only where the thing under test is "now", as
`tests/helpers/jobs.ts` does when it stands in for a worker.

Every test file has a row here, and `tests/contract/readme.test.ts` fails if
one arrives without it (#92).

| File | What it does |
| --- | --- |
| `vitest.config.ts` | Loads `.env.test` over the shell environment; pins the suite to one worker |
| `tests/setup/global-setup.ts` | Creates the test database if missing, then `prisma migrate deploy`, then the test bucket in the local file store |
| `tests/setup/truncate.ts` | The safety check, and the truncation before each test |
| `tests/health.test.ts` | `/health` and the commit it reports, `/health/ready`, and the 404 error shape |
| `tests/isolation.test.ts` | The harness itself: one test writes a row, the next asserts it is gone |
| `tests/env.test.ts` | Settings that only mean anything complete — a half-configured file store or mail key refuses to start |
| `tests/contract/endpoints.test.ts` | Every documented endpoint exists, every live one is documented, and each one's guards match its marker (#69) |
| `tests/contract/readme.test.ts` | This README's source tree and test table against the files that are really there (#92) |
| `tests/auth/register.test.ts` | Registration: validation, hashing, the one-transaction rule, and the identical duplicate response |
| `tests/auth/verify-email.test.ts` | Verification: single use including a staged double-click, expiry, wrong token type, identical rejections |
| `tests/auth/login.test.ts` | Login: the cookie settings, hashed session storage, identical and equally slow failures, banned vs suspended |
| `tests/auth/me-logout.test.ts` | `/auth/me`, logout, and requireAuth: expired sessions, bans landing on the next request, one device at a time |
| `tests/auth/guards.test.ts` | requireVerified, requireActive and requireRole, each on a one-route test app |
| `tests/auth/password-reset.test.ts` | Forgot and reset: identical answers, only the newest link working, expiry, reuse, and every device logged out |
| `tests/auth/resend-verification.test.ts` | Resend: a working new link, older links retired, and the same answer for unknown, verified and banned accounts |
| `tests/auth/rate-limit.test.ts` | Rate limiting: counting by address and by account, the 429 shape, windows resetting, and the real endpoints being wired up |
| `tests/auth/mailer.test.ts` | Sending for real: the provider call, what is never logged, and what a refusal does to the queued job |
| `tests/profiles/public-profile.test.ts` | `GET /users/:id`: the five fields a stranger sees, and who answers 404 |
| `tests/profiles/my-profile.test.ts` | `PATCH /me/profile`: only your own, only the fields you send, and what a blank one means |
| `tests/profiles/avatar.test.ts` | Avatars: what is stored (square, small, WebP, no metadata, upright), every refusal changing nothing, replacing leaving one file, and the rate limit |
| `tests/profiles/delete-account.test.ts` | `DELETE /me`: the password, the deals that refuse it, and exactly what anonymisation leaves behind |
| `tests/needs/needs.test.ts` | Needs: every permission rule — ownership, editable statuses, the open-needs limit, and what blocks a delete |
| `tests/needs/browse.test.ts` | Browsing: filters, what each visitor may see, and paging that stays correct while needs are posted |
| `tests/needs/photos.test.ts` | Photos on a need: six at most, who may add and remove one, and the cover photo a list carries |
| `tests/helps/helps.test.ts` | Helps: ownership, categories replaced rather than added, empty shipsTo meaning anywhere, and a delete that keeps proposals |
| `tests/helps/browse.test.ts` | Browsing offers: filters, ships-anywhere matching every search, paging, and what EXPLAIN says about the GIN index |
| `tests/proposals/proposals.test.ts` | Proposals: who may send one, one per helper per need whatever became of it, declining and withdrawing |
| `tests/proposals/accept.test.ts` | Accepting: the one transaction that makes a deal, the need it matches, and the other proposals it does not touch |
| `tests/conversations/conversations.test.ts` | Threads and messages: who may read one, what unread means, and the moderator rule |
| `tests/conversations/rate-limit.test.ts` | The limit on sending messages, counted per signed-in sender rather than per address |
| `tests/deals/transitions.test.ts` | The deal state machine: all 81 moves, who may make each one, and what each leaves in the event log |
| `tests/deals/quotes.test.ts` | Quotes: who may send and agree one, and why agreeing is not a status change |
| `tests/deals/events.test.ts` | `GET /deals/:id/events`: the history both sides see, oldest first, with the actor named |
| `tests/deals/receipts.test.ts` | Receipts: who may attach one and when, six per kind, nothing deleting one, and the line a moderator's read writes |
| `tests/deals/cancellation.test.ts` | Cancellation, disputes, and the sweep that completes a deal fourteen days after delivery |
| `tests/reviews/reviews.test.ts` | Reviews: one per side, the fourteen-day window, and blind until both are in or the window closes |
| `tests/reviews/summary.test.ts` | The rating summary on a profile: what counts, what does not, and the single query it costs |
| `tests/reviews/moderation.test.ts` | Reporting and removing a review: the tombstone it leaves, and the words only a moderator can still read |
| `tests/reports/reports.test.ts` | Reports: who may file one about what, one open report per person per target, and the queue's order |
| `tests/admin/moderation.test.ts` | Moderation: warn, suspend, ban, reactivate, takedowns, the audit row each writes, and what a report shows |
| `tests/admin/user-search.test.ts` | Finding a person: exact email, partial name, opening one account by its id, the only two endpoints that return an address, and the line every lookup writes |
| `tests/admin/erasure.test.ts` | A moderator erasing a banned account: banned only, idempotent, and the same erasure `DELETE /me` performs |
| `tests/prohibited/acknowledgement.test.ts` | The tick: required at the moment a listing becomes public, refused when the wording has changed, and recorded with its version |
| `tests/notifications/notifications.test.ts` | The mechanism: one event one email, the preference re-read at sending time, and who gets nothing |
| `tests/notifications/events.test.ts` | Which events send an email and which deliberately do not — the silences tested as carefully as the sends |
| `tests/notifications/preference.test.ts` | `PATCH /me/notifications`: the one switch, and the kinds it cannot stop |
| `tests/searches/saved-searches.test.ts` | Saved searches: what may be saved, the limit, what a new listing matches, and the single email it sends |
| `tests/exports/export.test.ts` | Asking for a copy and downloading it: whose data is in it, what is left out, and the seven-day sweep |
| `tests/jobs/queue.test.ts` | The queue: claiming with a lease, backoff, giving up after five attempts, and work that outlives a crash |
| `tests/files/store.test.ts` | Storing a file: the size and type limits, refusals that store nothing, and a failure halfway leaving no orphan |
| `tests/files/read.test.ts` | `GET /files/:id`: the expiring redirect, bytes never public, who may see each purpose, and vanished bytes not being a crash |
| `tests/files/account-deletion.test.ts` | Deleting an account: photos go, receipts stay, and bytes are deleted only after the transaction commits |
| `tests/files/cost.test.ts` | What a page of images costs in queries, measured rather than assumed |
| `tests/files/store-cleanup.test.ts` | The test bucket is emptied between runs, so a suite cannot slow down for ever |
| `tests/security/hardening.test.ts` | The headers, the body size limit, what a 500 does not say, and the routes that must stay closed |
| `tests/security/csrf.test.ts` | The origin check on every write, and the three ways a request can fail it |
| `tests/security/observability.test.ts` | A request id on every error, the same id in the log, and what is reported to Sentry |
| `tests/security/reporting-outage.test.ts` | What happens when the thing that records failures fails |
| `tests/security/shared-rate-limits.test.ts` | One budget across two independent copies of the app, the window dated by the database, and failing open when it cannot be reached |
| `tests/security/caller-address.test.ts` | Whose address a request arrives with, three proxies away, and the complaint when that resolves to one no caller could have |

`.env.test` is committed, unlike `.env` — it holds the same throwaway credentials
as `docker-compose.yml`, and committing it means a fresh clone can run the tests
without a setup step.

## Continuous integration

`.github/workflows/ci.yml` runs on every pull request, and on every push to
`master`. It fails the build on a lint error, a formatting difference, a type
error or a failing test:

```
npm ci  →  npx prisma generate  →  lint  →  format:check  →  typecheck  →  test
```

The tests need a database, so the job starts a `postgres:18-alpine` service
container — the same image as `docker-compose.yml`, so a failure in CI is a real
failure and not a version difference. Its `POSTGRES_DB` is `farhand_test`
rather than `farhand`: CI has no development data to keep separate, so the only
database it needs is the test one, and that name is what the guard in
`tests/setup/truncate.ts` insists on.

Migrations are applied by `tests/setup/global-setup.ts`, the same way as on your
machine, rather than by a separate CI step. One place decides how a test
database is prepared, and CI runs the commands you run locally.

Feature branches are verified through their pull request rather than by a second
`push` trigger, which would start two identical runs for every push to a branch
with a PR open. Since [the workflow](docs/13-workflow.md) opens a PR for every
change, nothing reaches `master` unverified.

## Everyday commands

| What | Command | Where |
| --- | --- | --- |
| Start the database only (for `npm run dev`) | `docker compose up -d db` | root |
| Run the whole stack as it will be deployed | `docker compose up --build --wait` | root |
| Stop the stack | `docker compose down` | root |
| Start the database | `docker compose start` | root |
| Stop the database (data kept) | `docker compose stop` | root |
| Recreate the container (data kept) | `docker compose down` then `up -d` | root |
| **Delete the database and all data** | `docker compose down -v` | root |
| Create and apply a migration | `npx prisma migrate dev --name <name>` | `farhand-api` |
| Create a migration without applying it | `npx prisma migrate dev --create-only --name <name>` | `farhand-api` |
| Regenerate the Prisma client | `npx prisma generate` | `farhand-api` |
| Browse data | `npx prisma studio` | `farhand-api` |
| Seed the category list (adds new ones, renames changed ones, never deletes) and the prohibited list (adds what is missing, **never rewords** what is there) | `npm run seed` | `farhand-api` |
| Complete deals delivered 14 days ago | `npm run job:auto-complete` | `farhand-api` |
| Destroy data exports older than 7 days | `npm run job:sweep-exports` | `farhand-api` |
| Delete rate-limit windows that have ended | `npm run job:sweep-rate-limits` | `farhand-api` |
| Run whatever is waiting on the job queue, once | `npm run job:drain` | `farhand-api` |
| Typecheck | `npm run typecheck` | `farhand-api` |
| Lint (and auto-fix what's safe) | `npm run lint` / `npm run lint:fix` | `farhand-api` |
| Format (or only check) | `npm run format` / `npm run format:check` | `farhand-api` |
| Run the tests | `npm test` / `npm run test:watch` | `farhand-api` |
| Check the suite left the file store empty | `npm run test:store-empty` | `farhand-api` |
| Fill the file store, to investigate #110 | `npm run store:fill -- 6000` | `farhand-api` |

After `docker compose down -v` the database is empty, and `npx prisma migrate dev` and `npm run seed` have to
run again.

**Why `package.json` lists TypeScript twice.** typescript-eslint needs TypeScript's JavaScript API, which
TypeScript 7 no longer ships. So `typescript` is aliased to TypeScript 6 (used only by the linter), and
`@typescript/native` is TypeScript 7, which provides the `tsc` that builds and typechecks. Once typescript-eslint
supports TypeScript 7, remove the alias.

## Project structure

Every source file has a line here, and `tests/contract/readme.test.ts` fails
if one arrives without it (#92, decision 0028). The tests are listed by folder:
the table under [Tests](#tests) is where they are enumerated, and twice is once
too many.

```
farhand/
├── .github/
│   └── workflows/
│       ├── ci.yml              lint, format, typecheck, test; build the image, run the stack; migrate Neon and deploy
│       ├── auto-complete.yml   the daily sweeps: deals delivered 14 days ago, expired exports, expired rate-limit windows
│       └── drain-queue.yml     the six-hourly backstop that drains the job queue if the web service is asleep
├── docker-compose.yml          the stack: PostgreSQL, the local file store, a one-shot migrate step, the API
├── render.yaml                 how Render runs the API: region, health check, one instance
├── .gitignore
├── .gitattributes              forces LF line endings, so Prettier agrees on Windows
├── README.md
├── CLAUDE.md                   working notes for Claude: pointers to the documents, not a second copy of them
├── docs/                       the long-form documents — the contract, the data model, the deal lifecycle, the decision records
├── scripts/                    repo chores: GitHub issue and label seeding, test database creation
├── farhand-api/                the backend (npm and Prisma run here)
│   ├── Dockerfile              four stages; only the last one ships
│   ├── .dockerignore
│   ├── .env                    local only, gitignored
│   ├── .env.example
│   ├── .env.test               test database; committed, holds no secrets
│   ├── package.json
│   ├── tsconfig.json
│   ├── vitest.config.ts        test runner; loads .env.test
│   ├── eslint.config.js        lint rules; Prettier owns formatting
│   ├── .prettierrc.json        Prettier defaults, no overrides
│   ├── prisma.config.ts        Prisma 7 config; holds the datasource URL
│   ├── prisma/
│   │   ├── schema.prisma       the data model, commented
│   │   └── migrations/         applied migrations - never edited
│   ├── src/
│   │   ├── server.ts           entry point: starts the HTTP server and the worker, and stops both
│   │   ├── app.ts              builds the Express app (binds no port)
│   │   ├── worker.ts           the job-queue worker that runs inside the web service
│   │   ├── env.ts              environment variables, validated with Zod
│   │   ├── db.ts               the shared Prisma client
│   │   ├── logger.ts           pino
│   │   ├── errors.ts           HttpError and the error response shape
│   │   ├── observability.ts    Sentry, and what happens when reporting itself fails
│   │   ├── password.ts         argon2id hashing; the only file that imports argon2
│   │   ├── tokens.ts           single-use tokens: generated, hashed, stored
│   │   ├── mailer.ts           outgoing email: Brevo's HTTP API, and the development fallback
│   │   ├── sessions.ts         login sessions and the cookie settings
│   │   ├── storage.ts          the file store (S3 protocol); the only file that knows it
│   │   ├── images.ts           avatars, need photos and receipts re-encoded with sharp; the only file that knows it
│   │   ├── seed.ts             categories and the prohibited-items list
│   │   ├── jobs/
│   │   │   ├── drain.ts        runs the queue once, for the scheduled backstop
│   │   │   ├── auto-complete.ts  completes deals delivered 14 days ago
│   │   │   ├── sweep-exports.ts  destroys export payloads past their seven days
│   │   │   └── sweep-rate-limits.ts  deletes rate-limit windows that have ended
│   │   ├── middleware/
│   │   │   ├── error-handler.ts  every error becomes the same JSON shape
│   │   │   ├── caller-address.ts  how many proxies to believe about who is calling
│   │   │   ├── request-id.ts   one id per request, echoed in the error body
│   │   │   ├── security.ts     headers, CORS, and the origin check on writes
│   │   │   ├── rate-limit.ts   the limits themselves, and what each one counts by
│   │   │   ├── rate-limit-store.ts  the counters, in the database every instance shares
│   │   │   └── auth.ts         requireAuth, requireVerified, requireActive, requireRole
│   │   ├── schemas/
│   │   │   └── common.ts       field rules more than one router needs
│   │   ├── services/
│   │   │   ├── shared.ts       paging, cursors, and the pieces several services use
│   │   │   ├── needs.ts        who may create, edit and close a need
│   │   │   ├── helps.ts        the same, for offers to carry something
│   │   │   ├── need-photos.ts  a need's photos, and the one query a page of them costs
│   │   │   ├── proposals.ts    offering to help, and accepting: the one place a deal is born
│   │   │   ├── conversations.ts  threads, messages, and when a moderator may read one
│   │   │   ├── deals.ts        a deal as each side sees it, its events and its receipts
│   │   │   ├── transitions.ts  the deal state machine: who may move it, and where to
│   │   │   ├── receipts.ts     attaching proof of purchase and postage
│   │   │   ├── reviews.ts      reviews, blind until both are in, and what removal leaves
│   │   │   ├── profiles.ts     public profiles, own profile, and leaving
│   │   │   ├── avatars.ts      set, replace and remove your own avatar
│   │   │   ├── files.ts        file rules: size, type, who may see one, what deletion removes
│   │   │   ├── reports.ts      reporting a person, a listing, a message or a review
│   │   │   ├── moderation.ts   the few things a moderator may do, and the record of them
│   │   │   ├── erasure.ts      the anonymisation both DELETE /me and a moderator use
│   │   │   ├── exports.ts      a copy of everything held about one person
│   │   │   ├── notifications.ts  what is worth an email, and one event sending one
│   │   │   ├── jobs.ts         the queue: claiming, retrying, giving up
│   │   │   ├── prohibited.ts   the list, its fingerprint, and the tick against it
│   │   │   └── saved-searches.ts  standing queries, and matching a listing against them
│   │   └── routes/
│   │       ├── health.ts       liveness, readiness, and the commit it reports
│   │       ├── auth.ts         register, verify email, log in and out, me, reset password
│   │       ├── profiles.ts     public profile, own profile, avatar, delete account
│   │       ├── needs.ts        create, edit, delete and browse needs; photos
│   │       ├── helps.ts        create, edit, delete and browse offers
│   │       ├── proposals.ts    send, accept, decline, withdraw; messages on a proposal
│   │       ├── conversations.ts  reading a thread and marking it read
│   │       ├── deals.ts        one deal, its events, its transitions, its quotes and receipts
│   │       ├── reports.ts      POST /reports
│   │       ├── admin.ts        the whole /admin surface: the queue, actions, takedowns, erasure
│   │       ├── notifications.ts  the one switch
│   │       ├── prohibited.ts   the public list
│   │       ├── exports.ts      ask for a copy, download it once it is built
│   │       ├── searches.ts     saved searches
│   │       └── files.ts        GET /files/:id, a redirect to a signed link
│   └── tests/
│       ├── tsconfig.json       tests are their own TS project, not part of the build
│       ├── setup/
│       │   ├── global-setup.ts  creates the test database, applies migrations, makes the test bucket
│       │   └── truncate.ts     the safety check, and TRUNCATE before each test
│       ├── helpers/
│       │   ├── auth.ts         signUpAndLogIn() and friends, for tests that need a user
│       │   ├── needs.ts        a category, a valid need body, a deal on a need
│       │   ├── files.ts        file rows and sample images without going through an endpoint
│       │   ├── images.ts       reading back what sharp produced
│       │   ├── http.ts         comparing two answers, and pinning the keys of one
│       │   ├── jobs.ts         running whatever the last request queued
│       │   ├── queries.ts      what the database was actually asked, while something happened
│       │   ├── prohibited.ts   the current list fingerprint, which a public posting needs
│       │   ├── transactions.ts  breaking a transaction halfway, on purpose
│       │   ├── contract.ts     reading the API contract, and the app's own routing table
│       │   └── readme.ts       reading this file: the tree above and the table below
│       ├── admin/              moderation, the audit log, user search, erasure
│       ├── auth/               registration through to password reset, the guards, the limits, the mailer
│       ├── contract/           the two documents that are checked against the code
│       ├── conversations/      threads, messages, and the limit on sending them
│       ├── deals/              the state machine, quotes, receipts, events, cancellation
│       ├── exports/            asking for a copy and downloading it
│       ├── files/              storing, reading, cost, cleanup, and what deletion removes
│       ├── helps/              offers and browsing them
│       ├── jobs/               the queue: claiming, backoff, giving up
│       ├── needs/              needs, browsing them, photos
│       ├── notifications/      the mechanism, which events send, and the switch
│       ├── profiles/           public and own profiles, avatars, leaving
│       ├── prohibited/         the tick at the moment it matters
│       ├── proposals/          sending and accepting
│       ├── reports/            submitting and queueing
│       ├── reviews/            writing, reading, the blind window, removal, summaries
│       ├── searches/           saved searches end to end
│       ├── security/           headers, CORS, origin checks, request ids, limits, the caller's address
│       ├── env.test.ts         settings that only mean anything complete
│       ├── health.test.ts      the first API-level tests
│       ├── isolation.test.ts   proves the harness isolates tests
│       ├── assert-store-empty.ts  a standalone check that the test bucket is empty
│       └── fill-store.ts       fills it on purpose, to prove the check works
└── farhand-web/                planned: Next.js frontend
```

## Roadmap

**v1 — the core product**

- [x] Data model: 16 models to start with, relations, indexes
- [x] PostgreSQL 18 in Docker Compose
- [x] Initial migration
- [x] Hand-written constraints: one active deal per need, rating range, non-negative money
- [x] API skeleton: Express 5, validated env, structured logging, error contract, health checks
- [x] Seed script for categories
- [x] Auth: registration, password hashing, session cookies, logout, `GET /me`, route protection
- [x] Tests (Vitest + Supertest against a test database) and CI on every push
- [x] Needs and helps: CRUD, filtering by country and category, cursor pagination
- [x] Proposals: send, accept, decline — with the accept running as one transaction
- [x] Conversations, messages, unread counts
- [x] Deal lifecycle as an enforced state machine, with events
- [x] Quotes, cancellation, disputes, and completion after 14 days of silence
- [x] Reports and the moderator queue
- [x] Admin: role checks, suspend and ban, audit log
- [x] Security pass: helmet, CORS, origin checks on writes, a global rate limit
- [x] Request ids through the logs, and error reporting
- [x] API in Docker, deployed to a cloud host with monitoring

**v2 — trust and polish**

- [x] File uploads to object storage: avatars, need photos, receipts on a deal
- [x] Reviews after completed deals, blind until both sides have written
- [x] Prohibited items ticked at the moment a listing becomes public, not only reported afterwards
- [x] Email notifications through a background job queue, and the switch that stops them
- [x] A moderator's view of a person, and the erasure for an account that cannot ask for one
- [x] A data export: everything held about one person, built in the background
- [x] Saved searches, and being told when something matches
- [x] Rate limits that survive a second machine
- [ ] The README describing the project again — this issue (#92)
- [ ] Frontend (`farhand-web`, Next.js) as a separate project (#93)

Before the frontend: one walk through the whole product on production, by hand
(#131). The suite cannot prove that an email really arrives.

## Scope & safety

**v1 handles no money.** Farhand introduces two people and keeps a record of what was agreed; the payment
happens between them, outside the platform. The requester covers the product and the shipping. Any thank-you
amount for the helper's effort is optional and separate — `thankYouAmount` defaults to 0 — because the intent is
neighbourly help, not gig work.

That's a deliberate limit, not an oversight. A platform of this kind runs into problems that are legal before
they are technical:

- **Fraud and non-delivery.** The reason the deal event log, reviews and reports exist at all. Structure and
  reputation are the tools available when escrow isn't.
- **Customs, VAT and import duty.** A parcel crossing a border is the recipient's liability, and the platform
  shouldn't imply otherwise.
- **Prohibited and restricted items.** Medicines, alcohol, anything that can't simply be posted.
- **Sanctions.** In this region especially, a service that moves goods across borders can be misused to route
  restricted items into sanctioned countries. Designing around that beats discovering it later.

If escrow is ever added — holding the product payment until delivery is confirmed, the way Grabr does — it would
be Stripe Connect in **test mode only**, unless Farhand ever became a real company with proper legal advice.
Handling other people's money is a licensing question, not a coding one.

---

Built in public as a learning project.
