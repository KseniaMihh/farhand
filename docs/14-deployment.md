# Deployment

How Farhand runs somewhere other than a laptop, and how a change gets there.

## The shape of it

| Piece | Where | Why |
|---|---|---|
| The API | Fly.io, one app, EU region | Runs the Dockerfile from #30 as it is; no build pipeline to invent |
| The database | Neon, managed PostgreSQL, same region | Genuinely managed — backups, upgrades and connection pooling are somebody else's job — with a free tier that does not expire |
| Secrets | Fly's secret store | Never in the repository, never in an image layer |
| Deploys | GitHub Actions, on merge to `master` | The same checks that guard a pull request guard a release |
| Monitoring | Fly health checks, plus an external uptime monitor | One decides whether a release is healthy; only the other can tell you the platform is down |

Two vendors rather than one is a deliberate trade. Fly's own Postgres is a
database you operate; Neon's is a database somebody else operates. The issue
asked for **managed** PostgreSQL, and that is the difference.

## The first deploy, once

Everything here needs an account and a card, so it is done by hand, once, in
this order. Nothing in it is repeated on later deploys.

### 1. The database

Create a Neon project in the **same region** as the Fly app — a query that
crosses a continent twice per request is the slowest thing an API can do to
itself. Copy the **pooled** connection string; it is the one that survives a
process with many short-lived connections.

Check it from your own machine before trusting it:

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

### 2. The app

```powershell
fly auth login
fly apps create farhand-api          # the name goes in fly.toml and in the URL
```

Do **not** run `fly launch`: it writes its own `fly.toml` over the committed
one, which is the file that records every decision in this project.

### 3. The secrets

```powershell
fly secrets set DATABASE_URL="postgresql://…" --app farhand-api
fly secrets set SENTRY_DSN="https://…" --app farhand-api      # optional
```

Fly stores these encrypted and injects them as environment variables at run
time. They are never in the repository, never in a layer of the image, and
never printed by a deploy. This is the second acceptance criterion, and the
reason `.env` has been gitignored since the first week.

`APP_ORIGIN`, `NODE_ENV`, `PORT` and `LOG_LEVEL` are **not** secrets: they are
in `fly.toml` where they can be read and reviewed.

### 4. The deploy token

```powershell
fly tokens create deploy --app farhand-api --name github-actions
```

Put the result in the repository as the **secret** `FLY_API_TOKEN`
(*Settings → Secrets and variables → Actions*), and add a repository
**variable** `PUBLIC_URL` with the app's URL, for example
`https://farhand-api.fly.dev`. The workflow uses the first to deploy and the
second to check afterwards that the API really answers.

A deploy token, not a personal one: it can release this one app and nothing
else, which is what a machine should be able to do.

### 5. The first release

```powershell
cd farhand-api
fly deploy --remote-only
```

The first one is manual, so that a failure is yours to read rather than a red
tick on a merge. After that, merging to `master` deploys.

### 6. The monitor

Add a check in Better Stack or UptimeRobot (both free for this):

| | |
|---|---|
| URL | `https://<app>.fly.dev/health` |
| Interval | 60 seconds |
| Alert | email |

`/health`, not `/health/ready`: the external monitor is asking "is the API
answering at all", and a database outage should page differently from the whole
app being gone (#3). The platform's own check, in `fly.toml`, uses
`/health/ready` — because it is deciding whether a release may take traffic,
and a version that cannot reach the database must not.

## Every deploy after that

1. A pull request runs the tests and builds the image. Nothing is deployed.
2. Merging to `master` runs them again, and then the `deploy` job.
3. Fly runs `prisma migrate deploy` in a temporary machine, with the secrets.
   **If it fails, the release stops** and the old version carries on serving.
4. New machines start, one at a time. Each must answer `/health/ready` before
   the old one is removed.
5. The workflow asks the public URL, from outside, whether it is ready.

Migrations are a step before the rollout, never something a booting container
does — the decision recorded in docs/09-environment.md, here expressed as
`release_command`.

## When it goes wrong

```powershell
fly status --app farhand-api           # what is running, and is it healthy
fly logs --app farhand-api             # the structured logs from #29
fly releases --app farhand-api         # what was deployed, and when
fly releases rollback --app farhand-api
```

**Rolling back the code does not roll back the database.** A migration that has
been applied stays applied, so the previous version must still be able to run
against the new schema. In practice that means the additive kind of change —
add a column, deploy, use it — rather than renaming or dropping something the
running version still expects. The first destructive migration is the one to
think hardest about.

## One machine, deliberately

`fly deploy` creates two machines by default, for availability. This app runs
**one**:

```powershell
fly scale count 1 --app <app>
```

Not to save money — they are allowed to stop when idle anyway — but because the
rate limiters count in memory, one tally per process
(`src/middleware/rate-limit.ts`, which has said so since #14). Two machines mean
two tallies and therefore twice the limit: 20 login attempts per address
becomes 40, and the number in the documentation stops being true.

The moment one machine is not enough, the fix is not a second machine — it is
moving those counters to Redis, which the same comment already names. Until
then, one machine keeps the written rules and the running system saying the
same thing.

## What is not here

- **No staging environment.** One app, and pull requests verified by tests
  rather than by a second running copy. When there is a frontend and real
  users, that is the point to add one — not before, because an environment
  nobody looks at is a bill with no reader.
- **No custom domain.** The `.fly.dev` URL is what the README points at. A
  domain is `fly certs add`, and a change to `APP_ORIGIN`, on the day there is
  something to put on it.
- **No autoscaling.** One shared machine, allowed to stop when idle. The moment
  that is not enough is the moment there is something worth measuring.
