# Creates the version 1 backlog as GitHub issues.
# Requires GitHub CLI, authenticated, run from the repository root.
# Run seed-labels.ps1 first.
# Safe to read before running: it only creates issues and one milestone.

gh api repos/:owner/:repo/milestones -f title="v1" `
  -f description="Version 1 scope, see docs/08-scope.md" 2>$null

function New-Task($title, $labels, $body) {
  gh issue create --title $title --label $labels --milestone "v1" --body $body
}

# --- Week 1: API skeleton ---
New-Task "Set up Express with strict TypeScript" "area:infra,type:chore" @"
Goal: the API starts, serves a route, and TypeScript is in strict mode.
Context: docs/09-environment.md
Acceptance criteria:
- [ ] tsconfig with strict: true
- [ ] Express 5 app with a layered folder structure (routes / services / db)
- [ ] Dev script with hot reload (tsx watch)
- [ ] ESLint and Prettier configured
"@

New-Task "Validate environment variables at startup with Zod" "area:infra,type:feature" @"
Goal: a missing or malformed variable fails immediately with a clear message.
Acceptance criteria:
- [ ] Zod schema for DATABASE_URL, PORT, NODE_ENV
- [ ] Process exits with a readable error when validation fails
- [ ] Typed config object exported, used everywhere instead of process.env
"@

New-Task "Add GET /health with a database check" "area:infra,type:feature" @"
Goal: one endpoint proves the process runs and PostgreSQL is reachable.
Acceptance criteria:
- [ ] Returns 200 with status and uptime when the database answers
- [ ] Returns 503 when it does not
- [ ] Documented in docs/06-api-contract.md
"@

New-Task "Central error handler and structured logging" "area:infra,type:feature" @"
Goal: every error leaves the API in the shape described in the API contract.
Context: docs/06-api-contract.md
Acceptance criteria:
- [ ] One error middleware producing { error: { code, message, details } }
- [ ] Known errors mapped to correct status codes
- [ ] Unexpected errors logged with a request id, never leaked to the client
- [ ] Structured logger (pino) with request logging
"@

# --- Week 2: Prisma and CI ---
New-Task "Wire the Prisma client with the pg driver adapter" "area:infra,type:chore" @"
Goal: the API can query the database.
Acceptance criteria:
- [ ] Single PrismaClient instance shared across the app
- [ ] Connection closed cleanly on shutdown
- [ ] A smoke query works from a route
"@

New-Task "Seed script for categories" "area:infra,type:feature" @"
Goal: a fresh database has the category list from docs/05-data-model.md.
Acceptance criteria:
- [ ] npm run seed populates categories idempotently
- [ ] Documented in the README
"@

New-Task "Test setup with Vitest and a separate test database" "area:infra,type:test" @"
Goal: tests run against a real database without touching development data.
Context: docs/11-risks.md, test isolation
Acceptance criteria:
- [ ] Second database in docker-compose, or a separate schema
- [ ] Truncation between tests
- [ ] Supertest wired for API-level tests
- [ ] /health covered by a test
"@

New-Task "GitHub Actions workflow: lint, typecheck, test" "area:infra,type:chore" @"
Goal: every push and pull request is verified automatically.
Acceptance criteria:
- [ ] PostgreSQL service container in the workflow
- [ ] Migrations applied before tests
- [ ] Workflow fails on lint, type or test errors
- [ ] Status badge in the README
"@

# --- Week 3: Registration ---
New-Task "POST /auth/register with argon2id password hashing" "area:auth,type:feature" @"
Context: docs/06-api-contract.md, docs/10-decisions/0007-sessions-over-jwt.md
Acceptance criteria:
- [ ] Zod validation of email, password, display name, country
- [ ] Password hashed with argon2id, never stored or logged in plain text
- [ ] User and Profile created in one transaction
- [ ] Identical response whether or not the email already exists
- [ ] Tests: success, duplicate email, weak password, invalid country
"@

New-Task "Email verification tokens" "area:auth,type:feature" @"
Acceptance criteria:
- [ ] Token stored hashed, single use, with an expiry
- [ ] POST /auth/verify-email sets emailVerifiedAt
- [ ] Expired and reused tokens rejected
- [ ] Token written to the log in development instead of sending mail
"@

# --- Week 4: Login and sessions ---
New-Task "POST /auth/login and session cookie" "area:auth,type:feature" @"
Context: docs/10-decisions/0007-sessions-over-jwt.md
Acceptance criteria:
- [ ] Random token, stored hashed in Session, returned as an httpOnly cookie
- [ ] SameSite and Secure set correctly per environment
- [ ] Same error for unknown email and wrong password
- [ ] Blocked and suspended accounts rejected with the right status
"@

New-Task "Auth middleware, /auth/me and logout" "area:auth,type:feature" @"
Acceptance criteria:
- [ ] requireAuth middleware loading the user from the session
- [ ] requireVerified and requireRole variants
- [ ] GET /auth/me returns user and profile, never the password hash
- [ ] POST /auth/logout deletes the session row
"@

New-Task "Password reset flow" "area:auth,type:feature" @"
Acceptance criteria:
- [ ] Forgot and reset endpoints, both responding identically regardless of email existence
- [ ] Reset revokes all sessions for that user
- [ ] Tests cover token expiry and reuse
"@

New-Task "Rate limiting on authentication endpoints" "area:auth,type:feature" @"
Acceptance criteria:
- [ ] Per-IP and per-account limits on login, register and reset
- [ ] 429 with the documented error shape
"@

# --- Week 5: Needs ---
New-Task "Needs: create, edit, delete" "area:needs,type:feature" @"
Context: docs/02-roles-and-permissions.md
Acceptance criteria:
- [ ] Ownership enforced in the service layer, not only in routes
- [ ] Editing allowed only in DRAFT or OPEN
- [ ] Limit on open needs per account
- [ ] Tests for each permission rule
"@

New-Task "Needs: browse with filters and cursor pagination" "area:needs,type:feature" @"
Context: docs/11-risks.md, cursor pagination
Acceptance criteria:
- [ ] Filters: buyCountry, deliverCountry, categoryId, text query
- [ ] Cursor on (createdAt, id) so ties are stable
- [ ] Only OPEN needs visible publicly
- [ ] Test proving no duplicates or gaps when rows are inserted mid-paging
"@

# --- Week 6: Helps ---
New-Task "Helps: create, edit, delete" "area:helps,type:feature" @"
Acceptance criteria:
- [ ] Categories attached as many-to-many
- [ ] shipsTo validated as ISO country codes
- [ ] Ownership enforced
"@

New-Task "Helps: browse with country and category filters" "area:helps,type:feature" @"
Acceptance criteria:
- [ ] Empty shipsTo means anywhere
- [ ] GIN index actually used, verified with EXPLAIN
- [ ] Cursor pagination as for needs
"@

# --- Week 7: Proposals ---
New-Task "Proposals: send, decline, withdraw" "area:messages,type:feature" @"
Acceptance criteria:
- [ ] Cannot propose on your own need
- [ ] One proposal per helper per need, enforced by the unique constraint
- [ ] initiatedBy recorded correctly in both directions
"@

New-Task "Accept a proposal in one transaction" "area:deals,type:feature" @"
Context: docs/11-risks.md, hardest part of the project
Acceptance criteria:
- [ ] Accept, decline others, close the need, create the deal and log the first event, all atomically
- [ ] Test proving nothing is written when a later step fails
- [ ] Partial unique index prevents a second live deal on the same need
"@

# --- Week 8: Messaging ---
New-Task "Conversations and messages" "area:messages,type:feature" @"
Acceptance criteria:
- [ ] Only participants and moderators can read
- [ ] Cursor pagination, oldest to newest within a page
- [ ] Rate limit on sending
"@

New-Task "Unread counts and inbox" "area:messages,type:feature" @"
Context: docs/05-data-model.md
Acceptance criteria:
- [ ] lastReadAt per side, one write per read
- [ ] Inbox sorted by lastMessageAt with unread counts
"@

# --- Week 9: Deals ---
New-Task "Quote submission and acceptance" "area:deals,type:feature" @"
Context: docs/04-deal-lifecycle.md
Acceptance criteria:
- [ ] Helper submits currency, product amount and shipping estimate
- [ ] Requester accepting moves the deal to QUOTE_AGREED and locks the amounts
- [ ] Revisions allowed only while MATCHED, each one logged
"@

New-Task "Deal transition engine" "area:deals,type:feature" @"
Context: docs/04-deal-lifecycle.md and docs/10-decisions/0008-single-transition-endpoint.md
Acceptance criteria:
- [ ] One transition table used by the whole application
- [ ] Actor and precondition checked per transition
- [ ] Every transition writes a DealEvent
- [ ] Test asserting every invalid transition is rejected
- [ ] Transition-specific fields validated per target status
"@

New-Task "Cancellation, dispute and auto-complete" "area:deals,type:feature" @"
Acceptance criteria:
- [ ] Cancellation with a reason, only before SHIPPED
- [ ] Dispute freezes the deal
- [ ] DELIVERED auto-completes after 14 days, logged with a null actor
"@

# --- Week 10: Admin ---
New-Task "Reports: submit and queue" "area:admin,type:feature" @"
Acceptance criteria:
- [ ] Polymorphic target validated in the service layer
- [ ] Moderator queue with filters
"@

New-Task "Moderation actions and audit log" "area:admin,type:feature" @"
Context: docs/02-roles-and-permissions.md
Acceptance criteria:
- [ ] Warn, suspend, ban, reactivate, remove content
- [ ] Reason required, AdminAction written every time
- [ ] Suspended users can read but not act; banned users cannot sign in
- [ ] Moderator conversation access allowed only via a report or dispute, and logged
"@

# --- Week 11: Hardening ---
New-Task "Security hardening pass" "area:infra,type:chore" @"
Acceptance criteria:
- [ ] helmet, CORS configured for the intended frontend origin only
- [ ] CSRF protection for cookie-based requests
- [ ] Global rate limiting
- [ ] No stack traces or internal identifiers in production responses
"@

New-Task "Error tracking and request logging in production" "area:infra,type:chore" @"
Acceptance criteria:
- [ ] Sentry or equivalent wired, with environment separation
- [ ] Request id propagated into logs and error reports
"@

# --- Week 12: Ship ---
New-Task "Dockerfile for the API with a multi-stage build" "area:infra,type:chore" @"
Acceptance criteria:
- [ ] Multi-stage build, non-root user, small final image
- [ ] docker compose runs the API and the database together
- [ ] Migrations run on startup or as a separate step, decided and documented
"@

New-Task "Deploy the API to a cloud environment" "area:infra,type:chore" @"
Acceptance criteria:
- [ ] Managed PostgreSQL provisioned
- [ ] Secrets set in the platform, never in the repository
- [ ] CI deploys on merge to main
- [ ] Health endpoint monitored, and the public URL in the README
"@

Write-Host "Backlog created. Open the Project board and assign issues to weekly iterations."
