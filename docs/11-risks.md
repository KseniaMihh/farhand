# Risks, hard parts and likely stuck moments

Written in advance so that hitting one of these feels expected rather than like
failure.

## Technical parts that are genuinely hard

| Part | Why it is hard | Approach |
|---|---|---|
| Accepting a proposal | Five changes must happen together or not at all | One database transaction; a test that asserts nothing is written when a step fails |
| The transition rules | Easy to scatter across many endpoints | One transition table in one module; every endpoint routes through it |
| Sessions and cookies | `httpOnly`, `SameSite`, `Secure` and CORS interact confusingly, and fail differently in production | Get it working locally, then write the deployment behaviour down before deploying |
| Cursor pagination | Ties break, and rows shift while paging | Sort by `(createdAt, id)` and use both in the cursor |
| Test isolation | Tests that share data pass alone and fail together | A separate test database, truncated between tests |
| Time zones | Comparing local time to database time silently misbehaves | Store UTC everywhere; convert only for display |
| Reading generated migrations | Prisma does not know about hand-written indexes and may drop them | Always read `migration.sql` before applying |

## Likely stuck moments

| Symptom | Usual cause |
|---|---|
| "Cannot connect to the database" | Docker Desktop is closed, or the container is stopped |
| A command is "not recognised" | The terminal was open before the tool was installed |
| Prisma complains about drift | The database was changed outside a migration, or a migration file was edited after being applied |
| `npm audit fix --force` breaks things | It accepts breaking changes, including downgrades |
| Types disagree after a schema change | `prisma generate` has not been run |
| Everything worked yesterday | A container was removed with `-v`, deleting the volume |
| Every test file fails with `(0 test)` | Windows Smart App Control has blocked a native module — see [The flake, solved](#the-flake-solved). `node -e "require('@node-rs/argon2')"` says so plainly |

## The flake, solved

Twice during version 1 a full run reported a failed test **file** while every
test in it passed on its own, and the next run was clean — once during #21,
once during #29, never the same file twice. #70 caught it in the act.

### What it was

**Windows Smart App Control blocking a native module.** The password library
`@node-rs/argon2` ships a compiled `.node` binary, and Windows decided one
afternoon to stop letting it load:

```
ERR_DLOPEN_FAILED: An Application Control policy has blocked this file.
argon2.win32-x64-msvc.node
```

`src/password.ts` imports it, and nearly every test file reaches that import
through the app — so thirty-one of thirty-three files failed *to load*, with no
test in them failing, because none of them ran.

It was caught by running the suite fifty times in a row: twenty-one clean runs,
then run 22 broke at 21:20:37 and every run after it failed identically. The
Windows Code Integrity event log has a block for that exact file at 21:20:37,
and Smart App Control is enforcing (`VerifiedAndReputablePolicyState = 1`). The
file itself was untouched, the same 610,816 bytes it had been for a week.
Windows simply changed its mind about it.

That explains every part of the symptom:

| The symptom | Why |
|---|---|
| A *file* failed, not a test | The import failed, so nothing in the file ran |
| Every test in it passed alone | Run at another moment, the policy allowed the load |
| Never the same file twice | Whichever files import the password module, and when the block lands |
| Never reproducible on demand | It is an operating system reputation decision, not a race in our code |
| Only ever on the laptop | CI runs on Ubuntu, where Smart App Control does not exist |

### What was done

`@node-rs/argon2-wasm32-wasi` is now a dependency. The library already looks
for a WebAssembly build when the native one will not load — the failure message
named it — and that package simply was not installed. With it, a blocked
binding costs speed instead of stopping everything, on any machine.

**It is slower when it falls back**: the suite takes about 160 seconds on
WebAssembly against about 120 on the native binding, because password hashing
is most of what the auth tests do. That is the whole cost, it only applies when
the native binding is unavailable, and 277 KB is a cheap way for the API not to
crash at boot if a binding ever fails to load in production.

The image library added in #80, `sharp`, is the second native module and has
the same escape: `@img/sharp-wasm32` comes installed with it, on every
platform, and is what it loads when its native binding cannot be.

Smart App Control itself was left alone. Turning it off is a one-way door —
it cannot be re-enabled without reinstalling Windows — and the fallback makes
that a decision somebody can take calmly rather than one forced by a broken
suite.

### Ruled out along the way

The three things this was expected to be were all wrong, which is the reason
for writing them down:

- **Cross-file state and the in-memory rate limiter.** Would show as failing
  tests, not files that never ran.
- **Connection exhaustion.** Each test file re-imports `src/db.ts` and builds
  its own `PrismaClient` and pool — about thirty per run against a server
  allowing 100 connections, which is what that file's own comment warns about.
  Sampling `pg_stat_activity` throughout a run found never more than **two**
  open connections: pools open connections lazily and the suite is sequential.
  Worth re-checking if files ever run in parallel.
- **A worker thread per test file.** `src/logger.ts` used pino's `transport`
  option outside production, and a transport is not a formatting setting: it
  starts a worker thread. Under test it bought nothing, because `LOG_LEVEL` is
  `silent` — a worker started, handed nothing, torn down, once per file. It was
  a plausible cause and it was **not** the cause. It was removed anyway,
  because it was pure cost; the pretty printing is still there in development,
  where it earns the worker.

### Rule this out first, always

Whatever the next strange failure is, check that only one thing is running
against the test database. The suite truncates every table before every test,
so **any second runner invalidates a run** — a watch process left open in the
editor, a second terminal, a script. One truncates rows the other has just
written, and it looks like ordinary assertion failures in unrelated places.

This happened twice while #65–#67 were being built, once from
`npm run test:watch` left running in IntelliJ and once from a script of our
own:

```powershell
Get-CimInstance Win32_Process -Filter "Name like '%node%'"
```

`vitest.config.ts` pins the suite to one worker, which makes files safe from
*each other* and says nothing about a second run. Scripts that rewrite source
files while they run now use a separate worktree with its own database.

### The one that was not a flake: the store filled up (#109)

The database is truncated before every test. The **object store never was**,
so from #79 until #109 every file test the project ran left its bytes in the
bucket. Nobody notices, because `docker compose stop` keeps them and `down`
silently throws them away — the count only goes up, and only on a machine
that has been running the suite for a while.

| | |
|---|---|
| Objects in `farhand-test`, 2026-10-08 | 3,364 |
| The next morning, after a day's work | **5,230** |
| Added by one full suite run | ~460 |
| Listing the bucket at 5,690 objects | **563 ms** |
| Listing it empty | **3 ms** |

What made that a problem rather than untidiness: a test helper called
`allKeys()` paged the whole bucket to assert "the set of keys did not
change". So those tests cost more every time anybody ran the suite — and in
the scratch worktree, at **14,489** objects, five of them crossed Vitest's
five-second limit and failed.

**Corrected on 2026-10-09**, by counting rather than reading: this section
first said "four tests called it twice each". Those are four call *sites*,
and they sit inside two helpers that seventeen tests use between them. The
real figure is **34 listings per suite run** — counted by making the
function announce itself. The listing is also superlinear: 563 ms at 5,690
objects, **2,134 ms at 11,480**.

That did not look like a store problem. It looked like a mutation-testing
run in which every deliberately broken variant was caught, including the
**control variant that changes nothing and must survive**. That is the only
reason the run was thrown away instead of believed.

**A test whose cost grows with every past run is a time bomb**, and resetting
the timer is not defusing it. So #109 did both halves:

- `tests/setup/global-setup.ts` empties the bucket before the suite and again
  after it, so a run starts clean and leaves the store as it found it. Since
  #111 that covers both buckets, and `npm run test:store-empty` counts both —
  a second store nobody empties would be the first store's problem again.
- `allKeys()` is no longer exported. The tests that listed everything
  now name the key they care about — which is **stronger**, not merely
  cheaper: a listing that matches also passes when the cleanup deleted the
  wrong object and something else appeared.

The wiring is held by a test, and the test is kept honest by a trick worth
knowing. `global-setup.ts` writes one object *before* emptying, and the test
asserts the count afterwards is zero. Without that object the test would pass
on any machine whose store was already empty — a fresh clone, every CI run —
whether or not the setup did anything at all.

**This is not the five-second stall (#110).** The growth looked like the
obvious explanation and the measurement said otherwise: against 5,230 real
objects a single keyed fetch is 93 ms cold and 3–6 ms warm.

#### What it actually costs, measured properly

When this was written the evidence was one run with a full store (172 s) and
one with an empty one (148 s), and it was recorded as proving nothing on its
own — correctly, at one run each. #110's experiment then ran the suite
twenty times and settled it:

| | Runs | Objects | Time |
|---|---|---|---|
| Full store | 10 | 6,000 → 10,140 | **174 → 204 s**, rising with every run |
| Empty store | 10 | 0 | **142–146 s** |

The slowest empty run is 28 s faster than the quickest full one; the two do
not overlap. And the real variance on identical code is **±2 s**, not the
wide spread that one-run-each comparison suggested.

One more run isolated the cause rather than inferring it. With the store
still holding 10,100 objects but `allKeys()` stubbed to return nothing, the
suite took **145 s** — the empty-store time. So the listing is the whole
cost, and nothing else about a full store is slow. A separate check agrees:
writing an object takes 1.5 ms into a store of 460 and 1.2 ms into one of
10,000, so the backend does not degrade with directory size the way it was
tempting to assume.

### Getting a full store back on purpose

Emptying the store every run also means the state #110 was last seen in can
no longer happen by accident. So it has to be reachable deliberately:

```bash
npm run store:fill -- 6000                    # ~20 s, from master
git worktree add --detach ../wt 2119c1b       # the commit before #109
cd ../wt/farhand-api && npm test              # nothing empties anything here
```

**There is no flag that turns the cleanup off.** There was one for an
afternoon, and it was removed before it shipped: a switch that disables a
safety fix would live in the repository for ever for the sake of one
investigation, and the investigation does not need it. The commit before
#109 already behaves the old way, and the fill is just objects in a bucket —
it does not care which commit the suite comes from.

**That hazard is gone as of #111**, and the history is worth keeping because
it is why the fix exists. The tests that prove the emptying works used to
empty a store you had just filled — that is what they are testing, and they
ran against the same bucket as everything else. The first attempt at the
paragraph above seeded 6,000 objects and found 434 at the end of the run.

They now use a second bucket of their own, `CLEANUP_STORE`, derived from the
configured one by name: `farhand-test` becomes `farhand-cleanup-test`. So a
filled store survives a run on **any** commit, and the recipe above no
longer depends on checking out an old one — that is only still there
because the pre-#109 commit is also where nothing empties the store at all.

The guard came with it. `assertTestStore` now judges **the bucket it is
handed** rather than the configured one. With two buckets in play, a guard
reading `env.STORAGE_BUCKET` would approve a perfectly good configured name
and then delete from whatever it was actually given — a worse version of the
bug the guard exists to prevent, and one that would have passed every test
written for #109. Two tests pin it from both sides: a bad bucket is refused
while the settings are good, and a good bucket is **not** refused while the
settings are bad.

## The five-second stall was a timeout, and #109 had already fixed it (#110)

#80 ended with a line in the build log:

> **Still open:** a test that occasionally stalls for five seconds on its
> first download, seen twice in four full runs, cause not yet found. Written
> up as its own issue rather than hidden behind a longer timeout.

The instinct was right and **the issue did not exist** — not open, not
closed, nothing here, searched by number, title and keyword. That is worth
more attention than the stall. #69 built a test that fails when the API
contract and the code disagree, because version 1 was called finished with
five documented endpoints nobody had built. The build log has no such test,
so a sentence in it claiming work was filed is believed by everybody,
including whoever wrote it. The same failure one level up: not the code
going missing, the record of the gap going missing.

### What was known going in

| | |
|---|---|
| Frequency | **2 sightings in 4 full runs**, during #80 |
| Never seen | In a single-file run — only in a whole suite |
| Where | `download()` in `tests/profiles/avatar.test.ts`: ask the API, follow the redirect, fetch the bytes |
| Ruled out then | IPv6 resolution, idle connections |

Nothing recorded *which part* was slow, which is why #80's three rounds of
theories stayed theories.

### Three hypotheses that died before the experiment ran

| | How |
|---|---|
| **A stale kept-alive connection** | The best fit for the symptom — "first download in a file", "full suite only", "about five seconds" — and wrong. A fetch, 35 s idle, another: **10 ms**. After 65 s idle: **6 ms**. The reason it cannot happen is that undici drops idle connections after about 4 s, long before the server would. #80 was right |
| **WSL2 filesystem slowness** | `docker inspect farhand-storage` shows **no mounts at all**. The objects live in the container's own writable layer, never on a Windows path |
| **The store filling up** | 93 ms cold and 3–6 ms warm for one keyed fetch against 5,230 objects. It costs time (above), but not in a way that stalls |

### What was built before guessing again

**`download()` times itself in three parts** and prints any step over a
second with all three numbers. The split is where the parts fail for
different reasons: `redirect` is our API — session, visibility rule, and
signing, all local, so a slow redirect means the database or the app and
never the store; `fetch` is the request to S3Proxy, resolving at its
headers; `body` is reading the bytes.

**The store's garbage collection is logged** —
`JAVA_TOOL_OPTIONS: -Xlog:gc` in `docker-compose.yml`. S3Proxy is a Java
program with a heap of up to 75% of this machine's memory, and a
multi-second pause looks exactly like a request that hung. Nothing logged
them, so the idea could not be examined at all. Normal pauses are 8–16 ms.

### The result

Twenty full suite runs at `2119c1b`, the commit before #109, where nothing
empties the store: ten with the store filled, ten with it empty.

| | Failures | Slow downloads | Time |
|---|---|---|---|
| Full store | **2 of 10** | 0 | 165–230 s |
| Empty store | **0 of 10** | 0 | 141–150 s |

**Not one slow download, with instrumentation proven to catch one.** But two
runs failed, both with a full store, in tests scattered across unrelated
files — including `deals/events.test.ts`, which touches no files at all. The
rate, 2 in 10, is in the same neighbourhood as #80's 2 in 4.

A captured failure says what the earlier rounds of this never knew:

```
FAIL  tests/files/account-deletion.test.ts > deleting an account
        > deletes its photos: the rows and the bytes
Error: Test timed out in 5000ms.
```

### It is not a stall. It is a timeout with no headroom

Two measurements finish it.

**Every per-key operation is flat**, whatever the store holds. Only listing
grows:

| | 0 objects | ~9,000 objects |
|---|---|---|
| `HeadObject` | 1.12 ms | 0.91 ms |
| `DeleteObject` | 1.04 ms | 0.93 ms |
| `PutObject` | 1.53 ms | 1.19 ms |
| **A full listing** | **3 ms** | **~1,700 ms** |

**And the suite runs a cluster of tests close to the limit already.** On an
empty store the slowest are 2.9–3.1 s against Vitest's 5 s — under two
seconds of room. They are the ones that hash passwords with argon2 and
re-encode images, which are slow on purpose.

Put those together. `when it is not an image` takes 2,985 ms on an empty
store and is one of the tests that failed in **both** failing runs. It uses a
helper that lists the whole store **twice**:

```
3.0 s  the test itself
3.4 s  two listings at ~1.7 s each, with 9,000 objects in the store
-----
6.4 s  against a 5 s limit
```

That is the whole phenomenon. It looked random because which test tips over
depends on what the machine is doing; it only happened in whole-suite runs
because a single file never accumulated enough objects; and it moved between
files because several tests sit at the same height. #80 saw it surface at a
download and reasonably assumed the download had stalled. The download was
never slow — it was simply in a test that ran out of time.

### So it is already fixed, and that is not luck

#109 emptied the store before every run and stopped the tests listing it.
Both halves remove the seconds that caused this, which is why the empty arm
above failed 0 times in 10 and why every run on `master` since has been
clean. The fix landed before the diagnosis, aimed at a cost rather than a
crash — the crash was the same cost, further along.

**What is left is the headroom.** Under two seconds on the slowest tests is
thin, and the next slow thing anybody adds will do this again somewhere else.
That is a standing hazard rather than a bug, and it is recorded here because
the lesson of #80 is what happens when it is not.

What nobody should do is raise the timeout. #80 refused to and was right, and
now there is a reason rather than an instinct: the limit is the only thing
that made this visible at all. Raising it would have turned a failing test
into a suite that was quietly, unaccountably slower every month.

The instrumentation stays. It earned its place by being proved — a deliberate
delay in each of the three steps, each reported as itself — and then by
ruling the download out, which is what sent the investigation to the right
place.

## A page made of images still costs one request per image

Raised while mapping the file box for #100, and **mostly settled by #102**.
What is left is written here with what it would take to finish it, because
the part that remains cannot be built until there is a list response to put
it in.

### What #102 measured, and what it changed

The note this section replaces got two things wrong, both found by running
the thing rather than reading it (`tests/files/cost.test.ts`):

| Claimed | Measured |
|---|---|
| One database query per image | **Four.** `include` of three relations is three extra sequential SELECTs, and a file is an avatar *or* a need photo *or* a receipt — never two, so three of the four were for rows the rule would not read |
| The signed URL differs on every request | Only across a **second**. SigV4 presigns at one-second granularity, so two requests in the same second get a byte-identical URL |

And one thing it got right, which measurement turned from a projection into
an observation: with `/files/:id` inside the global 300-a-minute ceiling,
**the tenth view of a thirty-photo page answered `429`** — on the visitor's
own photos.

#102 fixed the two halves that did not need a caller to exist yet:

| | Before | After |
|---|---|---|
| Statements per image | 4 | 2 — the row, then the one relation that decides it |
| Statements, 30-image page | 120 | 60 |
| Budget it spends | the global one, 10% per page view | its own, `RATE_LIMITS.file`, 600 a minute |
| Page views before a `429` | 10 | not reachable by looking at images |
| Repeat view of the same image | a request | none, for `REDIRECT_CACHE_SECONDS` |

### What is left, and why it waits

**A page of N images is still N requests to the API and N to B2.** The
second N is the bytes and is not going anywhere. The first N is removable,
and only one thing removes it: **signing the URLs inside the list response**
so a browse page arrives with its links already in it. Signing is local
arithmetic, so thirty of them cost nothing.

That is not built, because **no list response carries an image today** —
`avatarUrl` is returned by the three profile endpoints and nowhere else, so
it would be built for a caller that does not exist. The issue that creates
the caller is the issue that should build it: **#81** puts photos on a need,
**#93** builds the page that lists them, and either one is where this
belongs. What they have to decide is in
`docs/10-decisions/0012-one-request-per-image.md`.

Two limits are still the ones to watch when it happens:

- **`RATE_LIMITS.file`**, 600 a minute per address. Twenty thirty-image page
  views a minute, which no person reaches — but it is a ceiling, and a list
  endpoint that embeds its URLs makes it irrelevant rather than tighter.
- **B2's free egress**, three times what is stored, with the spending cap at
  `$0` (decision 0011). Images stop being served rather than start costing
  money. Nothing in #102 changes this: the bytes are fetched either way.

## One click in a confirmation email can lock somebody out for good (#121)

Found by looking at the first real email the live site ever sent (#119), and
**deliberately not fixed** — the reasons are below, and so is the trigger that
should make somebody fix it.

Gmail shows an **unsubscribe** button beside the sender of our confirmation
email, because Brevo attaches a `List-Unsubscribe` header to everything it
sends. Clicking it blocklists that address **for our sender**, and in a product
whose only email is authentication, "unsubscribe" therefore means:

| What they lose | Why it is permanent |
|---|---|
| The confirmation code | `requireVerified` guards 41 routes: an unconfirmed account can read and nothing else |
| Every password reset, afterwards | Same blocklist, same sender |
| Any way to notice | `POST /auth/register` and `/auth/forgot-password` answer identically whatever happens — #9's rule against enumeration, working exactly as designed |

### What the research settled

| Question | Answer |
|---|---|
| Can Brevo be told not to attach it? | **No.** Its help centre says the header is added automatically to campaigns *and* transactional mail; replacing it with `List-Help` is **Enterprise-only**, under conditions that describe our case exactly (recipient-triggered, no promotional content) |
| Would our own domain remove it? | **No.** Nothing ties the header to sender authentication. A domain fixes the rewritten sender and the spam risk, not this |
| Do the alternatives behave differently? | **Yes.** Resend does not manage lists for transactional mail at all — the header is yours to add if you want one. SendGrid has explicit `bypass_unsubscribe_management`. **Both need a verified domain**, which is what ruled them out in #119 |
| Can we tell that an address is blocked? | Brevo exposes `GET /v3/smtp/blockedContacts` and shows a `blocked` status in its own log. Whether a send to a blocked address *fails* or quietly succeeds is **untested** — see below |

### The untested half

Brevo documents "Blocked" as a **delivery status** rather than a send error,
which suggests the API call succeeds and the message is simply never delivered
— meaning `src/mailer.ts`'s failure path never fires, and nothing reaches the
log or Sentry. That is an inference, not an observation. The experiment that
would settle it, kept here so it does not have to be re-derived:

1. register a throwaway alias on the live site, which sends the first email;
2. click **unsubscribe** in that message on purpose;
3. call `POST /auth/resend-verification` for the same address;
4. read both logs — Render's for `Email sent` against `Could not send email`,
   Brevo's for whether a second message exists and with what status.

`Could not send email` would mean the failure is loud and support could notice.
Anything else means it is silent, and the risk below is the worse version.

### Why it is not being fixed now

The fix is **a domain plus a provider that distinguishes transactional mail**,
and a domain is bought when there is a frontend to put on it (#93). Buying one
now would break the rule that nothing here costs money, to solve a problem that
cannot yet affect anybody: there are no users, and the only addresses in the
production database are the author's own test aliases.

### The trigger

**Before the first real person who is not the author registers.** In practice
that is #93 going live, which is also when the domain appears — so the work is:
authenticate the domain, move to Resend (or SendGrid), and send transactional
mail with no unsubscribe header. Decision
`10-decisions/0015-living-with-a-transactional-unsubscribe.md` holds the
reasoning; `14-deployment.md` holds what to do if somebody is blocked in the
meantime.

### #86 made this more likely, and bought what it could

Notification email (#86) multiplies the number of messages a person receives,
and therefore the number of chances to click the button that locks them out.
Nothing about the hazard changed; the exposure did.

What #86 did about it, short of the domain:

- **The opt-out is inside Farhand** — `PATCH /me/notifications` — and there is
  **no unsubscribe link of our own** in any notification. Every one of them
  ends with a line pointing at the setting instead. A person who wants the
  email to stop has a button that does not endanger their account, which is
  the most that can be done without a second sending domain.
- **That endpoint is `SESSION`, not `AUTH`**, so an unverified or suspended
  account can still turn email off. Requiring a confirmed address before
  somebody may ask us to stop emailing them is the rule that would push people
  towards the provider's button.
- **The list is short on purpose** (decision 0020): email only when the
  recipient must act. Volume is the thing that turns a tolerated sender into an
  unsubscribed one, and messages — the chattiest candidate — are deliberately
  silent.

What it did **not** do: it cannot stop Gmail or Brevo showing their own
unsubscribe affordance. The trigger above is unchanged, and this is now a
second reason to act on it.

## Product and legal risks

| Risk | Severity | Position taken |
|---|---|---|
| Facilitating shipments to sanctioned jurisdictions | High | Country allowlist in configuration; documented, not silently ignored |
| Prohibited or illegal items | High | Published list, acknowledgement at posting, reports; no automated detection in V1 |
| Being treated as a payment intermediary | High | Farhand never touches money in V1; this is a design constraint, not an oversight |
| Customs and VAT disputes between users | Medium | Stated clearly; Farhand never suggests a declared value |
| Personal data in messages | Medium | Addresses exchanged in chat; recorded as an open privacy question |
| Users under 18 | Medium | Confirmation only in V1 |
| Reputational harm from a scam on the platform | Medium | Honest limitations shown before payment steps |

## Project risks

| Risk | Mitigation |
|---|---|
| Scope creep | `08-scope.md`, and the rule that version 1 does not grow |
| Drifting back to frontend work, where it is comfortable | Frontend starts only after the deal lifecycle is done |
| Losing momentum after the exciting part | Small, finishable steps; commit daily; the CI badge is visible |
| Documentation going stale | The schema is authoritative; a doc that contradicts it gets fixed in the same commit. For the endpoint tables in `06-api-contract.md` this is no longer a promise: `tests/contract/endpoints.test.ts` fails if they and the routes disagree (#69). It happened — version 1 was called finished with five endpoints documented and never built |
| Over-relying on AI-generated code | Core logic in steps 1–3 is written by hand first, reviewed afterwards |
| A banned person cannot ask for their data to be erased | `DELETE /me` needs a session, and a ban stops sign-in, so the one group most likely to want erasure cannot reach it. Version 1 has no support inbox to ask through. The fix is a moderator-side deletion or a real contact route, and both are version 2 (#66) |

## Open questions

1. Should delivery addresses be stored as structured data rather than passed in
   messages? Better privacy control, more data to protect.
2. Should the thank-you amount be offered on the need, tipped after delivery, or
   both? Currently: on the need only.
3. Should needs expire automatically, and after how long?
4. Should a helper be able to propose on a need outside their advertised
   countries? Currently allowed.
5. Interface language beyond English, and whether that affects the data model.
