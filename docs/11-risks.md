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

## Open questions

1. Should delivery addresses be stored as structured data rather than passed in
   messages? Better privacy control, more data to protect.
2. Should the thank-you amount be offered on the need, tipped after delivery, or
   both? Currently: on the need only.
3. Should needs expire automatically, and after how long?
4. Should a helper be able to propose on a need outside their advertised
   countries? Currently allowed.
5. Interface language beyond English, and whether that affects the data model.
