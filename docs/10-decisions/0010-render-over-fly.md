# 0010 — Render's free tier instead of Fly

## Context

Fly.io ended free allowances for new accounts, and the trial on this account
runs out on 2026-10-06. This project has no paid layer by intent: it is a
portfolio and learning project with no revenue behind it, and every service it
uses so far — Neon, GitHub — runs on a free tier that does not expire. Paying to keep a demo link alive would be the one exception.

`docs/14-deployment.md` chose Fly for: deploying straight from the Dockerfile
already built in #30, a `release_command` that runs migrations in their own
step before traffic moves to a new version, and a region close to Neon's.
Render keeps the first and third of those. The second does not survive the
move — Render's free tier has no pre-deploy hook, so migrations move from the
platform to CI instead (the new `deploy` job in `ci.yml`).

## Decision

A Render free web service, Docker runtime, Frankfurt region — matching Neon's
region, for the same reason `fly.toml` did. `render.yaml` holds the shape;
`DATABASE_URL` and `SENTRY_DSN` stay out of it, entered once in Render's
dashboard, the same separation `fly secrets set` kept. One instance, for the
rate-limit reason in `docs/14-deployment.md`.

`autoDeployTrigger` is off. Render would otherwise start a deploy on every
push to `master`, at the same moment CI starts testing it — with no guarantee
the migrations have run, or that the tests passed. CI deploys instead, after `prisma migrate
deploy` succeeds, using a deploy hook URL as a one-shot trigger.

With Fly, "is the new version answering" came almost for free: `fly deploy`
did not return until migrations had run and the new machine had passed its
health check, so the check that followed it was asking about the right
version. A deploy hook returns as soon as the deploy is queued. Render's flow is three separate steps —
migrate, trigger, poll — so the thing that used to be implicit is now explicit
in `ci.yml`, and the way CI tells the new version from whatever was running
before is the `commit` field this issue adds to `GET /health`: the deploy job
polls until that field reports the commit it just pushed.

## Alternatives considered

**Pay for Fly.** Rejected for the reason above: no paid layer, by design, for
a project with no revenue.

**No hosting until there is a frontend.** Tempting, but the whole value of
having a deployed API — a real URL to point an interviewer at, and a system
that has actually been exercised by requests crossing the internet rather than
only `localhost` — exists independently of whether a frontend exists yet.
Taking the API down would undo work #30 and #31 already did.

**Google Cloud Run.** A generous free tier, but it needs a card on file even
to stay inside it, and a card on file is exactly the risk this decision exists
to remove.

**Poll Render's API with an account-wide API key**, instead of a deploy hook.
A deploy hook is scoped to "redeploy this one service"; an API key can do
anything the account can do. The deploy hook is the narrower credential for
the job actually being done, and the narrower credential is the one that
belongs in a GitHub secret.

**`autoDeployTrigger: checksPass`.** Render waits for the commit's GitHub
checks to pass, then deploys. Closer to automatic, but the migration step is
one of those checks — it lives in the `deploy` job. Render would either start
deploying while that job is still migrating, or, if it waits for the job, the
job would be waiting for a deploy that waits for it. Calling the hook from the
job keeps "migrate first, then deploy" a sequence rather than a race, the same
way `fly.toml`'s `release_command` did.

## Consequences

**Cold starts.** Render's free tier sleeps a service after 15 idle minutes and
takes 30–60 seconds to wake it, where Fly's stopped machine took a second or
two. The same trade `fly.toml`'s `min_machines_running = 0` made, at a steeper
price — fine for a portfolio link, not fine the day someone is meant to depend
on this being fast. The deploy job's wait allows for it.

**A window where the old version runs against the new schema.** Migrations
apply before the deploy hook fires, so for the length of a Render build (a
few minutes) the previous container is still serving requests against an
already-migrated database. `docs/14-deployment.md`'s existing warning —
rolling back code does not roll back the database — already covers this; it
now also covers the ordinary deploy path, not only a rollback.

**CI now holds a database credential.** Before, only the platform knew
Neon's connection string; GitHub held a deploy token that could release one
app and nothing more. Now GitHub Actions holds `DATABASE_URL` too, because it
runs the migrations. It is the direct (non-pooled) string, since Prisma's
migration lock does not survive a connection pooler; Render keeps the pooled
one.

**Free services are not for production**, which Render says itself.

**What would justify paying again:** real users, or the frontend going live.
At that point cold starts stop being a quirk of a demo link and become
something people wait through — the moment, in `docs/14-deployment.md`'s
words, that there is something worth measuring.
