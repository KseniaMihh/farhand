# Deployment

How Farhand runs somewhere other than a laptop, and how a change gets there.

## The shape of it

| Piece | Where | Why |
|---|---|---|
| The API | Render, one free web service, Frankfurt | Runs the Dockerfile from #30 as it is, and costs nothing for good |
| The database | Neon, managed PostgreSQL, same region | Genuinely managed — backups, upgrades and connection pooling are somebody else's job — with a free tier that does not expire |
| Uploaded files | Backblaze B2, a private bucket, EU | 10 GB free with no card, and it speaks S3, so it is five settings rather than code ([decision 0011](10-decisions/0011-backblaze-b2-for-files.md)) |
| Secrets | Render's environment settings, and GitHub Actions secrets | Never in the repository, never in an image layer |
| Deploys | GitHub Actions, on merge to `master` | The same checks that guard a pull request guard a release |
| Monitoring | Render's health check, plus an external uptime monitor | One decides whether a release is healthy; only the other can tell you the platform is down |

Two vendors rather than one is a deliberate trade, made first with Fly and kept
with Render: the database is somebody else's to operate, and the API's host
can change without the data moving. It just did — the API ran on Fly until its
free trial ended, and why it moved is
[decision 0010](10-decisions/0010-render-over-fly.md). Nothing here is paid,
and no card is on file anywhere.

`render.yaml`, at the repository root, describes the service: plan, region,
health check, instance count, and every environment variable that is not a
secret. It is the file that records the decisions, so change it there rather
than in the dashboard.

## The first deploy, once

Everything here needs an account, so it is done by hand, once, in this order.
Nothing in it is repeated on later deploys.

### 1. The database

Create a Neon project in the **same region** as the API, Frankfurt — a query
that crosses a continent twice per request is the slowest thing an API can do
to itself. Neon gives two connection strings, and both are needed:

| String | Used by | Why that one |
|---|---|---|
| **Pooled** | Render, to run the app | Survives a process with many short-lived connections |
| **Direct** | GitHub Actions, to run migrations | Prisma's migration lock does not survive a connection pooler |

Check the direct one from your own machine before trusting it:

```powershell
$env:DATABASE_URL="postgresql://…"; npx prisma migrate deploy
```

That applies every migration to the new database, and proves the string works
before anything depends on it.

Then the categories, which are data rather than schema and therefore arrive
separately:

```powershell
$env:DATABASE_URL="postgresql://…"; npm run seed
```

Easy to forget, and the symptom is puzzling: everything looks healthy,
`/needs` answers, and nobody can post one — because a need must name a category
and there are none. The script is idempotent, so running it again after any
deploy that changes the list costs nothing.

### 2. The service

Sign in to Render with GitHub, then **New → Blueprint**, pick this repository,
and Render reads `render.yaml`. It asks for the one variable marked
`sync: false`:

| Variable | Value |
|---|---|
| `DATABASE_URL` | Neon's **pooled** string |

Render stores it and injects it as an environment variable at run time. It is
never in the repository, never in a layer of the image, and never printed by a
deploy.

`SENTRY_DSN` is deliberately not in `render.yaml`. A variable Render asks for
can be saved blank, and a blank one fails the URL check in `src/env.ts`, so
the API would refuse to start. Add it under *Environment* on the day there is
a DSN to put in it.

`NODE_ENV`, `PORT`, `LOG_LEVEL` and `APP_ORIGIN` are **not** secrets: they are
in `render.yaml` where they can be read and reviewed. `PORT` is pinned to
`3000` because the Dockerfile's own `HEALTHCHECK` asks that port.

The first build starts on its own. Note the URL Render gives the service —
`https://farhand-api.onrender.com`, or with a suffix if that name was taken —
and make sure `APP_ORIGIN` in `render.yaml` and the links in the README say
the same.

### 3. What GitHub needs

Under *Settings → Secrets and variables → Actions*:

| Kind | Name | Value |
|---|---|---|
| Secret | `DATABASE_URL` | Neon's **direct** string |
| Secret | `RENDER_DEPLOY_HOOK_URL` | Render → the service → *Settings* → *Deploy Hook* |
| Variable | `PUBLIC_URL` | The service's URL, for example `https://farhand-api.onrender.com` |

A deploy hook, not a Render API key: the hook can start a deploy of this one
service and nothing else, while an API key can do anything the account can.
That is what a machine should be able to do. If the hook ever leaks,
regenerate it in the same place.

### 4. File storage

Without this the API still runs — everything works except files — so it can
be done after the first deploy. It is needed before any upload (#80 on).

1. **Sign up at Backblaze for B2 Cloud Storage**, and choose **EU Central** as
   the region when asked. The region belongs to the account, is chosen once at
   sign-up, and cannot be changed afterwards; EU keeps the files near the API
   in Frankfurt. No card is asked for.
2. **Create a bucket**, *Buckets → Create a Bucket*. The name is global across
   all of B2, so make it yours (`farhand-files-<you>`). Set *Files in Bucket*
   to **Private**. This is the setting that makes "bytes are never public"
   true in production. Leave Object Lock off.
3. **Note the endpoint** shown on the bucket's card, for example
   `s3.eu-central-003.backblazeb2.com`. The part after `s3.` and before
   `.backblazeb2.com` is the region (`eu-central-003`).
4. **Create a key for the API**, *Application Keys → Add a New Application
   Key*: name `farhand-api`, access to **this bucket only**, type **Read and
   Write**. B2 shows the `applicationKey` once. Copy it then.
5. **Set every cap to $0**, *Caps & Alerts*. Storing and requests cost nothing
   on the free tier, but data sent out is free only up to three times what is
   stored. With the caps at zero, the worst case is images not loading until
   the cap resets, never a bill.
6. **Give Render the five settings**, *the service → Environment*:

| Variable | Value |
|---|---|
| `STORAGE_ENDPOINT` | `https://` plus the endpoint, e.g. `https://s3.eu-central-003.backblazeb2.com` |
| `STORAGE_REGION` | e.g. `eu-central-003` |
| `STORAGE_BUCKET` | the bucket's name |
| `STORAGE_ACCESS_KEY_ID` | the key's `keyID` |
| `STORAGE_SECRET_ACCESS_KEY` | the key's `applicationKey` |

All five or none. A partial set, or one saved blank, is refused by the check
in `src/env.ts` and the API will not start. That is also why they are set in
the dashboard rather than listed in `render.yaml`: a variable Render asks for
can be saved blank, the same reason `SENTRY_DSN` is not listed there.

Production's bucket is created here, by hand. The API never creates it, and
never makes anything in it public.

### 5. The monitor

Add a check in Better Stack or UptimeRobot (both free for this):

| | |
|---|---|
| URL | `https://<service>.onrender.com/health` |
| Interval | 5 minutes |
| Alert | email |

`/health`, not `/health/ready`: the external monitor is asking "is the API
answering at all", and a database outage should page differently from the whole
app being gone (#3). The platform's own check, in `render.yaml`, uses
`/health/ready` — because it is deciding whether a release may take traffic,
and a version that cannot reach the database must not.

A side effect worth knowing: a check every 5 minutes is traffic, so it keeps
the service from ever going to sleep (see [cold starts](#cold-starts)). One
service awake all month is about 730 hours, inside the free 750, so this costs
nothing — but the 750 are per workspace, and a second free service on the same
account would share them.

## Every deploy after that

1. A pull request runs the tests and builds the image. Nothing is deployed.
2. Merging to `master` runs them again, and then the `deploy` job.
3. The job runs `prisma migrate deploy` against Neon, with the direct string.
   **If it fails, the release stops** and the old version carries on serving.
4. The job calls the deploy hook with `ref=<the commit>`, so Render builds
   exactly what was tested. Anything but `200` fails the job — `202` means
   another deploy was already queued, and then nobody can say which version
   will end up live.
5. Render builds the image and starts it. It moves traffic only once the new
   version answers `/health/ready`.
6. The job asks the public URL, from outside, until `GET /health` reports the
   commit it deployed, and then until `/health/ready` answers `200`.

Step 6 is why `/health` reports `commit` (docs/06-api-contract.md). The deploy
hook returns as soon as the deploy is queued, and for the whole length of the
build the **old** version answers `/health/ready` perfectly well. Readiness
alone would report success before anything had changed; the commit says which
version is talking. The job waits up to ten minutes for it — a Docker build
plus a cold start.

`autoDeployTrigger` is `off` in `render.yaml`, so a push to `master` does not
deploy by itself. If it did, Render would start building at the same moment CI
starts testing, and nothing would guarantee the migrations had run first.

Migrations are a step before the rollout, never something a booting container
does — the decision recorded in docs/09-environment.md. On Fly that step was
`release_command`; Render's free tier has no pre-deploy command, so CI runs it
instead. Same order, different place.

## When it goes wrong

| | Where |
|---|---|
| What is running, and is it healthy | Render → the service → *Events* |
| The structured logs from #29 | Render → the service → *Logs* |
| What was deployed, and when | *Events*, and the `deploy` job in GitHub Actions |
| Roll back | Call the deploy hook with `ref=` an earlier commit (below) |

```powershell
curl.exe "<RENDER_DEPLOY_HOOK_URL>&ref=<earlier commit sha>"
```

The same hook CI uses, pointed at a commit that is known to work. It builds
that commit again rather than reusing an old image, so it takes as long as any
deploy. The next merge to `master` deploys forward again as usual.

The deploy job's log says which step stopped: a failed migration (nothing was
deployed), a refused hook (nothing was deployed), or a version that never went
live (Render's *Events* has the build or health-check failure).

**Rolling back the code does not roll back the database.** A migration that has
been applied stays applied, so the previous version must still be able to run
against the new schema. In practice that means the additive kind of change —
add a column, deploy, use it — rather than renaming or dropping something the
running version still expects.

On Render that is not only a rollback concern. Migrations run before the build
starts, so during **every** deploy the old version serves requests against the
new schema for the few minutes the build takes. An additive migration is
harmless there; a destructive one breaks the running version before its
replacement exists. The first destructive migration is the one to think hardest
about.

## One instance, deliberately

`render.yaml` sets `numInstances: 1`. Not to save money — the reason is the
code's: the rate limiters count in memory, one tally per process
(`src/middleware/rate-limit.ts`, which has said so since #14). Two instances
mean two tallies and therefore twice the limit: 20 login attempts per address
becomes 40, and the number in the documentation stops being true.

The moment one instance is not enough, the fix is not a second instance — it
is moving those counters to a shared store (#91). Until then, one instance
keeps the written rules and the running system saying the same thing.

## Cold starts

A free Render service sleeps after 15 minutes with no requests, and the next
request wakes it, which takes 30–60 seconds. On Fly the same idea —
`min_machines_running = 0` — cost a second or two.

Fine for an API with no frontend and no users. Not fine the day someone is
meant to depend on it, and Render's own documentation says free services are
not for production. That day is the one to pay for a host, and decision 0010
says what would justify it.

## What is not here

- **No staging environment.** One service, and pull requests verified by tests
  rather than by a second running copy. When there is a frontend and real
  users, that is the point to add one — not before, because an environment
  nobody looks at is a bill with no reader.
- **No custom domain.** The `.onrender.com` URL is what the README points at.
  A domain is a setting in Render and a change to `APP_ORIGIN`, on the day
  there is something to put on it.
- **No autoscaling.** One free instance, allowed to sleep when idle. The moment
  that is not enough is the moment there is something worth measuring.
- **No CDN in front of files.** Every image is read straight from B2 through a
  five-minute signed link. Real users looking at real photos is the day to
  measure egress and put a cache in front (decision 0011).
