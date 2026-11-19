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
| Background work | A loop inside the web service, plus two GitHub Actions schedules | The free plan has no background worker, and email that nobody is waiting for should not be sent by somebody's request ([decision 0019](10-decisions/0019-a-job-table-of-our-own.md)) |
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

**Since #87 the same script also writes the prohibited list**, and forgetting
it has a louder symptom: posting anything publicly answers `500`, and the log
says "The prohibited list is empty". That is deliberate — the alternative is
every posting ticking a list with no lines in it and being recorded as having
acknowledged it, which looks like success
([decision 0021](10-decisions/0021-a-tick-against-wording.md)). Run the seed
after the migration that creates the table, and check it:

```powershell
curl.exe https://<service>.onrender.com/prohibited-items
```

A `version` and ten items is right; `"items": []` means the seed has not run.
Rewording a clause afterwards is done in Neon, not here, and needs no deploy.

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

`PROXY_VOUCH_SECRET` is not in `render.yaml` either, and for the same reason
plus a better one: it is a secret, and it is the one thing that lets the
frontend tell this API who a visitor is (#164,
[decision 0035](10-decisions/0035-the-frontend-states-the-caller.md)). It goes
under *Environment* on the service, and **the identical value** goes on the
Vercel project as a server-side variable — not `NEXT_PUBLIC_`, which would
publish it to every browser. At least 32 characters; a blank or short one
stops the API from booting, deliberately.

**Rotating it is a two-dashboard change and then a redeploy**, in this order:
Render, Vercel, then redeploy `farhand-web`. Next inlines `process.env` into
the edge bundle at build time and Vercel applies an environment change only to
new deployments, so saving it without redeploying leaves the old value live.
In the window where the two disagree nothing breaks — the API falls back to
`req.ip` and writes one `error` line naming the setting.

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

**Done for the live service on 2026-10-12**, and proved rather than assumed.
Nothing at start-up talks to B2 — `src/server.ts` skips `ensureBucket` in
production deliberately — so the first upload is the first real contact, and
the check is worth repeating if any of the five settings ever change:

1. The API restarts and answers `/health`. That alone proves all five values
   are present and well-formed, because `src/env.ts` refuses to boot otherwise.
2. An upload through `PUT /me/avatar` succeeds, and the `/files/:id` path in
   the answer shows the image in a browser.
3. The B2 address that path redirects to, **with the query string removed**,
   is refused by B2 (`UnauthorizedAccess`). This is the one that matters: it is
   the difference between "private" and "nobody has guessed the link yet".
4. The key in that address is a bare UUID, naming neither the file nor its
   owner.

Step 2 needs a verified account. Before step 5 below existed there was no way
to get one — production delivered no mail — so the account used to prove this
was verified with `UPDATE "User" SET "emailVerifiedAt" = now()` in Neon. Since
#119 the ordinary flow works, and that SQL is only a way out if the provider
itself is down.

### 5. Email

Without this the API still runs — and nobody but you can use it, because
`requireVerified` guards 41 routes and nobody can confirm an address. Needed
before anyone else is invited, which is why it is a step rather than a nicety
(#119, [decision 0014](10-decisions/0014-brevo-for-email.md)).

1. **Make an address for the project**, not your own: a new mailbox such as
   `farhand.app@gmail.com`. It becomes the sender of every message the API
   sends, and it is the one Brevo will ask you to prove you own. A personal
   address here is shown to every stranger who registers.
2. **Sign up at Brevo** with that address. The free plan is 300 emails a day
   with no expiry and asks for no card.
3. **Verify the sender**, *Senders, Domains & Dedicated IPs → Senders → Add a
   sender*. Brevo emails a code to the address; paste it back.
4. **Create an API key**, *SMTP & API → API keys → Generate a new API key*.
   Name it for what holds it — `farhand-api-render` — so a second key for a
   laptop can be revoked without taking production down. Copy it then: the
   dashboard shows it once.
5. **Give Render the settings**, *the service → Environment*:

| Variable | Value |
|---|---|
| `MAIL_API_KEY` | the key from step 4 |
| `MAIL_FROM` | the address from step 1, exactly as Brevo verified it |
| `MAIL_FROM_NAME` | optional; what inboxes show instead of the address. Defaults to `Farhand` |
| `MAIL_REPLY_TO` | **leave unset.** A reply to the visible From goes nowhere, and a personal address here is published to everyone who registers |

`MAIL_API_KEY` and `MAIL_FROM` are all-or-none, checked in `src/env.ts` the
same way the `STORAGE_*` set is: one without the other and the API refuses to
start rather than discovering it at the first registration.

**What recipients will see is not `MAIL_FROM`.** Farhand has no domain, a
`gmail.com` address cannot be DKIM-signed by us, so Brevo replaces the domain
part with one of its own: `farhand.app@5000123.brevosend.com`. The message is
delivered and authenticated — by Brevo — and the cost is that the sender looks
unfamiliar, which is the thing most likely to put a first email in a spam
folder. The fix is a domain, three DNS records and one changed setting, on the
day there is a domain; decision 0014 holds the full argument.

Then prove it, the way storage was proved:

1. Register through the live API with an address you can read:
   `POST /auth/register` (remember the `Origin` header, or every write is
   `403`).
2. The mail arrives, carrying a **code** rather than a link — there is no page
   for a link to land on until #93 — and `POST /auth/verify-email` with that
   code answers `200`.
3. Render's logs show `Email sent` and **no token**. A token in a log is a
   working credential; if one appears there, that is a bug and not a
   convenience.

**Done for the live service on 2026-10-12**, and all three held: the message
reached the inbox rather than the spam folder — which was the uncertain part,
since the sender is borrowed — and the code confirmed the account.

#### When somebody says they never got an email

Read this before telling anybody to check their spam folder again. Every
message Brevo sends carries an unsubscribe button, and **clicking it blocklists
that address for our sender**: no confirmation code, no password reset, and no
sign of trouble anywhere the person can see (#121,
[decision 0015](10-decisions/0015-living-with-a-transactional-unsubscribe.md)).

1. **Brevo → Transactional → Logs**, filtered by the address. A row with status
   `blocked` says the message was refused on our side of the fence. No row at
   all says the API call never reached Brevo — that one is in Render's logs
   instead, as `Could not send email`.
2. **The blocklist itself**, with the key from the password manager:

   ```bash
   curl -H "api-key: $BREVO_KEY" \
     "https://api.brevo.com/v3/smtp/blockedContacts?limit=50"
   ```

   Each entry carries the reason it was blocked — an unsubscribe, a hard
   bounce, a spam complaint, or somebody blocking it by hand — which decides
   whether step 3 is appropriate at all.
3. **Undo it only if it was a mistake**, and ask the person first:

   ```bash
   curl -X DELETE -H "api-key: $BREVO_KEY" \
     "https://api.brevo.com/v3/smtp/blockedContacts/somebody@example.com"
   ```

   Brevo warns that unblocking somebody who genuinely asked to be blocked can
   get the account suspended. "They clicked it by accident and want back in" is
   the only case this is for.
4. **If they were blocked and want to stay unsubscribed**, there is nothing to
   do about their account: they cannot be verified and cannot reset a password.
   Say so plainly rather than leaving them retrying.

The real fix is a domain plus a provider that distinguishes transactional mail,
and it waits for #93 — the reasoning, and the trigger that should force it, are
in decision 0015 and `11-risks.md`.

### 6. The monitor

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

## The daily sweep

Three things run on a schedule rather than on a request, in one workflow and
one run. Since #89 the second destroys the payload of any data export that
has had its seven days, and since #91 the third deletes rate-limit windows
that have ended. Both run with `if: always()`: a copy of somebody's personal
history that should have been deleted has nothing to do with whether a deal
completed, and neither has a table of expired counters. One schedule rather
than three on purpose: all of them are "a clock has passed, tidy up", they
want the same cadence, and a second schedule is a second thing that can
silently stop firing — which is what #114 found had happened to this one.

The first of them is the sweep that
completes a deal fourteen days after delivery (#25). Without it a delivered
deal nobody confirms stays `DELIVERED` for ever, and `04-deal-lifecycle.md`
describes a rule the running system does not apply — which is exactly what
happened between #25 and #101, because nothing scheduled it.

| | |
|---|---|
| What | `.github/workflows/auto-complete.yml` |
| When | Daily, scheduled for 03:17 UTC — and run whenever GitHub gets to it. The first two runs started at 10:28 and 09:45. Not on the hour: jobs queued at `:00` compete with everybody else's |
| How | `npm run job:auto-complete`, with Neon's **direct** string |
| By hand | The workflow has `workflow_dispatch`, so it can be run from the Actions tab |

**GitHub Actions rather than the platform.** Render's cron jobs are a paid
service type and the free plan has no scheduler at all. Actions costs nothing
here — a private repository gets 2000 free minutes a month and this spends
about thirty — and the pattern already existed: the deploy job reaches the
same database with the same secret to run migrations.

**Daily is enough.** The deadline is fourteen days and is measured from the
delivery event, not from when the sweep runs, so running up to a day late
changes nothing anybody would feel. Two sweeps at once would also be harmless
— the update is guarded by status, and `tests/deals/cancellation.test.ts`
("is safe to run twice") proves each deal completes exactly once.

### How you would find out it stopped

Worth being honest about, because this is the part that was not built.

- **A run that fails** sets exit code 1, fails the step, and GitHub emails the
  repository owner. That one is covered — and it is how #114 was found: the
  workflow failed on its first two scheduled runs, before reaching the sweep,
  because `prisma generate` had no `DATABASE_URL`. #101 had checked the file's
  shape and never run it.
- **A change to the workflow is not done until it has run.** Actions →
  *Auto-complete delivered deals* → *Run workflow*, and read the log for
  `completed: N`. That is what `workflow_dispatch` is for.
- **A run that finds nothing** logs `completed: 0` and succeeds. Silence here
  means "nothing was due", not "nothing happened".
- **A schedule that stops running tells nobody.** GitHub's documented
  behaviour is to disable scheduled workflows in a repository with no
  activity for 60 days, and a workflow that never starts sends no email. The
  symptom would be deals sitting at `DELIVERED` more than fourteen days after
  their delivery event — visible in the moderator's deal list, and nowhere
  else.

Nothing watches for that, deliberately: a dead man's switch would mean another
vendor for one job. #85 brought the job queue below, and it did not change this
answer: a queue that drains itself still cannot notice a *schedule* that has
stopped firing, because the thing that would notice is the schedule.

## The job queue

Email is not sent by the request that causes it. The request writes a row on
the `Job` table and answers; something else sends it (#85,
[decision 0019](10-decisions/0019-a-job-table-of-our-own.md)). In production
that "something else" is two things.

**The worker inside the web service.** `src/server.ts` starts a loop after it
opens the port — it polls every two seconds when idle — so a job is normally
sent about two seconds after it is queued. It runs *in* the API process
because Render's free plan has no background worker to run it in; one is $7 a
month, and nothing here is paid. The cost of sharing is the 0.1 CPU in the
table below, and sending an email is a `fetch` and a wait, not work.

This is also where [cold starts](#cold-starts) matter: a sleeping service
drains nothing. In practice the monitor's check every five minutes keeps it
awake, and a job only exists because a request arrived, which means the
service was awake a moment ago.

**The backstop in GitHub Actions.** `.github/workflows/drain-queue.yml` runs
`npm run job:drain` every six hours — the same `drain()` the worker calls,
once, then exits. It is not there for latency. It is there so that a queue
cannot *silently* stop draining while the service is asleep, crash-looping or
mid-deploy. Every six hours rather than every five minutes because 120 runs a
month is about 150 of the 2,000 free minutes a private repository gets, and CI
on pull requests is the real spender of those. If minutes ever get tight, this
is the first thing to switch off.

**Mail is deliberately not configured there.** `MAIL_API_KEY` lives in Render,
not in Actions secrets, so a drain in Actions *fails* the mail jobs rather than
consuming them — they wait for the process that can really send. That is why
"no mail provider configured" is an error in production rather than a quiet
success (decision 0019).

### How you would find out it stopped draining

- **A job that keeps failing** is retried five times — a minute, five,
  twenty-five — and then reported once through Sentry (#29), with the
  provider's words in `Job.lastError` and never a token in them.
- **A run of the backstop that cannot read the queue at all** exits 1, fails
  the step and emails the repository owner. A run with nothing to do logs
  `done: 0` and succeeds.
- **The query that answers "is anything stuck"**, in Neon:

  ```sql
  SELECT kind, attempts, "lastError", "runAfter"
  FROM "Job" WHERE "doneAt" IS NULL ORDER BY "createdAt" LIMIT 20;
  ```

  Rows with `attempts` climbing mean a provider is unwell; rows with
  `failedAt` set mean somebody never got their email, and the only fix is to
  look at why and queue it again.

## Before the first real person arrives

Everything above is about getting a change to production. One thing is about
whether production actually works, and it is not a deploy step: the
[pre-launch smoke test](16-pre-launch-smoke-test.md), one walk through the
whole product by hand with four test aliases — a standing query, a need, a
photo, a proposal, a deal, receipts, completion, reviews, a moderator's
decision, an erasure, a copy of somebody's own data, and a notification both
arriving and deliberately not arriving.

It exists because the test suite cannot reach any of the things that have
actually been wrong here: the bucket's privacy, the mail key, the proxy hop
count, the worker being awake, a schedule that never fired. That list is not
a worry; it is a record. The first walk, on 21 October 2026, found the hop
count wrong — one trusted proxy where production has three — and 1181 green
tests had never been able to say so (#145, decision 0029). It is run once,
before #93 opens the API to anybody who is not the author.

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

It arrived with #80, and this is how it was done. Replacing `Profile.avatarUrl`
with `avatarFileId` in one migration would have dropped a column the running
version selects on every `/auth/me`: a few minutes of errors on every deploy
of it. So it is two steps, in two releases:

1. **Expand.** Add the new column; the new code reads and writes only that.
   The old column stays, unused. Both versions can run against this schema.
2. **Contract.** Once nothing running reads the old column, a later migration
   drops it. By then the old version is gone, so nothing can break.

Renaming works the same way: add, copy, switch, and only then drop.

### Contracting is itself two releases (#103)

"Once nothing running reads the old column" reads like *delete the line that
touches it*. With Prisma it is not, and the difference is the whole site for
the length of a build.

**Prisma names every column of a model** in its `SELECT` and `RETURNING`
lists, whether or not the application does anything with them. So the one
line writing `Profile.avatarUrl` was the smallest part of the problem:

```
INSERT INTO "Profile" (…) RETURNING …, "avatarUrl", …        register
SELECT "Profile"."userId", …, "avatarUrl", …                 every profile read
UPDATE "Profile" SET "bio"=$1 … RETURNING …, "avatarUrl"     PATCH /me/profile
UPDATE "Profile" SET "avatarFileId"=$1 … RETURNING "avatarUrl"  PUT /me/avatar
```

Dropping the column under code that still names it breaks registration, every
profile read, every profile edit and avatar uploads — all of them, for the
few minutes the old version is still serving.

`@ignore` is what reaches a safe state. It removes the field from the
**generated client** while leaving it in this schema and in the database, so
the migration engine sees no drift (`prisma migrate status` stays "up to
date") and the running code stops naming the column. So:

| | Client names the column | Column exists | Safe |
|---|---|---|---|
| before | yes | yes | ✓ |
| **release 1** — `@ignore`, delete writes, **no migration** | no | yes | ✓ both versions |
| **release 2** — remove the field, migrate the drop | no | no | ✓ |

Both releases happened: #107 and #108. The second is
`prisma/migrations/20261008125600_drop_profile_avatar_url`, whose comment
is written for whoever meets this next.

Two useful things fall out of doing it in that order. Adding `@ignore` makes
**the type checker find every remaining use** — it found two in tests that no
search for the obvious write would have turned up, one of which had been
comparing a response field against the dead column and passing only because
both were null. And release 1 can be *proved* before release 2 is written —
which is the part worth copying. A test exercised every endpoint that
touches the table and failed if any statement mentioned the column, so the
drop was applied on evidence rather than on reasoning. That test went with
release 2: once the column does not exist, it cannot fail, and a test that
cannot fail is worse than none (`13-workflow.md`). Write the equivalent for
the next column, and delete it the same way.

One more thing to do before merging release 2, because the migration cannot
be undone by rolling back code: count what you are about to destroy.

```sql
-- against production, before the merge
SELECT count(*) FROM "Profile" WHERE "avatarUrl" IS NOT NULL;
```

Zero here was predicted from the git history — no code had ever written the
column — and checking it costs one query. A destructive migration is the
one place where *predicted* and *verified* are worth keeping apart.

## One instance, and now for one reason

`render.yaml` sets `numInstances: 1`. Until #91 there were **two independent**
reasons for that, and only one of them is left.

**The plan.** Render's free plan does not scale past a single instance, so `1`
is the only value it would accept. That is still true, and it is now the only
thing in the way.

**The code — fixed in #91.** The rate limiters used to count in memory, one
tally per process (`src/middleware/rate-limit.ts`, which said so from #14
until #91). Two instances meant two tallies and therefore twice every
documented limit: 20 login attempts per address became 40, 10 per account
became 20, 300 requests a minute became 600. Worse than the doubling, the
`RateLimit` headers would have disagreed with each other request by request,
and somebody refused with a `429` could have tried again and been served by
the other instance's fresh count. The numbers in `06-api-contract.md` would
have stopped being true in a way nobody could predict.

The counters now live in the database every instance already shares — a
`RateLimit` table and about a hundred lines of store, rather than a Redis to
run and pay for (decision 0027, and 0019's argument about the job queue
repeated). A test proves it the only way that means anything: it builds two
independent copies of the application, spends the login budget across both,
and expects the twenty-first request to be refused by either
(`tests/security/shared-rate-limits.test.ts`).

**So `numInstances` is now a plan question, not a correctness one.** On a paid
plan it can go above one without anything in the code changing. What would
still want thinking about on the day:

| | |
|---|---|
| The worker | Every instance runs `startWorker()`, and #85's `FOR UPDATE SKIP LOCKED` claim is built for exactly that — two workers step over each other's rows rather than queueing behind them |
| The counters | One short statement per limited request, against the database. Fine at this size; the first thing to measure if it ever is not |
| Sticky anything | There is none. Sessions are a hashed cookie checked against a table, so any instance can answer any request |

This section used to say the single instance was *"not to save money — the
reason is the code's"*. That was true, and it left the impression that the
plan would allow two. It would not (#100). Now the code's reason is gone and
the plan's is all that remains.

## Cold starts

A free Render service sleeps after 15 minutes with no requests, and the next
request wakes it, which takes 30–60 seconds. On Fly the same idea —
`min_machines_running = 0` — cost a second or two.

Fine for an API with no frontend and no users. Not fine the day someone is
meant to depend on it, and Render's own documentation says free services are
not for production. That day is the one to pay for a host, and decision 0010
says what would justify it.

## What the free plan rules out

These are Render's documented limits for the free plan rather than anything
measured here, and each one has already decided something:

| Limit | What it decides |
|---|---|
| A single instance | See above: since #91 it is the **only** reason `numInstances` is `1` |
| Sleeps after 15 idle minutes | The cold start above. It used to wipe the rate-limit counters too; since #91 they are rows, and they survive a sleep, a restart and a deploy |
| 0.1 CPU, 512 MB | Why argon2id hashing and avatar re-encoding are the two expensive things the API does, and why both are limited per user |
| **Outbound SMTP is blocked** (ports 25, 465, 587) | Email cannot be sent by connecting to a mail server. This is what chose Brevo's HTTP API in #119 — one `fetch`, no SMTP library in the project at all (decision 0014) |
| **No background workers** ($7 a month for one) | Why the job queue runs inside the web service rather than beside it, with an Actions cron as its backstop (decision 0019) |

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
