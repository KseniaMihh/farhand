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
`allKeys()` paged the whole bucket, and four tests called it **twice each**
to assert "the set of keys did not change". So those tests cost more every
time anybody ran the suite — and in the scratch worktree, at **14,489**
objects, five of them crossed Vitest's five-second limit and failed.

That did not look like a store problem. It looked like a mutation-testing
run in which every deliberately broken variant was caught, including the
**control variant that changes nothing and must survive**. That is the only
reason the run was thrown away instead of believed.

**A test whose cost grows with every past run is a time bomb**, and resetting
the timer is not defusing it. So #109 did both halves:

- `tests/setup/global-setup.ts` empties the bucket before the suite and again
  after it, so a run starts clean and leaves the store as it found it.
- `allKeys()` is no longer exported. The four tests that listed everything
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
objects a single keyed fetch is 93 ms cold and 3–6 ms warm, and a full suite
against a full bucket passed with no stall — one run each, 172 s full and
148 s empty, which is inside the ordinary spread of this suite and so proves
nothing on its own.

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

What that afternoon did establish is worth keeping: the tests that prove the
emptying works will empty a store you have just filled, because that is what
they are testing. The first attempt seeded 6,000 objects and found 434 at
the end of the run. Running from before #109 avoids that too, since those
tests do not exist there.

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
