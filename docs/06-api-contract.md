# API contract — version 1

REST over JSON. Cookie-based sessions. All money in integer cents.

Who may call an endpoint, and the middleware in `src/middleware/auth.ts` that
enforces it:

| Marker | Who | Middleware |
|---|---|---|
| — | Anyone | none |
| `SESSION` | Any signed-in user whose account is not banned or deleted — unverified and suspended users included | `requireAuth` |
| `AUTH` | A signed-in user with a confirmed email who is not suspended | `requireAuth`, `requireVerified`, `requireActive` |
| `MOD` | A moderator or an admin | `requireAuth`, `requireRole("MODERATOR")` |

A suspended user can still see their own deals
(`docs/02-roles-and-permissions.md`), so read-only endpoints like that are marked
`SESSION` as they are built.

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
| POST | `/auth/resend-verification` | — | A new verification link. Always responds identically |
| POST | `/auth/login` | — | Sets an httpOnly session cookie. Rate limited (#14) |
| POST | `/auth/logout` | SESSION | Deletes this device's session |
| GET | `/auth/me` | SESSION | Current user and profile |
| POST | `/auth/forgot-password` | — | Emails a one-hour reset link. Always responds identically |
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
same moment (a double-click). They expire 24 hours after they are sent. Asking for a new link with
`POST /auth/resend-verification` retires every older one, so only the newest
works.

The raw token exists only in the email. The database stores its SHA-256 hash,
so a leaked database contains no working links. In development there is no mail
provider: the token is written to the server log instead.

### `POST /auth/resend-verification`

For someone whose verification link expired or never arrived.

```json
{ "email": "anna@example.com" }
```

The email is normalised and validated as at registration. Returns `200` with the
same body in every case:

```json
{ "message": "If an account needs verifying, a new link is on its way." }
```

A new link is emailed only when the account exists, is not verified yet, and is
not banned or deleted — suspended users get one. Unknown and already verified
addresses get the same answer and no email, so the endpoint reveals neither who
has an account nor whose is verified. The new link retires every older one.

The same known few-millisecond gap as `forgot-password`, with the same v2 fix.

### `POST /auth/login`

```json
{ "email": "anna@example.com", "password": "a decent long passphrase" }
```

The email is trimmed and lowercased, as at registration. The password only has
to be non-empty: registration's length rules are not applied, so a wrong short
password is a `401`, not a `422`.

Returns `200`, sets the session cookie, and says who is logged in:

```json
{
  "user": {
    "id": "cm1…",
    "email": "anna@example.com",
    "displayName": "Anna",
    "emailVerified": false
  }
}
```

**The session cookie** is `farhand_session`: a random token, stored in the
`Session` table only as a SHA-256 hash. It is `HttpOnly` (page scripts cannot
read it), `SameSite=Lax` (not sent on requests other sites trigger in the
background, which blocks most CSRF), `Path=/`, and `Secure` in production only —
development runs on plain http, where a Secure cookie would never be sent back.
Sessions last 30 days, fixed; every login starts its own session, so each device
has one.

**Failures, and the order they are checked in:**

| Case | Response |
|---|---|
| Unknown email, wrong password, or a `DELETED` account | `401`, the same body for all three |
| `BANNED` account, right password | `403` |
| `SUSPENDED` or unverified account | Logged in normally — restrictions apply per action |
| Missing email or password | `422` |

The password is checked before the account status, and it is checked even when
the email matches no account, against a dummy hash. So an unknown email takes as
long as a wrong password, and only someone who knows the password can learn that
an account is banned.

Rate limiting arrives in #14.

### `GET /auth/me`

Who is logged in. `SESSION`: works for unverified and suspended users too, so
the frontend can tell them what they need to do.

Returns `200`:

```json
{
  "user": {
    "id": "cm1…",
    "email": "anna@example.com",
    "role": "USER",
    "status": "ACTIVE",
    "suspendedUntil": null,
    "emailVerified": false,
    "profile": {
      "displayName": "Anna",
      "bio": null,
      "countryCode": "EE",
      "city": null,
      "avatarUrl": null
    }
  }
}
```

`status` and `suspendedUntil` are there so the frontend can show "your account
is suspended until …". The password hash is never part of any reply.

### `POST /auth/logout`

Ends the session the request came from; the user's other devices stay logged
in. Deletes the session row and clears the cookie. Returns `204` with no body.

Logging out twice at the same moment (a double-click) returns `204` both times.

### When a session stops working

Every `SESSION` and `AUTH` request checks the session again, so these take
effect on the very next request — not when the cookie expires:

| Case | Response |
|---|---|
| No cookie, or a cookie that matches no session | `401` |
| Session expired (30 days after login) | `401` |
| Account banned or deleted since login | `401` |
| Logged out | `401` — the cookie may linger in the browser, but it points at nothing |
| Password reset since login | `401` — a reset logs out every device |

The body is the same in every case. Beyond `SESSION`, an `AUTH` route answers
`403` to an unverified user ("Confirm your email address first") or a suspended
one, and a `MOD` route answers `403` to a regular user.

### `POST /auth/forgot-password`

```json
{ "email": "anna@example.com" }
```

The email is normalised and validated as at registration. Returns `200` with the
same body whether or not the email has an account:

```json
{ "message": "If an account exists for that email, a reset link is on its way." }
```

If the account exists and is not banned or deleted, a reset token is emailed
(logged in development). Unverified accounts get one too. Asking again retires
every earlier unused link, so only the newest one works. Links expire after one
hour — much shorter than a verification link, because a reset link can take over
the account.

Known and deliberate: a real account costs one extra database write, so it
answers a few milliseconds slower than an unknown email. The complete fix is to
hand every request to the v2 background job queue and let the worker decide
whether there is anyone to email.

### `POST /auth/reset-password`

```json
{ "token": "the token from the reset email", "password": "a brand new passphrase" }
```

The new password follows the registration rules (8–72 characters). It is checked
before the token, so a rejected password gets a `422` naming the field and leaves
the link usable.

Returns `200`:

```json
{ "message": "Password changed. Log in with your new password." }
```

A successful reset sets the new password, uses up the token, marks the email as
verified if it was not already (the link reached the inbox, which proves
ownership), and **logs the account out on every device**. It does not log the
user in: they log in with the new password.

Unknown, already used, expired and wrong-type tokens (a verification token), and
tokens of an account banned or deleted since, all return `422` with the same
body. Submitting the same token twice at the same moment changes the password
once.

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
