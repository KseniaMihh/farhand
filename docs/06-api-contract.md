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
- Lists are cursor-paginated: `?cursor=<cursor>&limit=20`, returning
  `{ items: [...], nextCursor: string | null }`. `nextCursor` is `null` on the
  last page.
- A cursor is an opaque string. It encodes the sort position — for needs, the
  `createdAt` and `id` of the last row of the page before — so paging is by
  position rather than by counting: rows inserted or removed while someone
  pages cannot make a row appear twice or disappear (`docs/11-risks.md`).
  Clients send back what they were given and never build one.

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
| POST | `/auth/login` | — | Sets an httpOnly session cookie |
| POST | `/auth/logout` | SESSION | Deletes this device's session |
| GET | `/auth/me` | SESSION | Current user and profile |
| POST | `/auth/forgot-password` | — | Emails a one-hour reset link. Always responds identically |
| POST | `/auth/reset-password` | — | Token plus new password; revokes all sessions |

Every endpoint in this section is rate limited — see [Rate limits](#rate-limits) below.

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

### Rate limits

Every authentication endpoint is limited twice over: by the address the request
came from, and by the account it is about. Either limit alone is easy to walk
around — an attacker with a botnet has thousands of addresses, and one address
can try a thousand accounts once each — so both run together.

| Endpoints | Per address | Per account | Window |
|---|---|---|---|
| `/auth/login` | 20 | 10 | 15 minutes |
| `/auth/register` | 10 | 5 | 1 hour |
| `/auth/forgot-password`, `/auth/resend-verification` | 10 | 5 | 1 hour |
| `/auth/verify-email`, `/auth/reset-password` | 30 | — | 15 minutes |

The two email-sending endpoints share one budget: both send mail to whatever
address was typed in, so five in total, not five each. The token endpoints have
no account to count by; the address limit is what makes guessing at tokens
pointless.

The account key is the email from the request body, normalised the way the
schemas normalise it, so `" Anna@X.com "` and `anna@x.com` share a budget.

Over the limit returns `429` in the usual error shape, with `Retry-After` in
seconds:

```json
{ "error": { "code": "TOO_MANY_REQUESTS", "message": "Too many requests, please try again later" } }
```

Every reply, not only a `429`, carries `RateLimit` and `RateLimit-Policy`
headers, so a client can see what is left instead of guessing.

The counts are held in the API process's memory. That is correct for one
instance and wrong for several — each would count separately — so the store
moves to Redis when the API is deployed behind more than one instance
(`src/middleware/rate-limit.ts`).

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
| POST | `/needs` | AUTH | Limited to 5 open needs per account |
| PATCH | `/needs/:id` | AUTH | Owner only, `DRAFT` or `OPEN` only |
| DELETE | `/needs/:id` | AUTH | Owner only, no live deal. Closes it; the row stays |
| GET | `/me/needs` | SESSION | Includes non-public statuses |

### `GET /needs`

The public list. Open needs only, newest first.

| Query | Meaning |
|---|---|
| `buyCountry` | Two letters. Where the product must be bought |
| `deliverCountry` | Two letters. Where it must be shipped |
| `categoryId` | Exact category |
| `q` | Free text, matched against the title and the description, ignoring case |
| `limit` | 1–50, default 20 |
| `cursor` | From the previous page's `nextCursor` |

An absent filter narrows nothing. Filters combine: all of them must match.

```json
{
  "items": [{ "id": "cm1…", "title": "Japanese sunscreen, 50 ml", "…": "…" }],
  "nextCursor": "MjAyNi0wOS0yM1QxMDoxMjozMy4wMDBafGNtMWFiYw"
}
```

`nextCursor` is `null` on the last page. Searching is a plain case-insensitive
match, not a full-text index — fine at this size, and worth revisiting when the
list grows.

### `GET /needs/:id`

Public, but what "public" means depends on the need:

| Who is asking | Sees |
|---|---|
| Its requester | Any status, including their own drafts |
| Anyone else | `OPEN` and `MATCHED` only |

A matched need stays readable because a deal is running on it and both sides
need to see what was agreed. Everything else answers `404`, not `403`: a draft
nobody published should not be discoverable by trying ids.

### `GET /me/needs`

`SESSION`. The caller's own needs, every status, newest first, paged exactly
like the public list. This is where someone finds their drafts.

### `POST /needs`

```json
{
  "categoryId": "cm1…",
  "title": "Japanese sunscreen, 50 ml",
  "description": "The Biore one that is not sold in Europe. Two bottles.",
  "buyCountry": "JP",
  "deliverCountry": "EE",
  "currency": "EUR",
  "estimatedPrice": 2400,
  "thankYouAmount": 0,
  "status": "OPEN",
  "productUrl": null,
  "storeName": null,
  "expiresAt": null
}
```

| Field | Rule |
|---|---|
| `categoryId` | Must be an existing category, or `400` |
| `title` | 1–120 characters |
| `description` | 1–2000 characters |
| `buyCountry`, `deliverCountry` | Two letters, upper-cased |
| `currency` | Three letters, ISO 4217, upper-cased |
| `estimatedPrice` | Whole cents, above zero |
| `thankYouAmount` | Whole cents, zero or more. Defaults to `0` |
| `status` | `DRAFT` or `OPEN` only. Defaults to `OPEN` |
| `productUrl`, `storeName`, `expiresAt` | May be `null` |

Only `DRAFT` and `OPEN` can be asked for. `MATCHED` happens when a proposal is
accepted, `CLOSED` when the requester takes the need down, `EXPIRED` when its
date passes, and `REMOVED` when a moderator hides it.

Returns `201` with `{ "need": { … } }`.

**One account may have 5 open needs at a time** (`MAX_OPEN_NEEDS` in
`src/services/needs.ts`), one of the three defences against spam listings in
docs/07-trust-and-safety.md. A sixth returns `409` — the request is well
formed, it is the account's state that conflicts. Drafts do not count; closed,
expired and matched needs do not count.

### `PATCH /needs/:id`

Any subset of the fields above; what is not mentioned is not changed. Returns
`200` with the updated need.

Allowed only while the need is `DRAFT` or `OPEN`. Once it is `MATCHED` someone
has agreed to shop for exactly what it said, so editing returns `409`.
Publishing a draft (`status` from `DRAFT` to `OPEN`) counts against the
open-needs limit, or saving drafts would be a way around it.

### `DELETE /needs/:id`

Returns `204`. **Closes the need — it does not erase it.** The status becomes
`CLOSED` and the row stays, because proposals and messages point at it and
"soft deletion everywhere" is deliberate (docs/05-data-model.md). Deleting an
already closed need returns `204` again.

Refused with `409` while a deal is live, meaning any deal on this need whose
status is not `CANCELLED` — the same definition the database's
`one_active_deal_per_need` index uses.

### Who may change a need

| Case | Response |
|---|---|
| Not signed in | `401` |
| Email not confirmed, or account suspended | `403` |
| Someone else's need | `403` |
| No such need | `404` |

`403` rather than `404` for someone else's need, unlike most of this API: a
need is public, so refusing reveals nothing that `GET /needs/:id` would not.
The rules themselves are enforced in `src/services/needs.ts`, not in the
routes, so every future caller gets them too.

## Helps

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/helps` | — | Filters: `country`, `shipsTo`, `categoryId`. Only `ACTIVE`. An empty `shipsTo` matches every country |
| GET | `/helps/:id` | — | Public |
| POST | `/helps` | AUTH | Categories are a list; empty `shipsTo` means anywhere |
| PATCH | `/helps/:id` | AUTH | Owner only |
| DELETE | `/helps/:id` | AUTH | Owner only. Marks it removed; the row stays |

### `GET /helps`

The public list. Active offers only, newest first.

| Query | Meaning |
|---|---|
| `country` | Two letters. Where the helper is |
| `shipsTo` | Two letters. Where the parcel must go |
| `categoryId` | Matches an offer with that category among its categories |
| `limit` | 1–50, default 20 |
| `cursor` | From the previous page's `nextCursor` |

```json
{
  "items": [{ "id": "cm1…", "country": "JP", "shipsTo": ["EE", "FI"], "categories": [], "…": "…" }],
  "nextCursor": null
}
```

**`shipsTo` also matches the offers that ship anywhere.** An empty `shipsTo` is
a helper saying "I post anywhere", so a search for `EE` returns both the offers
listing `EE` and the offers listing nothing. Leaving them out would hide the
most useful helpers from every search.

Paused and removed offers are not listed. Paging is the same as for needs:
keyset on `(createdAt, id)`, with an opaque cursor.

### `GET /helps/:id`

| Who is asking | Sees |
|---|---|
| Its helper | Any status, including their own paused offer |
| Anyone else | `ACTIVE` only |

Anything else answers `404` rather than `403`, as with needs.

### `POST /helps`

```json
{
  "country": "JP",
  "shipsTo": ["EE", "FI"],
  "description": "I live in Tokyo and post to the Baltics every other week.",
  "categoryIds": ["cm1…", "cm2…"],
  "status": "ACTIVE"
}
```

| Field | Rule |
|---|---|
| `country` | Two letters. Where the helper can buy |
| `shipsTo` | Up to 50 two-letter codes, upper-cased, duplicates dropped. **Empty means anywhere**, and it is the default |
| `description` | 1–1000 characters |
| `categoryIds` | 1–10 existing categories. Unknown one → `400` |
| `status` | `ACTIVE` or `PAUSED`. Defaults to `ACTIVE` |

Returns `201` with `{ "help": { …, "categories": [{ "id", "slug", "name" }] } }`.
An offer always comes back with its categories.

`REMOVED` is never something a caller asks for: it is what taking an offer down
does, and what a moderator does (#27).

There is no limit on offers per account, unlike the five open needs. A need
takes a place in a queue somebody has to answer; an offer waits to be found.

### `PATCH /helps/:id`

Any subset of the fields above; what is not mentioned is not changed. Returns
`200` with the updated offer.

`categoryIds` **replaces** the list — the categories you send are the
categories the offer has afterwards. Leaving the field out changes nothing.

A `PAUSED` offer can still be edited: pausing means "not this month", and
fixing a typo should not require restarting it. A `REMOVED` one cannot (`409`).

### `DELETE /helps/:id`

Returns `204`. Sets the status to `REMOVED` and keeps the row, because
proposals point at a help and that history has to survive. Asking twice returns
`204` again.

### Who may change an offer

| Case | Response |
|---|---|
| Not signed in | `401` |
| Email not confirmed, or account suspended | `403` |
| Someone else's offer | `403` |
| No such offer | `404` |
| Editing a removed offer | `409` |

Enforced in `src/services/helps.ts`, not in the routes.

## Proposals

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/needs/:id/proposals` | AUTH | A helper answers a need. Not your own need; one per helper per need |
| POST | `/helps/:id/proposals` | AUTH | A requester approaches a helper about a need. Not your own offer; the need must be yours |
| GET | `/me/proposals` | SESSION | Both sent and received |
| POST | `/proposals/:id/accept` | AUTH | Requester only. Transaction: accept this, decline the rest, close the need, create the deal, log the first event |
| POST | `/proposals/:id/decline` | AUTH | Requester only |
| POST | `/proposals/:id/withdraw` | AUTH | Helper only |

### Two ways in, one row

People find each other both ways round (docs/03-user-journeys.md), so there are
two paths that create the same kind of row:

| Path | Who calls it | `initiatedBy` | `helpId` |
|---|---|---|---|
| `POST /needs/:id/proposals` | The helper, about somebody else's need | `HELPER` | `null` |
| `POST /helps/:id/proposals` | The requester, about their own need | `REQUESTER` | The offer |

The ownership rules are opposites — the first refuses the need's owner, the
second insists on it — which is why they are two paths rather than one that
guesses from who is asking. Everything afterwards is identical: the same
statuses, the same conversation, the same accept. `initiatedBy` is recorded for
display and nothing branches on it.

### `POST /needs/:id/proposals`

```json
{ "message": "I live in Tokyo and can get this within the week." }
```

`message` is optional, 1–1000 characters, and `null` when left out.

Returns `201` with `{ "proposal": { … } }`, status `PENDING`, `respondedAt`
`null`. The proposal carries the need it is about: `id`, `title`, `status` and
`requesterId`.

### `POST /helps/:id/proposals`

```json
{ "needId": "cm1…", "message": "Would you get this for me?" }
```

`needId` is required and must be a need the caller owns; `message` is the same
optional note. Returns `201` in the same shape, with `initiatedBy` set to
`REQUESTER` and `helpId` set to the offer the requester was reading.

### `GET /me/proposals`

`SESSION`. Everything the caller is part of, whichever side they are on: the
proposals they sent as a helper and the ones they received on their own needs,
in one list, newest first, paged exactly like needs and offers.

`SESSION` rather than `AUTH` for the same reason as `GET /me/needs`: reading
what you already sent should not depend on having confirmed your email.

### `POST /proposals/:id/decline` and `POST /proposals/:id/withdraw`

The same shape from opposite sides. Declining is the requester's word, and only
the need's requester may do it; withdrawing is the helper's, and only the helper
who sent the proposal may do it. Both return `200` with the updated proposal,
set `respondedAt`, and work only while the proposal is `PENDING` — anything else
is `409`.

**Withdrawing is not undo.** The unique constraint is on `(needId, helperId)`
and takes no notice of status, so a withdrawn or declined proposal keeps the
slot: that helper cannot propose on that need again, and a later
`POST /needs/:id/proposals` returns `409`. It follows from "one proposal per
helper per need", and it is deliberate — a proposal is a record that the two of
them have already been in touch about this, not a message that can be unsent.

### `POST /proposals/:id/accept`

The requester says yes. Returns `201` — it creates something new — with
`{ "deal": { …, "proposal": { … }, "events": [ { … } ] } }`, the deal being the
only thing in the system the two of them act on afterwards.

**Five writes, one decision.** In one transaction:

1. this proposal → `ACCEPTED`, `respondedAt` now
2. every other `PENDING` proposal on the need → `DECLINED`, same `respondedAt`
3. the need → `MATCHED`
4. the `Deal` is created, `MATCHED`, with `currency` and `thankYouAmount`
   **copied off the need**, so later edits to the need cannot move an agreed
   deal (docs/04-deal-lifecycle.md)
5. the first `DealEvent`: `fromStatus` `null`, `toStatus` `MATCHED`, the
   requester as actor

Either all five happen or none do. A partly finished accept — a deal whose
proposal is still pending, a need still open with a deal already running — is a
state nothing else in the system knows how to read, which is why
docs/11-risks.md names this the hardest part of the project.

Proposals already `WITHDRAWN` or `DECLINED` are left as they are: step 2 means
the ones still waiting, not rewriting history. The response is read back from
the database rather than assembled in memory, so what the caller gets is what
was written.

The last line of defence is the database's own: the partial unique index
`one_active_deal_per_need` (docs/05-data-model.md) refuses a second live deal on
one need even if every check above somehow passed, and that refusal is answered
as `409`, not `500`.

### Who may propose, accept, decline and withdraw

| Case | Response |
|---|---|
| Not signed in | `401` |
| Email not confirmed, or account suspended | `403` |
| Your own need, or your own offer | `403` |
| Introducing a need that is not yours | `403` |
| Accepting or declining as the helper, or withdrawing as the requester | `403` |
| No such need, offer or proposal | `404` |
| A need or offer nobody but its owner may see | `404` |
| The need is no longer `OPEN` | `409` |
| A proposal already exists between those two for that need | `409` |
| The proposal is no longer `PENDING` | `409` |
| The need already has a live deal | `409` |

Enforced in `src/services/proposals.ts`, not in the routes.

## Messages

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/proposals/:id/messages` | AUTH | Send. Opens the thread if there isn't one. Rate limited |
| GET | `/conversations` | AUTH | Inbox, most recently spoken in first, with unread counts |
| GET | `/conversations/:id/messages` | AUTH | Participants and moderators, paginated |
| POST | `/conversations/:id/read` | AUTH | Updates the reader's timestamp |

### One thread per proposal, made by the first message

A conversation belongs to a **proposal**, not to a deal: "what size?" and "does
it ship to Estonia?" are exactly the questions people need answered *before*
accepting (docs/05-data-model.md). A declined proposal keeps its thread,
because the conversation is a record of what was said.

It does not exist until somebody writes. An empty thread is noise in an inbox,
so the first message creates it — **and that is why sending is addressed by the
proposal**: there is no conversation id to post to yet. This replaces the
earlier `POST /conversations/:id/messages`, which could only have worked if
every proposal came with a thread nobody had used.

### `POST /proposals/:id/messages`

```json
{ "body": "I can get the 50 ml one. Do you want two?" }
```

`body` is 1–4000 characters, matching `Message.body` in the schema. Returns
`201` with `{ "message": { … } }`.

Only the two of them may write: the need's requester and the proposal's helper.
Everyone else gets `403` — **moderators included**. They read threads; they do
not join them.

Nothing here looks at the proposal's status. A declined proposal can still be
talked about: "sorry, and good luck" is a reasonable last word, and stopping it
would be a rule nobody asked for.

**Rate limited to 20 a minute, per signed-in sender** (`RATE_LIMITS.message`).
Counted per *user* and not by address, because two people in one office share
an address, and because a message has no email in its body to count by. A
message the server then refuses still spends budget — the limiter runs before
the handler, or a flood of invalid requests would be free.

### `GET /conversations/:id/messages`

The two participants and any moderator may read; for anybody else the thread
`404`s, because one you may not read is one you have no business knowing
exists.

**Paged like a chat window.** The first request returns the newest page,
ordered **oldest to newest within the page**; its cursor asks for the page
*before* that one. So you open a thread at the end of it, as you would expect,
and page backwards through what came before.

A message a moderator has removed keeps its place in the thread and comes back
with `body: null` (docs/07-trust-and-safety.md keeps the row as evidence). A
hole that says "removed" is honest; one that silently closes up makes the
thread read as though nothing was ever sent.

### `GET /conversations`

The caller's own threads, **most recently spoken in first** — ordered by
`lastMessageAt`, which exists on the row for that purpose, so the cursor
carries that column rather than `createdAt`. Each entry carries the proposal,
enough of the need to show a title, and `unreadCount`.

Unread means: messages the other person sent after the caller's own
`requesterLastReadAt` or `helperLastReadAt`. A thread never read counts
everything from the other side. Two timestamps rather than a flag per message —
one small write when you open a thread, instead of one per message read.

### `POST /conversations/:id/read`

Sets the caller's own timestamp and returns `200` with the conversation.
Marking an already-read thread read again is the same request twice, and lands
on the same answer.

A moderator gets `403` here, not `404`: they may read the thread, so pretending
it does not exist would be a lie they can disprove — but reading somebody
else's conversation is not the same as having read it.

### Who may write, read and mark read

| Case | Response |
|---|---|
| Not signed in | `401` |
| Email not confirmed, or account suspended | `403` |
| Writing to a proposal that is not yours, moderators included | `403` |
| A moderator marking a thread read | `403` |
| No such proposal or conversation | `404` |
| Reading or marking a thread you are not in | `404` |
| Message empty, or over 4000 characters | `422` |
| More than 20 messages in a minute | `429` |

Enforced in `src/services/conversations.ts`, not in the routes.

## Deals

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/me/deals` | AUTH | Filter by status |
| GET | `/deals/:id` | AUTH | Participants and moderators only |
| POST | `/deals/:id/quote` | AUTH | Helper submits amounts and currency |
| GET | `/deals/:id/quotes` | AUTH | Every revision, newest first. Participants only |
| POST | `/deals/:id/transition` | AUTH | Body: `{ to, note?, trackingNumber?, shippingActual? }`. Validated against the transition table |
| GET | `/deals/:id/events` | AUTH | Full history |

One transition endpoint rather than one endpoint per status keeps the rules in a
single place. The alternative is recorded in the decisions folder.

**A deal is private to its two people.** Everywhere in this section, a caller
who is neither the requester nor the helper gets `404`, never `403`: telling a
stranger that a deal exists is itself a leak. Moderators are the exception the
table above notes, and that arrives with the moderation issues.

### `POST /deals/:id/quote`

```json
{ "currency": "JPY", "productAmount": 3200, "shippingEstimate": 1100 }
```

| Field | Rule |
|---|---|
| `currency` | Three letters, ISO 4217, upper-cased |
| `productAmount` | Whole cents, above zero |
| `shippingEstimate` | Whole cents, zero or more — free postage is a real offer |

Returns `201` with `{ "quote": { … } }`.

**Only the helper may quote**, and **only while the deal is `MATCHED`** (`409`
otherwise). Being quoted at is not the same as quoting, and once a quote is
agreed the amounts are locked.

**A quote is not a status.** Submitting again is how a helper revises: a new
row each time, the newest being the offer on the table. Nothing is overwritten
and nothing is deleted, which is what makes "what did you quote me last week?"
answerable — the requirement in docs/04-deal-lifecycle.md that each revision is
logged.

**The deal's own `productAmount` and `shippingEstimate` stay `null` until
something is agreed.** Those columns are what was *agreed*, not what was
*offered*; a reader can tell the difference without consulting the status.

### `GET /deals/:id/quotes`

Every quote on the deal, newest first, for either of its two people. Not paged:
a deal has a handful of revisions, not a thousand.

### `POST /deals/:id/transition`

```json
{ "to": "QUOTE_AGREED" }
```

Returns `200` with the deal and its events. **Every status change in the
product goes through this one endpoint** (docs/10-decisions/0008), and what it
allows is the table in docs/04-deal-lifecycle.md — held once, as data, in
`src/services/transitions.ts`. Nothing else anywhere decides that a status
change is permitted.

| From | To | Who | Extra fields |
|---|---|---|---|
| `MATCHED` | `QUOTE_AGREED` | Requester | — |
| `QUOTE_AGREED` | `PRODUCT_PAID` | Requester | — |
| `PRODUCT_PAID` | `PURCHASED` | Helper | — |
| `PURCHASED` | `SHIPPED` | Helper | `trackingNumber`, `shippingActual` |
| `SHIPPED` | `DELIVERED` | Requester | — |
| `DELIVERED` | `COMPLETED` | Requester | — |
| `MATCHED`, `QUOTE_AGREED`, `PRODUCT_PAID`, `PURCHASED` | `CANCELLED` | Either side | `note` |
| `PRODUCT_PAID`, `PURCHASED`, `SHIPPED` | `DISPUTED` | Either side | `note` |
| `DISPUTED` | `CANCELLED` | Moderator | `note` |
| `DISPUTED` | `PRODUCT_PAID`, `PURCHASED` or `SHIPPED` | Moderator | `note` |

**Cancelling reopens the need** it came from, in the same transaction — unless
the requester has closed it or a moderator has removed it, which a cancellation
must not undo (docs/04-deal-lifecycle.md).

**A dispute can only be resolved back to where it started.** The table lists all
three states a dispute can return to because it cannot know which applies to a
given deal; the event log does, and anything else is `409`.

**A deal delivered 14 days ago completes itself**, with a null actor on the
event. Nothing about that goes through this endpoint — it is a scheduled job,
described in docs/04-deal-lifecycle.md.

Nine statuses make 81 possible moves. Seventeen are above; the other sixty-four
— including standing still and going backwards — are refused, whoever asks.

**Three refusals, and they mean different things:**

| Case | Response |
|---|---|
| The table has no such move from where the deal is | `409` |
| The move exists, but not for this person | `403` |
| The body is missing a field the target needs, or carries one it does not use | `422` |
| The deal is not the caller's, and they are not a moderator | `404` |

The last of those matters more than it looks: telling somebody "you may not"
would confirm that the deal exists.

**"Either side" means either side of the deal** — the requester or the helper,
not a moderator. A moderator has exactly one row of their own, ending a dispute,
and cannot confirm a parcel or cancel somebody else's deal.

**Fields are validated per transition, not per target.** Shipping without a
tracking number is `422` rather than a deal that says `SHIPPED` with nothing to
track, and a tracking number sent along with "delivered" is `422` rather than
silently dropped — sending it means believing something untrue about what the
request does.

Per *transition* and not per *target*, because the same target can need
different things depending on where the deal is coming from:

| | |
|---|---|
| `PURCHASED` → `SHIPPED` | the helper posts it: `trackingNumber`, `shippingActual` |
| `DISPUTED` → `SHIPPED` | a moderator undoes a dispute: `note` only — the parcel details are already on the deal |

So the schema checks only what it can decide without knowing the deal — is `to`
a status, is the note short enough, is the postage whole cents — and refuses
fields nobody has heard of. Which fields this particular move requires, and
which it has no use for, comes from the table.

**Every transition writes a `DealEvent`**: where it came from, where it went,
who did it, and the `note` if there was one. That is what makes the log
trustworthy as history rather than as a partial record of the interesting
moves. A refused transition writes nothing.

Two transitions have side effects, and both happen inside the same transaction
as the status change:

- `QUOTE_AGREED` copies the money off the quote (below)
- `SHIPPED` writes `trackingNumber` and `shippingActual` onto the deal

The remaining side effects in docs/04-deal-lifecycle.md — a need reopening
after a cancellation, reviews unlocking, the 14-day auto-complete, and
returning a disputed deal to the state it came from — belong to the issues that
build them, and are not in the engine.

### Agreeing a quote, in detail

Agreeing does four things at once, in one transaction — all of them or none:

1. the deal moves to `QUOTE_AGREED`
2. `currency`, `productAmount` and `shippingEstimate` are **copied from the
   quote** onto the deal, and are immutable from then on
3. that quote's `acceptedAt` is set; a partial unique index
   (`one_accepted_quote_per_deal`) refuses a second accepted quote whatever the
   code does
4. a `DealEvent` records `MATCHED` → `QUOTE_AGREED` and who did it

**The currency comes from the quote, not the need.** A deal is created with the
need's currency (#20), but nothing is agreed then; the helper may quote in the
currency they will actually be spending, and accepting is the moment it stops
being negotiable. That is what docs/04-deal-lifecycle.md means by "one currency
per deal, chosen at quote time".

### `GET /deals/:id`

One deal, with its quotes (newest first) and its full event log (**oldest
first** — a history reads forwards). For the deal's two people, and for a
moderator, who cannot judge a report without reading what it is about. Anybody
else gets `404`.

### `GET /me/deals`

The caller's own deals, whichever side they are on, newest first, paged like
every other list here.

| Query | Meaning |
|---|---|
| `status` | One `DealStatus`. Anything else is `422` |
| `limit` | 1–50, default 20 |
| `cursor` | From `nextCursor` |

## Reports and moderation

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/reports` | AUTH | Target type and id, reason, details |
| GET | `/admin/reports` | MOD | Queue, oldest first, filter by status, target type and reason |
| GET | `/admin/reports/:id` | MOD | One report, with the thing it is about |
| POST | `/admin/reports/:id/resolve` | MOD | Resolution note required |
| GET | `/admin/users` | MOD | Search. **Not built** — no issue covers it yet |
| POST | `/admin/users/:id/actions` | MOD | Warn, suspend, ban, reactivate; reason required |
| POST | `/admin/content/:type/:id/remove` | MOD | Hide a need, help or message |

Everything under `/admin` requires `MODERATOR` or above, and the prefix is not
decoration: keeping those routes together is what makes a missing guard obvious
at a glance (docs/02-roles-and-permissions.md).

### `POST /reports`

```json
{
  "targetType": "NEED",
  "targetId": "cm1…",
  "reason": "PROHIBITED_ITEM",
  "details": "This is a medicine, which the rules do not allow"
}
```

| Field | Rule |
|---|---|
| `targetType` | `USER`, `NEED`, `HELP` or `MESSAGE` |
| `targetId` | The id of a thing of that type |
| `reason` | `PROHIBITED_ITEM`, `SCAM`, `HARASSMENT`, `SEXUAL_CONTENT`, `SPAM` or `OTHER` |
| `details` | Up to 2000 characters. May be `null` |

Returns `201` with `{ "report": { … } }`, status `OPEN`.

`details` is optional on purpose: the reason carries the meaning, and demanding
a paragraph before somebody can report harassment is a way of getting fewer
reports about harassment.

**The target is checked in the service, because nothing else can check it.**
`targetType` and `targetId` name one of four tables, so there is no foreign key
— the database would accept a report about a need that does not exist, a message
id somebody invented, or the string "banana". The rules:

| Target | Reportable when |
|---|---|
| `USER` | The user exists |
| `NEED` | It is `OPEN` or `MATCHED` — the statuses anybody may see (#16) |
| `HELP` | It is `ACTIVE` (#17) |
| `MESSAGE` | The reporter is one of the two people in the conversation (#21) |

| Case | Response |
|---|---|
| Not signed in | `401` |
| Your own need, offer, message, or yourself | `403` |
| No such target, **or one you may not see** | `404` |
| An unknown target type or reason | `422` |
| You already have an open report about this target | `409` |

**A target you cannot see answers exactly like a target that is not there.** If
an invented id said "no such thing" and a real one said "thank you", this
endpoint would be a way of asking whether any given id exists.

**One open report per person per target**, kept by a partial unique index
(docs/05-data-model.md) rather than by a check, because two taps on a slow
connection both read "nothing yet". Somebody else reporting the same thing is
fine — two people complaining is information, not a duplicate — and once a
moderator has resolved a report, the same person may report the same target
again: it happened again, so it is news again.

### `POST /admin/users/:id/actions`

```json
{ "type": "SUSPEND", "reason": "Abusive messages", "until": "2026-10-13T00:00:00Z" }
```

| Field | Rule |
|---|---|
| `type` | `WARN`, `SUSPEND`, `BAN` or `REACTIVATE` |
| `reason` | 1–1000 characters. **Always required** |
| `until` | Only with `SUSPEND`. Absent means "until somebody lifts it" |

Returns `201` with `{ "action": { … } }`. What each one leaves behind:

| Type | The account afterwards |
|---|---|
| `WARN` | Unchanged — **the record is the warning** |
| `SUSPEND` | `SUSPENDED`, with `suspendedUntil` set or null |
| `BAN` | `BANNED` |
| `REACTIVATE` | `ACTIVE`, and `suspendedUntil` cleared. Undoes a ban as well as a suspension |

The effects are not new rules, they are the ones the guards already enforce: a
suspended account can read and cannot act (`requireActive`), and a banned one
cannot sign in at all — both since #13 and #41.

**The action and the status change are one write.** A ban nobody can account
for, or a record of a ban that did not happen, are both worse than neither.

| Case | Response |
|---|---|
| Not a moderator | `403` |
| The target is a moderator, an admin, or yourself | `403` |
| No such user | `404` |
| The account is already `DELETED` | `409` |
| No reason, or `until` on anything but a suspension | `422` |

Nobody moderates sideways or upwards: a moderator cannot act on another
moderator, and an end date on a ban is refused rather than silently ignored,
because a ban that quietly expires is not a ban.

### `POST /admin/content/:type/:id/remove`

`type` is `NEED`, `HELP` or `MESSAGE`; `USER` is `422`, because an account is
banned rather than removed. The body is `{ "reason": "…" }`, required.

A need or an offer becomes `REMOVED`; a message keeps its row and gets
`removedAt`, so the thread still shows that something was there and its words
are gone (#21). Removing something twice is `409` — it is already gone, and a
second entry in the log would suggest it had come back.

The `AdminAction` records **both** halves: `targetUserId` is whose account it
was about — the need's requester, the offer's helper, the message's sender —
and `contentType`/`contentId` are what was actually taken down. A log that
cannot answer "what did you remove?" is not an audit log.

### `GET /admin/reports/:id`

One report with the thing it is about: the need, the offer, the message, or the
user and their profile. #26's queue held a type and an id and nothing else, so
a moderator could see that something was reported but not what.

A target that has since been deleted comes back as `null` rather than an error,
or the queue would jam on a row nobody could close.

### `POST /admin/reports/:id/resolve`

```json
{ "outcome": "RESOLVED", "resolutionNote": "Listing removed" }
```

`outcome` is `RESOLVED` or `DISMISSED`; the note is required. Sets
`resolvedById`, `resolvedAt` and `resolutionNote`. A report that is not `OPEN`
is `409`.

**No `AdminAction` is written.** Closing a report is not something done to an
account; if the moderator also warned somebody or removed a listing, that call
wrote its own record.

Resolving frees the reporter to report the same target again, which is what
"one **open** report per person per target" was for (#26).

### `GET /admin/reports`

The moderator queue. **Oldest first** — the only list in the API that runs that
way. Everything people browse is newest first; this is work waiting to be done,
and the complaint that has waited longest is the one that matters most
(docs/07-trust-and-safety.md).

| Query | Meaning |
|---|---|
| `status` | `OPEN`, `RESOLVED` or `DISMISSED`. **Defaults to `OPEN`** |
| `targetType` | One of the four |
| `reason` | One of the six |
| `limit` | 1–50, default 20 |
| `cursor` | From `nextCursor`. Walks **forwards** in time, unlike every other cursor here |

The default matters: a moderator opening the queue wants the unresolved ones,
not every report ever filed. Looking back is something you ask for.

## Not in version 1

Uploads, reviews, notifications, saved searches, real-time messaging. See
`08-scope.md`.
