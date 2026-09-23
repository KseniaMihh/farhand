# The development environment, and why each part exists

This is the file to re-read when a command stops making sense. It explains the
tools rather than the project.

## The shape of the whole thing

```
Your browser or an API client
        │  HTTP
        ▼
Node.js  ── runs your TypeScript code (the API)
        │  SQL, through Prisma
        ▼
PostgreSQL ── stores the data
        │  runs inside
        ▼
Docker container
        │  runs on
        ▼
WSL2 (a small Linux system inside Windows)
```

Nothing here is optional bureaucracy: each layer solves a problem the layer
above cannot.

## Node.js

JavaScript's runtime outside the browser. The browser can run JavaScript because
it has a JavaScript engine built in; Node is that same engine packaged so it can
run on a server, read files and listen for network requests. Without it, your
backend code has nowhere to run.

## npm, `package.json` and `package-lock.json`

`npm` installs libraries. `package.json` lists what the project needs and roughly
which versions. `package-lock.json` records the exact versions that were actually
installed. Both belong in Git, so that anyone who clones the repository gets an
identical setup. `node_modules` is the downloaded code itself, is large, and is
rebuilt by `npm install`, so it is never committed.

The `-D` flag marks a development dependency: something needed while building,
such as the Prisma CLI or the test runner, but not needed by the running server.

## TypeScript

JavaScript with types checked before the code runs. It catches a large class of
mistakes at compile time. `strict: true` is where most of that value comes from.

## PostgreSQL

The database: a separate program that stores data on disk and answers SQL
queries. It is chosen over alternatives because it enforces rules itself. A
CHECK constraint or a unique index holds even when the application code has a
bug, which no amount of careful TypeScript can guarantee.

## Docker and containers

An **image** is a recipe: "Linux, plus PostgreSQL 18, configured this way." A
**container** is a running copy of that recipe. Docker matters here for three
reasons: the database does not have to be installed into Windows and can be
deleted cleanly; the version is pinned, so it matches production; and the same
`docker-compose.yml` gives an identical database on any machine.

`docker-compose.yml` describes which containers the project needs and how they
are configured, so `docker compose up -d` replaces a page of setup instructions.

A **volume** is storage that outlives the container. Without one, stopping the
container would erase the database. This is why `docker compose down -v` is
dangerous: `-v` deletes the volume, and with it the data.

A **healthcheck** lets Docker report not just "started" but "ready to accept
connections".

## WSL2

Windows Subsystem for Linux. Containers are a Linux technology, so Docker
Desktop runs a small Linux system inside Windows and starts containers there.
`.wslconfig` caps how much memory and CPU that Linux system may take, which is
why Docker's limits are set in that file rather than in Docker Desktop.

## Prisma

Three things sharing one name.

**The schema** (`schema.prisma`) is a single description of every table and
relation, in a readable format.

**Migrations** are the versioned SQL that takes the database from one shape to
the next. `prisma migrate dev` compares the schema to the database, writes the
SQL into a timestamped folder, and applies it. Those folders belong in Git,
because they are how any other machine reaches the same database shape. Once a
migration has been applied it is never edited; a new one is added instead.
`_prisma_migrations` inside the database is Prisma's record of which have run.

**The client** is generated TypeScript, produced by `prisma generate`, that knows
your tables. `prisma.need.findMany()` is typed, so a misspelled column is a
compile error rather than a runtime one.

In Prisma 7 the connection URL lives in `prisma.config.ts` rather than in the
schema, which is why the `url` line had to be removed.

## `.env`

Values that differ between machines and must not be shared: the database URL
today, API keys later. Ignored by Git. Its role is to keep secrets out of source
control, the same rule as keeping Stripe keys out of a committed config file.

`.env.test` is the exception, and it **is** committed. It points the test suite
at `farhand_test`, a second database in the same container, and holds only the
throwaway credentials already in `docker-compose.yml` — so there is nothing
secret in it, and committing it lets a fresh clone and CI run the tests without
a setup step. `vitest.config.ts` loads it *over* the shell environment, so a
`DATABASE_URL` left exported in your terminal cannot point the tests at
development data.

It also sets `RATE_LIMIT_ENABLED=false`. A test file makes dozens of requests
from one address on purpose, which is exactly what rate limiting exists to stop;
`tests/auth/rate-limit.test.ts` turns it back on for its own requests.

## Git and GitHub

Git records the project's history locally. GitHub stores a copy remotely and
makes it visible. `.gitignore` lists what must never be recorded, such as
`node_modules` and `.env`. A file already tracked keeps being tracked even after
being added to `.gitignore`, which is what `git rm --cached` fixes.

## Everyday commands

| Command | What it does | Needs Docker running |
|---|---|---|
| `docker compose up -d` | Create and start the database | yes |
| `docker compose start` / `stop` | Resume or pause it | yes |
| `docker compose ps` | Show status and health | yes |
| `npx prisma validate` | Check the schema is well formed | no |
| `npx prisma migrate dev` | Create and apply a migration | yes |
| `npx prisma generate` | Regenerate the typed client | no |
| `npx prisma studio` | Browse the data in a browser | yes |
| `npm install` | Install dependencies from `package.json` | no |
| `npm test` | Run the test suite against `farhand_test` | yes |

## Why not simpler

Installing PostgreSQL directly into Windows would work, and skipping Prisma in
favour of hand-written SQL would also work. Both are used in real projects. The
chosen combination is what the job market asks for most often, and each choice is
recorded in `10-decisions/` so it can be revisited rather than assumed.
