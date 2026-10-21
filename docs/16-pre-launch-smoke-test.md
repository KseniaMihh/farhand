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
| What you need open | Both inboxes, Render's logs, and Neon's SQL editor |
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

## The walk

Tick each one. If a step fails, stop and write down what the answer was: a
failure here is a deployment fact, and the next thing to do is open an issue
for it, not carry on.

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
- [ ] A publishes that draft with `PATCH /needs/:id` and `status: "OPEN"`,
      still with no tick → **`422`**. This is the one the issue was named for:
      saving a draft and publishing it was the way past the whole mechanism.
- [ ] The same PATCH with the tick → `200`.
- [ ] In Neon: `SELECT "prohibitedVersion", "prohibitedAckAt" FROM "Need";` —
      the published ones carry the fingerprint from step 1, and the draft
      carries nulls.
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
- [ ] B uploads a receipt: `POST /deals/:id/receipts/PRODUCT_RECEIPT` → `201`,
      and a **PDF** as well as a photograph, since they take different paths
      (#82).
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
- [ ] **No email arrives**, and in Neon the row says so:
      `SELECT kind, "sentAt", "skippedAt" FROM "Notification"
      ORDER BY "createdAt" DESC LIMIT 5;` — `skippedAt` set, `sentAt` null.
- [ ] Now `WARN` B again as the moderator. **The email arrives anyway**:
      moderation is exempt, and that exemption is the one thing about the
      switch somebody will complain about if it is wrong.
- [ ] B turns it back on → `200`, and the next notification arrives.

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

- [ ] **The proxy hop count.** `SELECT "ipAddress", "createdAt" FROM "Session"
      ORDER BY "createdAt" DESC LIMIT 1;` is **your own address**, not
      Render's. With `trust proxy` wrong, every caller shares one rate-limit
      bucket (`15-architecture.md`).
- [ ] **The rate limiter answers, and the count is in the database.** Six
      wrong passwords in a row for A → `429`, the body names when to try
      again, and in Neon `SELECT key, count, "expiresAt" FROM "RateLimit"
      ORDER BY "expiresAt" DESC;` shows a row keyed `login-account:…` or
      `login-ip:…` (#91).
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
- [ ] **Sentry has the errors and none of the secrets.** Cause one on purpose
      if nothing has failed, and read the report: no token, no password, no
      API key (#29, #119).

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
- [ ] Record the date and the commit SHA this was run against, at the bottom of
      this file.

## Runs

| Date | Commit | Who | Result |
|---|---|---|---|
| — | — | — | Not yet run |
