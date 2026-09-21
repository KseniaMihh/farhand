# Farhand

A platform for people who can't order the thing they want, and people who live where they can.

> **Status: work in progress.** The data model and local infrastructure are done; the API is being built now.
> Nothing is deployed yet. See [Roadmap](#roadmap).

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
| Dev tooling | `tsx`, `dotenv`, ESLint 10 with type-aware `typescript-eslint` rules, Prettier |
| Planned | Express 5, Zod, Vitest + Supertest, Playwright, GitHub Actions, Next.js frontend |

## Data model

Sixteen models. Rather than list every field — `farhand-api/prisma/schema.prisma` is commented and is the
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
- **Deals** — `Deal`, `DealEvent`
- **Admin** — `AdminAction`
- **v2 (trust & files)** — `Review`, `Report`, `File`

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

# 2. Start PostgreSQL - from the ROOT folder
docker compose up -d
docker compose ps          # wait until the status shows (healthy)

# 3. Install and set up the database - from farhand-api
cd farhand-api
npm install
npx prisma migrate dev
npx prisma generate
npm run seed               # the fixed category list; safe to re-run

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

| Endpoint | Purpose |
| --- | --- |
| `GET /health` | Liveness. Is the process responding? Checks nothing else, because restarting the API won't fix a database that is down. |
| `GET /health/ready` | Readiness. Round-trips the database and returns 503 if it's unreachable, so a load balancer can route around a broken instance. |

Every error response uses the same shape, so the frontend can write one handler
rather than guessing per endpoint:

```json
{ "error": { "code": "NOT_FOUND", "message": "Need not found" } }
```

`code` is for code to branch on; `message` is for a human. Validation failures
add a `details` array naming the fields that failed. Unexpected errors return
`INTERNAL` and the real message is logged, never sent — internal errors have a
habit of containing table names and connection strings.

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

`tests/setup/truncate.ts` refuses to run unless `NODE_ENV=test` **and** the
database name ends in `_test`, so a mistyped connection string stops the suite
instead of emptying your development data. `tests/isolation.test.ts` tests the
harness itself: one test writes a row, the next asserts it is gone.

| File | What it does |
| --- | --- |
| `vitest.config.ts` | Loads `.env.test` over the shell environment; pins the suite to one worker |
| `tests/setup/global-setup.ts` | Creates the test database if missing, then `prisma migrate deploy` |
| `tests/setup/truncate.ts` | The safety check, and the truncation before each test |
| `tests/health.test.ts` | `/health`, `/health/ready`, and the 404 error shape |

`.env.test` is committed, unlike `.env` — it holds the same throwaway credentials
as `docker-compose.yml`, and committing it means a fresh clone can run the tests
without a setup step.

## Everyday commands

| What | Command | Where |
| --- | --- | --- |
| Start the database | `docker compose start` | root |
| Stop the database (data kept) | `docker compose stop` | root |
| Recreate the container (data kept) | `docker compose down` then `up -d` | root |
| **Delete the database and all data** | `docker compose down -v` | root |
| Create and apply a migration | `npx prisma migrate dev --name <name>` | `farhand-api` |
| Create a migration without applying it | `npx prisma migrate dev --create-only --name <name>` | `farhand-api` |
| Regenerate the Prisma client | `npx prisma generate` | `farhand-api` |
| Browse data | `npx prisma studio` | `farhand-api` |
| Seed categories (adds new ones, renames changed ones, never deletes) | `npm run seed` | `farhand-api` |
| Typecheck | `npm run typecheck` | `farhand-api` |
| Lint (and auto-fix what's safe) | `npm run lint` / `npm run lint:fix` | `farhand-api` |
| Format (or only check) | `npm run format` / `npm run format:check` | `farhand-api` |
| Run the tests | `npm test` / `npm run test:watch` | `farhand-api` |

After `docker compose down -v` the database is empty, and `npx prisma migrate dev` and `npm run seed` have to
run again.

**Why `package.json` lists TypeScript twice.** typescript-eslint needs TypeScript's JavaScript API, which
TypeScript 7 no longer ships. So `typescript` is aliased to TypeScript 6 (used only by the linter), and
`@typescript/native` is TypeScript 7, which provides the `tsc` that builds and typechecks. Once typescript-eslint
supports TypeScript 7, remove the alias.

## Project structure

```
farhand/
├── docker-compose.yml          PostgreSQL 18 for local development
├── .gitignore
├── .gitattributes              forces LF line endings, so Prettier agrees on Windows
├── README.md
├── scripts/                    repo chores: GitHub issue seeding, test database creation
├── farhand-api/                the backend (npm and Prisma run here)
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
│   │   ├── server.ts           entry point: starts and stops the process
│   │   ├── app.ts              builds the Express app (binds no port)
│   │   ├── env.ts              environment variables, validated with Zod
│   │   ├── db.ts               the shared Prisma client
│   │   ├── logger.ts           pino
│   │   ├── errors.ts           HttpError and the error response shape
│   │   ├── middleware/
│   │   └── routes/
│   └── tests/
│       ├── tsconfig.json       tests are their own TS project, not part of the build
│       ├── setup/
│       │   ├── global-setup.ts creates the test database, applies migrations
│       │   └── truncate.ts     safety check, and TRUNCATE before each test
│       ├── health.test.ts
│       └── isolation.test.ts   proves the harness isolates tests
└── farhand-web/                planned: Next.js frontend
```

## Roadmap

**v1 — the core product**

- [x] Data model: 16 models, relations, indexes
- [x] PostgreSQL 18 in Docker Compose
- [x] Initial migration
- [x] Hand-written constraints: one active deal per need, rating range, non-negative money
- [x] API skeleton: Express 5, validated env, structured logging, error contract, health checks
- [x] Seed script for categories
- [ ] Auth: registration, password hashing, session cookies, logout, `GET /me`, route protection
- [ ] Tests (Vitest + Supertest against a test database) and CI on every push
- [ ] Needs and helps: CRUD, filtering by country and category, cursor pagination
- [ ] Proposals: send, accept, decline — with the accept running as one transaction
- [ ] Conversations, messages, unread counts
- [ ] Deal lifecycle as an enforced state machine, with events
- [ ] Admin: role checks, suspend and ban, audit log
- [ ] API in Docker, deployed to a cloud host with monitoring

**v2 — trust and safety**

- [ ] File uploads (need photos, receipts) to object storage
- [ ] Reviews after completed deals
- [ ] Reports, moderation queue, prohibited-items list
- [ ] Email notifications through a background job queue
- [ ] Frontend (`farhand-web`, Next.js) as a separate project

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
