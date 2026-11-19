# The pre-launch smoke test

One walk through the whole product, **on production**, by hand, before the
first person who is not the author can reach it. It is run once, in one
sitting, and it blocks #93.

Everything here is covered by automated tests already. That is not the point.
The suite proves the code is right against a database in Docker and a mail
provider that is a `vi.spyOn`; this proves the *deployment* is right — the
bucket, the signed links, the mail key, the worker, the cron, the proxy, the
pooler. Every one of those has been wrong at least once in this project's
history, and none of them can be wrong in a way `npm test` would notice.

## Before you start

| | |
|---|---|
| Where | `https://farhand-api.onrender.com`, the real one |
| Who | **Four** throwaway aliases, `appfarhand+smokeA@gmail.com` through `…+smokeD@gmail.com`. **A** is the requester, **B** the helper, **C** a bystander who is made a moderator half way through, and **D** a spare that exists to be banned and erased. All four register and verify; C and D need verified addresses because an unverified account may not act at all |
| What you need open | All four inboxes, Render's logs, and Neon's SQL editor |
| How long | Half an hour, unhurried |

**Do not click unsubscribe in any of these emails.** One click blocks that
address for *everything* Farhand sends, verification and password resets
included — the hazard in
[decision 0015](10-decisions/0015-living-with-a-transactional-unsubscribe.md)
and `11-risks.md`. If you want to test turning email off, use
`PATCH /me/notifications`, which is step 10 and exists for exactly this reason.

**Every write needs an `Origin` header.** The site-wide origin guard refuses a
write that does not carry one (`src/middleware/security.ts`), and `curl`
sends none by default, so every non-GET below includes
`-H "Origin: https://farhand-api.onrender.com"`. A `403` with a sensible body
usually means you left it off.

A cold service takes 30–60 seconds to answer the first request (free plan,
`14-deployment.md`). That is not a failure.

**Neither is an email that takes two or three minutes.** The 21 October run
saw it repeatedly. The row is written and the job is `doneAt` long before the
message is in the inbox, so check `Job.doneAt` and `Notification.sentAt`
before concluding anything: if those are set, Brevo has it and you are waiting
on a mail queue rather than on Farhand.

## The walk

Tick each one. If a step fails, write down exactly what the answer was and
open an issue for it: a failure here is a deployment fact, not a flaky test.
Then carry on, unless the rest of the walk is built on the thing that failed.
The 21 October run found its second failure two steps after its first, and
stopping at the first would have hidden it.

### 1 · It is awake, and it is the right version

- [ ] `GET /health` returns `200`, and `commit` is the SHA at the top of
      `master`.
- [ ] `GET /health/ready` returns `200` with a database latency in single-digit
      milliseconds.
- [ ] **`GET /prohibited-items` returns ten items**, not
      `{"version":"e3b0c44298fc1c14","items":[]}`. That fingerprint is the hash
      of an empty list, and it means the seed has not been run on this database
      — in which case nothing can be posted publicly at all (#87). It is first
      because everything from step 5 onwards depends on it, and because it has
      already happened once: the table arrived with #87's migration and sat
      empty until somebody noticed.

### 2 · Register the accounts, and really receive the email

- [ ] `POST /auth/register` for A → `201`.
- [ ] The verification email arrives **in the inbox, not in spam**, from
      `…@12440880.brevosend.com`.
- [ ] `POST /auth/verify-email` with the code → `200`.
- [ ] The same three for B, C and D. Four registrations is also four passes
      through the queue, which is the next step's evidence.

This is the queue (#85) and the provider (#119) in one step: the request only
wrote a row, and the email means the in-process worker claimed it and Brevo
accepted it.

### 3 · The worker is really running, not just the backstop

- [ ] In Neon: `SELECT kind, "doneAt" FROM "Job" ORDER BY "createdAt" DESC
      LIMIT 8;` — the four verification jobs are **done**, within seconds of
      registering.
- [ ] Render's logs show `Job worker started` for the current deploy.

If jobs are only completing every six hours, the in-process worker is not
running and the GitHub Actions backstop is carrying the queue on its own.

### 4 · A standing query, set up before there is anything to match

This one is first because it has to be: a saved search is matched at the
moment a listing becomes public (#90), so it must exist before the need in
the next step is posted. Nothing is expected to happen here.

- [ ] B saves a search the next step's need will match:

      POST /me/searches
      { "kind": "NEED", "name": "Sunscreen to Estonia",
        "filters": { "buyCountry": "JP", "deliverCountry": "EE",
                     "q": "sunscreen" } }

      → `201`, and the body reads the filters back in the same words.
- [ ] `GET /me/searches` shows it, and **A's list is empty** — a saved search
      is one person's.
- [ ] B saves a second one with `"notify": false`, matching the same thing.
      It must stay silent in the next step while the first one speaks.

### 5 · A need, with a photograph — and the tick that lets it be posted

- [ ] A posts a need **with no `prohibitedVersion`** → `422`, naming the
      field. A client that simply omits it must not get past (#87).
- [ ] A posts a need with `prohibitedVersion` from step 1 → `201`.
- [ ] A saves a second need as `status: "DRAFT"` with no tick → `201`, because
      nobody can see a draft.
- [ ] In Neon, **now and not after the next two ticks**:
      `SELECT status, "prohibitedVersion", "prohibitedAckAt" FROM "Need";` —
      the published need carries the fingerprint from step 1, and the draft
      carries nulls in both columns. The two ticks below publish that draft,
      and a published draft carries the fingerprint like any other need: run
      this query afterwards and there is nothing left with nulls to look at.
- [ ] A publishes that draft with `PATCH /needs/:id` and `status: "OPEN"`,
      still with no tick → **`422`**. This is the one the issue was named for:
      saving a draft and publishing it was the way past the whole mechanism.
- [ ] The same PATCH with the tick → `200`, and that row now carries the
      fingerprint too.
- [ ] A uploads a photo: `POST /needs/:id/photos` → `201`.
- [ ] `GET /files/:id` redirects, and the image really loads in a browser.
- [ ] **The same URL with the query string removed is refused** by Backblaze
      with `UnauthorizedAccess`. This is the difference between a private
      bucket and a link nobody has guessed yet (#79, #81).
- [ ] **B receives "Matches your saved search: …"**, naming the need A has
      just posted (#90). This is the longest path in the product — a publish
      writes a job, the worker matches every standing query, that writes a
      notification, which queues a second job, which sends the mail — and it
      is the only email in Farhand that nobody has to act on.
- [ ] **Exactly one** such email, although two of B's searches match it. One
      listing is one email, whatever else is saved.
- [ ] **A is not emailed about A's own need**, which is the other half of the
      same rule.
- [ ] In Neon: `SELECT kind, "subjectType", "sentAt" FROM "Notification"
      WHERE kind = 'saved-search-match';` — one row, `subjectType` `need`,
      `sentAt` set.

### 6 · An offer, and the first notification

- [ ] B offers to help: `POST /needs/:id/proposals` → `201`.
- [ ] **A receives "… offered to help: …"** — the first notification email
      (#86), and the first proof that a notification composed from live rows
      reaches a real inbox.
- [ ] A accepts: `POST /proposals/:id/accept` → `201`.
- [ ] **B receives "Your offer was accepted: …"**.

### 7 · The deal, end to end

Each transition is `POST /deals/:id/transition` with `{ "to": … }`, by the
side the table allows (`04-deal-lifecycle.md`).

- [ ] B quotes: `POST /deals/:id/quote` → `201`, and **A receives "A quote
      arrived: …"**.
- [ ] A agrees the quote → `QUOTE_AGREED`. **No email** — A's own next move.
- [ ] A pays → `PRODUCT_PAID`, and **B receives "Your turn: …"**.
- [ ] B buys → `PURCHASED`. **No email** — B's own next move.
- [ ] B uploads a receipt: `POST /deals/:id/receipts/product` → `201`, and a
      **PDF** to `POST /deals/:id/receipts/shipping`, since a photograph and
      a PDF take different paths through the same endpoint (#82).

      The kind in the path is `product` or `shipping`, lower case
      (`routes/deals.ts` parses it with a `z.enum`). `PRODUCT_RECEIPT` is the
      `FilePurpose` stored in the column, which is what `05-data-model.md` and
      the permission table in `06-api-contract.md` are naming — not a path
      anything will answer on.
- [ ] A can read B's receipt; **C cannot** — ask as C and get a `404`, which
      is the same answer a receipt that does not exist gets.
- [ ] B posts it → `SHIPPED` with a tracking number and real postage, and
      **A receives "Your turn: …"** — the settle-the-difference email the
      lifecycle document has promised since #22.
- [ ] A confirms → `DELIVERED`. **No email**.
- [ ] A completes → `COMPLETED`, and **both A and B receive "Completed, and
      you can leave a review"**.

### 8 · Reviews, blind until both are in

- [ ] A reviews B: `POST /deals/:id/review` → `201`. **Neither of them is
      emailed** — that silence is deliberate (#83, decision 0020).
- [ ] B cannot yet see A's review: `GET /users/:id/reviews` for B shows
      nothing from this deal.
- [ ] B reviews A → both reviews become visible at once.
- [ ] B's public profile shows the rating summary, e.g. `5.0 from 1 review`
      (#84).

### 9 · The moderator's view

- [ ] Give C `MODERATOR` in Neon, then `POST /admin/users/:id/actions` with
      `WARN` against B. Everything below is done as C.
- [ ] **B receives "A decision about your Farhand account"**.
- [ ] A reports B: `POST /reports` with `targetType: "USER"`, then open it as
      the moderator: `GET /admin/reports/:id`.
- [ ] **The target carries no `passwordHash` and no `email`** (#95). Read the
      JSON, do not take it on trust — this was true in production until
      21 October, and the shape is exactly what a hurried eye skims past.
- [ ] Give **D** an avatar (`PUT /me/avatar` as D), ban D, and **open that
      avatar as C**: `GET /files/:id` still redirects (#139), while the same
      request as A gets a `404`. A ban must not hide the picture it was for.
      D rather than B, because a banned account can do nothing else, and B is
      still needed for the switch in step 10.
- [ ] **Erase D**: `DELETE /admin/users/:id` with a reason → `204`, and the
      same call again → `204` with **no second audit row** in `AdminAction`
      (#88). Erasing an account that is merely `ACTIVE` → `409`, naming
      `DELETE /me`.
- [ ] In Neon: that `User` is `DELETED` with a reserved-domain address, its
      `Profile` is blanked, and its listings are closed. **No email is sent** —
      there is nowhere left to send one.
- [ ] Use a *fresh* account for this, not one with a live deal: an account in
      a running deal is refused on purpose, and nothing can yet clear it
      (#134). Step 12 does the other half, where the owner asks for
      themselves — the two paths share one function, and this walk is the only
      place both of them run against the real database.

### 10 · The switch, which is the one that must not be skipped

- [ ] B turns email off: `PATCH /me/notifications` with
      `{"emailNotifications": false}` → `200`.
- [ ] Cause a notification for B — the simplest is a second need from A and a
      second offer from B, then A accepts, which would normally email B.
- [ ] **No email arrives**, and in Neon there is **no new row at all**:
      `SELECT kind, "sentAt", "skippedAt" FROM "Notification"
      ORDER BY "createdAt" DESC LIMIT 5;` — nothing `proposal-accepted` for
      B, the newest row for B still being step 9's warning.

      This correction is what the 21 October run was worth. The walk used to
      expect a row with `skippedAt` set, and that is a different case:
      `notify()` asks the preference **before** it writes anything, so
      somebody who had email off when the event happened leaves no row behind
      at all. `skippedAt` is for the gap between the event and the sending —
      the account went, or the switch moved while the job was queued
      (`05-data-model.md`; both of those paths are tested in
      `tests/notifications/notifications.test.ts`).
- [ ] Now `WARN` B again as the moderator. **The email arrives anyway**:
      moderation is exempt, and that exemption is the one thing about the
      switch somebody will complain about if it is wrong.
- [ ] B turns it back on → `200`.
- [ ] **A cancels that second deal**: `POST /deals/:id/transition` with
      `{"to": "CANCELLED"}` → `200`, and **B is emailed about it**. The switch
      coming back on is proved by the next thing that happens, not by the
      setting echoing itself.
      That cancellation is not tidying up, it is step 12: B closes its own
      account there, and an account with a live deal is refused on purpose,
      with nothing yet able to clear it (#134). This step is the one that
      would have left a live deal behind, and the 21 October run had to go
      back for it.

### 11 · A copy of your own data

- [ ] A asks for one: `POST /me/exports` → `202` with `status: "PENDING"`.
- [ ] Immediately: `GET /me/exports/:id` → `409` if the worker has not got to
      it yet. That race is the normal case, not a failure.
- [ ] A moment later → `200`, with
      `Content-Disposition: attachment; filename="farhand-export-….json"`.
- [ ] **Read it.** This is the one step whose value is human eyes on the
      output, because every rule in it is a judgment (#89, decision 0023):
      - A's own rows are there in full — the needs, the deal, the messages,
        the reviews they wrote;
      - **B appears only as a display name and the words B sent to A**, with
        no address and no private field;
      - no `passwordHash`, no session or token hash, anywhere in the file;
      - the `notIncluded` section is there and reads as sentences.
- [ ] B asks for A's export by its id → `404`, not `403`.
- [ ] A second request while one is building → `409`.

### 12 · The things only production can show

- [ ] **The caller's address, signing in THROUGH THE SITE.**
      `SELECT "ipAddress", "createdAt" FROM "Session" ORDER BY "createdAt"
      DESC LIMIT 1;` is **your own address** — not Render's, and not Vercel's.
      Get this wrong and every visitor shares one rate-limit bucket
      (`15-architecture.md`).

      This is the step that earned its keep, twice. On 21 October it answered
      `10.195.187.131`, one of Render's balancers — the chain is three hops
      and `src/app.ts` had trusted one since the first deploy (#145). Then
      #152 put the frontend in front of the API and it answered a **Vercel**
      address instead, through three deploys of wrong guesses, until the chain
      was finally read rather than reasoned about (#164, decision 0035).

      Since #145 the API also says so itself: a private address resolved in
      production writes one `error` line naming the chain. Since #164 a second
      line says the vouch did not verify, which is what a rotated
      `PROXY_VOUCH_SECRET` looks like — so Render's logs are worth a look even
      when this tick passes. **pino-http logs the whole header object**, so
      `x-forwarded-for` and its full chain are already printed there; read the
      log before deploying anything to measure it.
- [ ] **And the direct path is still not forgeable.** With no vouch header,
      `curl -H "X-Forwarded-For: 203.0.113.9" https://farhand-api.onrender.com/needs`
      against a by-address limit must count **your** address and not
      `203.0.113.9`. Both halves, or neither has been checked: since #164 the
      vouch is what the API believes, and a vouch nobody signed must buy
      nothing at all. The cheap version of this tick is `x-farhand-caller`
      with a wrong `x-farhand-vouch` — the API ignores it and writes the
      `error` line above.
- [ ] **The rate limiter answers, and the count is in the database.** One
      account gets **ten** wrong passwords in fifteen minutes
      (`RATE_LIMITS.login.perAccount`), so the **eleventh** attempt is the one
      that answers `429`. The body names when to try again, and in Neon
      `SELECT key, count, "expiresAt" FROM "RateLimit" ORDER BY "expiresAt"
      DESC;` shows a row keyed `login-account:…` or `login-ip:…` (#91). The
      per-address budget is twenty, and since #145 it is twenty for **one**
      caller rather than twenty shared by everybody behind the proxy — which
      is the tick above saying the same thing from the other end.
- [ ] **It does not forget.** Since #91 the counters are rows, so a refusal
      survives a restart and the free plan's fifteen-minute sleep. If you
      spend a budget here, waiting for the service to doze no longer clears
      it — delete the row in Neon, or use a different address. Before #91 a
      sleep wiped every counter, and that is worth knowing precisely because
      it used to hide this mistake.
- [ ] **Deleting an account keeps the evidence.** `DELETE /me` as **B**, who
      by now has uploaded the receipts in step 7 and has no running deal.
      Then check in Neon that B's `User` row is `DELETED` with a
      reserved-domain address, B's `Profile` is blanked, and **B's receipts
      are still there** (#66, decision 0016). B rather than a spare account,
      because an account with nothing attached proves nothing about what
      erasure keeps.
- [ ] **The reviews B wrote survive too**, under "Deleted account" — a
      takedown of a person is not a takedown of what the other side was told
      about them.
- [ ] **Error reporting is switched on.** In Render's logs for the current
      deploy, the line reads `Error reporting started` with
      `environment: production` — not `Error reporting is off (no
      SENTRY_DSN)`. That one line is the whole of what this step can honestly
      ask.

      **It used to say "cause an error on purpose and read the report", and
      that was never answerable.** Nothing in this API returns a 500 by
      design: an unknown route is `404`, bad input is `422`, a refused move
      is `409`, and only `5xx` is reported at all (#29). Manufacturing one
      would mean deploying a deliberate fault to production, which is a
      stranger risk than the one it checks. The other half of the old tick —
      that a report carries no token, no password and no API key — is held by
      `tests/security/observability.test.ts`, which runs on every pull
      request instead of once a year by hand.

      `SENTRY_DSN` lives in Render's dashboard and deliberately not in
      `render.yaml` (`14-deployment.md` says why). It was unset until
      22 October, so until then a 5xx on production left one line in Render's
      logs and no trace anywhere else (#148).

### 13 · And then tidy up

- [ ] Delete the smoke-test accounts, or leave them `DELETED` — but write down
      which aliases were used, because a blocked alias is indistinguishable
      from a broken mailer the next time somebody tests.
- [ ] **Delete B's saved searches**, or leave them: either is fine, but know
      which. A standing query on a live database keeps matching, and the next
      person who posts a need will send mail to an alias nobody is reading
      (#90).
- [ ] Clear anything left in `RateLimit` for the addresses you used, if you
      spent a budget deliberately in step 12. The rows expire on their own
      within the hour, and the daily sweep removes them after that.
- [ ] **Put C back to `USER`.** Step 9 makes C a moderator and nothing in the
      walk takes it away:
      `UPDATE "User" SET role = 'USER' WHERE email = '…+smokeC@gmail.com';`
      Of everything the walk leaves behind, a spare moderator nobody remembers
      making is the one that is a security fact rather than clutter.
- [ ] **Close what A left open.** A's needs are public and `OPEN` — the
      sunscreen one, the published draft, and the second need from step 10.
      Cancel or delete them, or the first real visitor browses a shop window
      made of smoke tests.
- [ ] **Log the test sessions out** — `POST /auth/logout` for each one, C's
      above all. A moderator's cookie sitting in a terminal history outlives
      the walk by as long as nobody notices it.
- [ ] Record the date and the commit SHA this was run against, at the bottom of
      this file.

## Runs

| Date | Commit | Who | Result |
|---|---|---|---|
| 2026-10-21 | `1c27134` | Ksenia | 106 passed, 2 failed, 1 skipped. Failed: the proxy hop count (#145), and one `Notification` assertion that was wrong in this document rather than in the code. Skipped: Sentry, not configured on production. Everything else — the queue, the bucket, the signed links, the mail, the matching, the moderation, the export, the erasure — answered as written |
| 2026-10-22 | `2eacff2` | Ksenia | **Three ticks, not the whole walk** (#148). Step 12's hop count: `Session.ipAddress` after a fresh login is the caller's own address, not a `10.x` balancer — #145 confirmed from inside the database, having been confirmed from outside by the rate-limit bucket headers. Step 12's error reporting: `SENTRY_DSN` set, and Render's log reads `Error reporting started`, `environment: production`. Step 10's `Notification` assertion was the document's mistake, corrected on 21 October rather than re-run |

A row here is a whole walk. A re-run after a fix may honestly be two steps
rather than thirteen — say which two in the Result column, because "passed"
meaning "the ones that failed last time" is a different claim from the one
this file's title makes.
