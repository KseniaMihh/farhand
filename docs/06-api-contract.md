# API contract — version 1

REST over JSON. Cookie-based sessions. All money in integer cents.
`AUTH` means a signed-in, active, email-confirmed user.

## Conventions

- Success: `200`, `201` for creation, `204` for no content.
- Client error: `400` malformed request, `401` not signed in, `403` signed in
  but not allowed, `404` not found or not visible to you, `409` conflict with
  current state, `413` body too large, `422` validation failed, `429` rate
  limited.
- `400` and `422` are different failures. `400` means the request itself could
  not be read — unparseable JSON. `422` means it was read perfectly and the
  content was wrong: a missing field, a password too short, a country code that
  is not two letters. Only `422` can name the offending fields, which is why
  they are worth separating.
- Errors share one shape: `{ "error": { "code": "...", "message": "...", "details": [...] } }`.
- Never reveal existence through status codes: a need you may not see returns
  `404`, not `403`.
- Lists are cursor-paginated: `?cursor=<id>&limit=20`, returning
  `{ items: [...], nextCursor: string | null }`.

## Health

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/health` | — | Liveness: the process is up. Checks nothing else |
| GET | `/health/ready` | — | Readiness: the database answers a round-trip query |

Two endpoints because they drive different decisions. A platform restarts a
process whose liveness check fails, and restarting will not fix a database that
is down, so liveness must not depend on it. Readiness failing only means "send
traffic elsewhere for now".

`GET /health` always returns `200`:

```json
{ "status": "ok", "uptime": 1234 }
```

`uptime` is whole seconds since the process started.

`GET /health/ready` returns `200` when the database answers:

```json
{ "status": "ok", "database": { "status": "ok", "latencyMs": 3 } }
```

and `503` when it does not:

```json
{ "status": "degraded", "database": { "status": "unreachable" } }
```

Outside production the `503` body also carries `database.message`, the driver's
error text. In production that text is logged but never returned, because it can
contain the host and user name. These bodies are not the shared error shape: a
failing dependency is a normal answer from this endpoint, not an error.

## Authentication

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/auth/register` | — | Email, password, display name, country. Always responds the same whether or not the email exists |
| POST | `/auth/verify-email` | — | Token from the email |
| POST | `/auth/login` | — | Sets an httpOnly session cookie. Rate limited |
| POST | `/auth/logout` | AUTH | Deletes the session |
| GET | `/auth/me` | AUTH | Current user and profile |
| POST | `/auth/forgot-password` | — | Always responds identically |
| POST | `/auth/reset-password` | — | Token plus new password; revokes all sessions |

### `POST /auth/register`

```json
{
  "email": "anna@example.com",
  "password": "a decent long passphrase",
  "displayName": "Anna",
  "countryCode": "EE"
}
```

| Field | Rule |
|---|---|
| `email` | Trimmed and lowercased, then validated as an email. `" Anna@Example.COM "` is stored as `anna@example.com` |
| `password` | 8–72 characters. Not trimmed. No composition rules |
| `displayName` | 1–50 characters after trimming |
| `countryCode` | Two letters, ISO 3166-1 alpha-2, uppercased. `"ee"` becomes `"EE"`; `"12"` is rejected |

Unknown fields are dropped, so a request cannot set `role` or `status`.

Returns `201`:

```json
{ "message": "Check your email to verify your account." }
```

**The same `201` and the same body when the email is already registered.** No
second account is created and the existing one is untouched. Answering "that
email is taken" would let anyone discover who uses Farhand; the owner of the
address can still log in or reset their password. The password is hashed on
this path too, so the two cases take roughly the same time.

A body that fails the rules above returns `422` with `details` naming each
field. The new account is unverified — `emailVerifiedAt` stays null until the
address is confirmed with `POST /auth/verify-email`. A new account is emailed
a verification token; a repeat registration is not.

### `POST /auth/verify-email`

```json
{ "token": "the token from the verification email" }
```

Returns `200`:

```json
{ "message": "Email verified." }
```

Sets `emailVerifiedAt` and uses up the token. An address that was already
verified keeps its original timestamp.

Returns `422` with the same body for every token that cannot be used: unknown,
already used, expired, or of the wrong kind (a password-reset token). Telling
"used" apart from "never existed" would help nobody who legitimately holds the
link.

Tokens are single use, even when two requests with the same token arrive at the
same moment (a double-click). They expire 24 hours after registration.

The raw token exists only in the email. The database stores its SHA-256 hash,
so a leaked database contains no working links. In development there is no mail
provider: the token is written to the server log instead.

## Profile

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/users/:id` | — | Public profile plus review summary |
| PATCH | `/me/profile` | AUTH | Own profile only |
| DELETE | `/me` | AUTH | Anonymise and mark deleted |

## Needs

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/needs` | — | Filters: `buyCountry`, `deliverCountry`, `categoryId`, `q`. Only `OPEN` |
| GET | `/needs/:id` | — | Public |
| POST | `/needs` | AUTH | Limited to N open needs per account |
| PATCH | `/needs/:id` | AUTH | Owner only, `DRAFT` or `OPEN` only |
| DELETE | `/needs/:id` | AUTH | Owner only, no live deal |
| GET | `/me/needs` | AUTH | Includes non-public statuses |

## Helps

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/helps` | — | Filters: `country`, `shipsTo`, `categoryId` |
| GET | `/helps/:id` | — | Public |
| POST | `/helps` | AUTH | |
| PATCH | `/helps/:id` | AUTH | Owner only |
| DELETE | `/helps/:id` | AUTH | Owner only |

## Proposals

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/needs/:id/proposals` | AUTH | Not your own need; one per helper per need |
| GET | `/me/proposals` | AUTH | Both sent and received |
| POST | `/proposals/:id/accept` | AUTH | Requester only. Transaction: accept this, decline the rest, close the need, create the deal, log the first event |
| POST | `/proposals/:id/decline` | AUTH | Requester only |
| POST | `/proposals/:id/withdraw` | AUTH | Helper only |

## Messages

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/conversations` | AUTH | Inbox, newest first, with unread counts |
| GET | `/conversations/:id/messages` | AUTH | Participants only, paginated |
| POST | `/conversations/:id/messages` | AUTH | Rate limited |
| POST | `/conversations/:id/read` | AUTH | Updates the reader's timestamp |

## Deals

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/me/deals` | AUTH | Filter by status |
| GET | `/deals/:id` | AUTH | Participants and moderators only |
| POST | `/deals/:id/quote` | AUTH | Helper submits amounts and currency |
| POST | `/deals/:id/transition` | AUTH | Body: `{ to, note?, trackingNumber?, shippingActual? }`. Validated against the transition table |
| GET | `/deals/:id/events` | AUTH | Full history |

One transition endpoint rather than one endpoint per status keeps the rules in a
single place. The alternative is recorded in the decisions folder.

## Reports and moderation

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/reports` | AUTH | Target type and id, reason, details |
| GET | `/admin/reports` | MOD | Queue, filter by status |
| POST | `/admin/reports/:id/resolve` | MOD | Resolution note required |
| GET | `/admin/users` | MOD | Search |
| POST | `/admin/users/:id/actions` | MOD | Warn, suspend, ban, reactivate; reason required |
| POST | `/admin/content/:type/:id/remove` | MOD | Hide a need, help or message |

## Not in version 1

Uploads, reviews, notifications, saved searches, real-time messaging. See
`08-scope.md`.
