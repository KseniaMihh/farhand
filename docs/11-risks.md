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
