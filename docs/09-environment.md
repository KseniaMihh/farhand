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

### The file store

Since #79 the compose file has a second service the tests need: `storage`, an
S3Proxy container standing in for Backblaze B2 the way `db` stands in for Neon.
It answers on `http://localhost:9000` with throwaway credentials that
`.env.example` and `.env.test` already name. Its files live inside the
container and are gone when it is removed, which suits development.

It replaced nothing — MinIO is the usual choice and stopped publishing images
in 2025. S3Proxy was picked because it checks signatures: an unsigned read, an
expired link and a tampered one are all refused, so the tests that say "bytes
are never public" run against a store that can refuse.

If `npm test` stops at setup with "the local file store is not answering", the
container is not running: `docker compose up -d storage` from the root.

### The API has an image too

`farhand-api/Dockerfile` builds the API itself, in four stages. Only the last
one ships:

| Stage | What it is for |
|---|---|
| `deps` | every dependency, to build with |
| `build` | TypeScript compiled, Prisma client generated |
| `proddeps` | production dependencies only, from the same lockfile |
| `runtime` | node, `dist/`, `proddeps` — and nothing else |

The compiler, the type definitions and the test runner are needed to *build*
the API and never to *run* it, and anything left in the final image has to be
patched, scanned and shipped for the life of the project. Measured when this
was written: **839 MB** multi-stage against **1.39 GB** for the same thing in
one stage. CI asserts the image stays under 1.1 GB, as a guard against the
development dependencies quietly coming back.

It runs as the **`node` user**, not root: a container running as root is one
where a remote-code bug becomes a root shell. And the command is
`node dist/server.js` rather than `npm start`, because npm adds a process that
forwards signals badly, and a container that ignores `SIGTERM` gets killed
mid-request on every deploy.

Two things about building it are easy to trip over, and both are commented in
the file. `prisma generate` must run in the build stage, because the client is
generated code that no `node_modules` copy contains — and it needs a
`DATABASE_URL` set merely to load `prisma.config.ts`, even though it connects
to nothing, so the build sets a throwaway one. Production dependencies get
their own stage because pruning after generating throws the client away and
installing after pruning brings the compiler back.

### Migrations are a step, not a startup task

`docker compose up` runs three services in order: the database, then a
**one-shot `migrate` service** that applies `prisma migrate deploy` and exits,
then the API — which only starts if the migration succeeded.

This is the decision the issue asked to be documented, and it is the same shape
deployment will have (#31): migrate first, then roll out. The alternative —
each container migrating as it boots — means every instance racing to change
the same schema, a failed migration becoming a crash loop rather than a
deployment that stopped, and an API container holding more power over the
database than serving requests requires.

Locally that means `docker compose up --build` gives a production-like stack in
one command. Day-to-day development is still `npm run dev` against the database
container alone: it is faster, and it reloads on save.

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

`CSRF_ENABLED=false` is there for the same reason and with the same escape
hatch: four hundred tests write to the API without a browser to set an `Origin`
header, and `tests/security/csrf.test.ts` turns the check on for itself.

### `SENTRY_DSN`

Where unexpected errors are reported. **Optional, and absent everywhere but
production** — no DSN means nothing is initialised and nothing leaves the
machine, which is what keeps development and the test suite entirely offline.

One file knows the name Sentry: `src/observability.ts`. Everything else calls
`reportError(error, context)`. That seam exists so the error handler can be
tested without mocking a vendor's SDK, and so changing provider is one file
rather than fifteen.

`Sentry.init` is given `environment: NODE_ENV`, which is the separation the
issue asked for: without it, an error from a staging box and one from
production land in the same pile and somebody chases a ghost.

**Only 5xx is reported.** A 404, a failed validation or a 409 is the client
being wrong, not an incident — and a monitor that pages somebody for a typo in
a URL is muted within a week, after which it is not a monitor.

### `STORAGE_*`

Five settings for the file store: endpoint, region, bucket, and a key pair.
**All five or none.** None means the API runs with everything but files — a
fresh clone needs no store to start — and a half-filled set is refused at
startup by name, rather than failing on the first upload an hour later.

`.env.example` points them at the local `storage` container, bucket
`farhand-dev`; `.env.test` at the same container, bucket `farhand-test`, so the
suite never touches development files. Production points them at Backblaze B2
(`14-deployment.md`). One file, `src/storage.ts`, reads them — the same seam
`src/observability.ts` is for Sentry.

### `APP_ORIGIN`

The one place the frontend is served from — `http://localhost:3100` by default,
which is where `farhand-web` runs, and the real domain in production. Two
things read it:

- **CORS** allows that origin and no other. Requests from anywhere else get no
  `Access-Control-Allow-Origin` header at all, so the browser refuses to hand
  them the answer.
- **The origin check** on writes compares against it.

One value rather than a list. "Configured for the intended frontend origin only"
is the requirement, and a list is how that quietly becomes "and whatever else we
forgot to take out". Two environments that need two values are what two `.env`
files are for.

**The default is the WEB APP, not the API.** It was `http://localhost:5173`
until #156 — a Vite dev server that was never built — and a value that is not
the frontend’s own address makes every form answer `403 Cross-site request
refused`, which reads like a bug in the frontend and is not one.

**This is why `curl` gets a `403` on a write.** A browser always sends `Origin`;
the command line does not. Add `-H "Origin: http://localhost:3100"`, or set
`CSRF_ENABLED=false` while you are poking about by hand.

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
| `npm run test:store-empty` | Check the suite left the file store empty (#109) | yes |
| `npm run store:fill -- 6000` | Fill the file store, to investigate #110 | yes |

## Why not simpler

Installing PostgreSQL directly into Windows would work, and skipping Prisma in
favour of hand-written SQL would also work. Both are used in real projects. The
chosen combination is what the job market asks for most often, and each choice is
recorded in `10-decisions/` so it can be revisited rather than assumed.
