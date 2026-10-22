# API contract — version 1

REST over JSON. Cookie-based sessions. All money in integer cents.

Who may call an endpoint, and the middleware in `src/middleware/auth.ts` that
enforces it:

| Marker | Who | Middleware |
|---|---|---|
| — | Anyone | None that can refuse. A few of these read the session with `optionalAuth` to notice who is asking — `GET /needs/:id` shows a requester their own drafts — but nobody is turned away |
| `SESSION` | Any signed-in user whose account is not banned or deleted — unverified and suspended users included | `requireAuth` |
| `AUTH` | A signed-in user with a confirmed email who is not suspended | `requireAuth`, `requireVerified`, `requireActive` |
| `MOD` | A moderator or an admin, with a confirmed email and not suspended | `requireAuth`, `requireVerified`, `requireActive`, `requireRole("MODERATOR")` |

A suspended user can still see their own deals
(`docs/02-roles-and-permissions.md`), so read-only endpoints like that are marked
`SESSION` as they are built.

**This table is not decoration: a test reads it.**
`farhand-api/tests/contract/endpoints.test.ts` builds the real app, walks its
router, and fails if the guards in front of a route are not the ones its marker
names — or if any endpoint in any table below does not exist, or exists without
being written down here (#69). A row for something deliberately not built yet
says **Not built** and names the issue that will build it.

## Conventions

- Success: `200`, `201` for creation, `204` for no content.
- Client error: `400` malformed request, `401` not signed in, `403` signed in
  but not allowed, `404` not found or not visible to you, `409` conflict with
  current state, `410` gone — it was here and it is not, and asking again is
  the fix (#89) — `413` body too large, `422` validation failed, `429` rate
  limited.
- `400` and `422` are different failures. `400` means the request itself could
  not be read — unparseable JSON. `422` means it was read perfectly and the
  content was wrong: a missing field, a password too short, a country code that
  is not two letters. Only `422` can name the offending fields, which is why
  they are worth separating.
- Errors share one shape:
  `{ "error": { "code": "...", "message": "...", "requestId": "...", "details": [...] } }`.
- **Every response carries an `X-Request-Id` header, and every error body
  repeats it as `requestId`.** It is the same string that appears in the log
  line and on the error report, so somebody who can only see an error message
  can quote it and be found in the logs. An incoming `X-Request-Id` is kept if
  it is plausible — 8 to 128 characters of letters, digits, dashes and
  underscores — so a proxy or a frontend can start the trace; anything else is
  replaced, because the value ends up in log lines where a newline could forge
  a second entry.
- `requestId` is different on every request **by design**, which matters where
  two answers are meant to be indistinguishable: an unknown email and a wrong
  password still match in status, code and message, and the id says nothing
  about either.
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
{ "status": "ok", "uptime": 1234, "commit": "4f2a9c1e0b7d3a5f6e8c9b0a1d2e3f4a5b6c7d8e" }
```

`uptime` is whole seconds since the process started.

`commit` is the full SHA of the commit this process was deployed from, as the
host reports it, and `null` where nothing does — locally, in the test suite,
under docker compose. It is always present, never omitted. It exists so the
deploy job can tell the new version from the old one, which both answer
`/health/ready` happily during a deploy (docs/14-deployment.md). It is on
liveness only: readiness answers one question, about the database.

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
| POST | `/auth/resend-verification` | — | A new verification code. Always responds identically |
| POST | `/auth/login` | — | Sets an httpOnly session cookie |
| POST | `/auth/logout` | SESSION | Deletes this device's session |
| GET | `/auth/me` | SESSION | Current user and profile |
| POST | `/auth/forgot-password` | — | Emails a one-hour reset code. Always responds identically |
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
a verification token; a repeat registration is not. The email is queued inside
the same transaction as the account and sent a moment later by the worker
(#85), so a provider having a bad minute delays somebody's code instead of
losing it — and a registration that rolls back takes its job with it.

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
code.

Tokens are single use, even when two requests with the same token arrive at the
same moment (a double-click). They expire 24 hours after they are sent. Asking
for a new code with `POST /auth/resend-verification` retires every older one,
so only the newest works.

The raw token exists only in the email. The database stores its SHA-256 hash,
so a leaked database contains no working codes.

**What the email contains is a code, not a link** (#119). A link has to land on
a page, and there is no frontend yet — `APP_ORIGIN` is the API's own address —
while an inbox cannot follow a link to a `POST`. A `GET` that verified would be
spent by the first link prefetcher that saw it. So the message quotes the token
and says that Farhand will ask for it; #93 is where it becomes a link, and that
changes the words in `src/mailer.ts` and nothing else.

Where mail goes depends on configuration, not on the environment: with
`MAIL_API_KEY` and `MAIL_FROM` set, it is really sent (Brevo over HTTPS,
[decision 0014](10-decisions/0014-brevo-for-email.md)); with neither, the token
is written to the server log, which is how a local account is confirmed. In
production with no provider it is neither sent nor logged — a token in a
production log is a working credential.

### `POST /auth/resend-verification`

For someone whose verification code expired or never arrived.

```json
{ "email": "anna@example.com" }
```

The email is normalised and validated as at registration. Returns `200` with the
same body in every case:

```json
{ "message": "If an account needs verifying, a new code is on its way." }
```

A new code is emailed only when the account exists, is not verified yet, and is
not banned or deleted — suspended users get one. Unknown and already verified
addresses get the same answer and no email, so the endpoint reveals neither who
has an account nor whose is verified. The new code retires every older one.

And as at `forgot-password`, the deciding happens in the job rather than in the
request (#85), so the few-millisecond gap that used to give the answer away is
gone: every address costs one insert.

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
    "emailNotifications": true,
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
{ "message": "If an account exists for that email, a reset code is on its way." }
```

The request writes one row on the queue and answers. Nothing is looked up, so
there is nothing to be slower about: whatever the address, this route does the
same work and takes the same time. A worker picks the job up about two seconds
later (#85, [decision
0019](10-decisions/0019-a-job-table-of-our-own.md)) and decides there what the
route used to decide: if the account exists and is not banned or deleted, a
reset token is emailed — printed to the log instead when no mail provider is
configured, which is every environment but production (#119). Unverified
accounts get one too. Asking again retires every earlier unused code, so only
the newest one works. Codes expire after one hour — much shorter than a
verification code, because a reset code can take over the account.

**This is what closed a timing leak**, and the paragraph that used to be here
admitted it: a real account cost one extra database write, so the identical
sentence arrived a few milliseconds later than it did for an address nobody
has. A stranger timing the route could read what it refuses to say. The email
is now a couple of seconds late and the answer tells nobody anything, which is
the trade this route exists to make. The same applies to `POST
/auth/register` and `POST /auth/resend-verification`, which queue their mail
the same way.

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
verified if it was not already (the code reached the inbox, which proves
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
| `/files/:id` | 600 | — | 1 minute |

The two email-sending endpoints share one budget: both send mail to whatever
address was typed in, so five in total, not five each. The token endpoints have
no account to count by; the address limit is what makes guessing at tokens
pointless.

The account key is the email from the request body, normalised the way the
schemas normalise it, so `" Anna@X.com "` and `anna@x.com` share a budget.

Above all of them is a ceiling of **300 requests a minute per address**
(`RATE_LIMITS.global`). Not a security control on its own — the limits in the
table are what stop password guessing — but no single machine can hammer the
API whatever endpoint it picks.

`GET /files/:id` is the one endpoint outside that ceiling, with the larger
one of its own in the table instead. It is called **once per image**, so a
page of thirty photos would spend a tenth of a visitor's whole browsing
budget in one view, and the tenth view would be refused — which is a limit
written for one shape of traffic being applied to another (#102).

Over the limit returns `429` in the usual error shape, with `Retry-After` in
seconds:

```json
{ "error": { "code": "TOO_MANY_REQUESTS", "message": "Too many requests, please try again later" } }
```

Every reply, not only a `429`, carries `RateLimit` and `RateLimit-Policy`
headers, so a client can see what is left instead of guessing.

**The counts are held in the database, not in the API's memory** (#91). Every
number in this section is therefore the number, however many instances are
running: they share one row per limiter per client, and the window's deadline
is written by the database's own clock so two machines cannot disagree about
when it ends. Until #91 the counters were per process, which meant a second
instance would have doubled every limit here — the reason `numInstances` was
pinned to `1` in `render.yaml` (`docs/14-deployment.md`, decision 0027).

**If the database cannot be reached, the request is allowed** and the failure
is logged as an error. The store is the API's own database, so a counter that
cannot be read means the endpoint behind it is already failing; refusing as
well would turn a blip into a certain outage. The log line is what keeps that
from being a limiter that has quietly stopped limiting.

## Profile

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/users/:id` | — | Public profile |
| PATCH | `/me/profile` | AUTH | Own profile only |
| PUT | `/me/avatar` | AUTH | The image is the whole body. Re-encoded to a square WebP, at most 512 px, metadata stripped |
| DELETE | `/me/avatar` | AUTH | Back to no avatar. Fine when there is none |
| DELETE | `/me` | SESSION | Anonymise and mark deleted. Password required |

### `GET /users/:id`

Public: no session is read at all. Returns `200`:

```json
{
  "user": {
    "id": "cm1…",
    "displayName": "Anna",
    "countryCode": "EE",
    "bio": "I fly Tallinn–Tokyo twice a year.",
    "memberSince": "2026-03-04T09:12:00.000Z",
    "avatarUrl": "/files/cm1f…",
    "reviews": { "count": 3, "average": 4.3 }
  }
}
```

Six fields and an id, chosen against docs/07-trust-and-safety.md, which lists
scraping personal data as a risk and answers it by keeping profiles thin.
`avatarUrl` is a path on this API, or `null` (#80) — see `PUT /me/avatar`.
What is deliberately not here:

| Absent | Why |
|---|---|
| `email` | Never, anywhere, for anybody |
| `city` | A display name plus a city is often enough to find a real person, and nothing in a deal needs it. Its owner can see and set it; nobody else can read it |
| `role`, `status` | Moderators are not announced, and a suspension is between the account and us |

**`reviews` is the summary #65 left a hole for** (#84), and it is always
there:

| | |
|---|---|
| `count` | How many reviews the average is made of. `0` is a real answer |
| `average` | One decimal, or **`null` when there is nothing to average** |

`null` rather than `0`, because "nobody has reviewed them" and "everybody gave
them nothing" are different facts and a profile that confuses them libels a
newcomer. The `count: 0` beside it is what explains the `null` — which is why
the field is present here, unlike the version of this note that stood while
there was nothing to summarise at all.

Rounded to one decimal **by the API**, so two clients cannot disagree about
somebody's reputation, and computed in the database rather than by reading
every review somebody ever received.

It counts exactly what `GET /users/:id/reviews` lists as readable:
`countedWhere` — published, and not removed by a moderator. A profile can
therefore read *"5.0 from 3 reviews"* above a list of four, and the removed one
in that list is what explains the difference
([decision 0018](10-decisions/0018-a-removed-review-keeps-its-place.md)).

The individual reviews are **not** embedded here. They are their own paged,
public endpoint — a profile is kept thin on purpose, and a list that grows
without bound does not belong inside a record that does not.

The owner of a profile sees exactly what a stranger sees. `GET /auth/me` is
where somebody reads their own private fields, and there is no third answer in
between.

Who is visible:

| The account is | Answer |
|---|---|
| `ACTIVE` | `200` |
| `SUSPENDED` | `200`. A suspension stops someone acting, not existing, and their live deals carry on — the other side has to see who they are dealing with |
| `BANNED` | `404` |
| `DELETED` | `404` |
| No such id | `404` |

**The last three are byte-identical.** If a deleted account answered
differently from an id that never existed, then "is this person still on
Farhand?" would be a question anybody could ask about anybody — the same
enumeration problem `POST /auth/register` answers by always replying the same
way. A user row with no profile row answers `404` too: registration creates both
in one transaction, so it cannot happen, and returning half a profile would be
worse than saying there is nothing here.

### `DELETE /me`

`SESSION`. Closes the account: the personal data goes, the record that things
happened stays.

```json
{ "password": "a decent long passphrase" }
```

**The password, again.** Every other write in this API is authorised by the
session cookie alone. This one asks for the password as well, because it is
the only write that cannot be undone, and a cookie somebody else is holding
should not be enough to destroy an account. A wrong password is `403` and
nothing happens at all; a missing one is `422`.

`SESSION` rather than `AUTH`, unlike every other write. An unverified account
is still somebody's personal data — and the person who signed up and never
confirmed their address is exactly the one most likely to want it gone. A
suspended account too: a suspension stops you acting, and leaving is not
acting.

Returns `204`, and every session ends with it — this device and every other.

**Refused while a deal is still running:**

```json
{
  "error": {
    "code": "CONFLICT",
    "message": "Finish or cancel your open deals first. You have 1."
  }
}
```

A deal is running unless it is `COMPLETED` or `CANCELLED`. This is the one
place the API refuses to let somebody leave, and it is on purpose: a deal has
money in it and two people relying on each other, so somebody who has taken a
payment must not be able to disappear by pressing a button. The refusal says
how many are in the way, because a person who cannot see what is blocking them
cannot clear it.

#### What is erased, and what is kept

| Erased | Kept |
|---|---|
| Email address — replaced with `deleted-<id>@farhand.invalid`, a domain RFC 2606 reserves so it can never be real | The account row, marked `DELETED` with `deletedAt` set |
| Password — replaced with a value no password can match | Deals, and every event in their history |
| Display name — replaced with `Deleted account` | Proposals and messages, attributed to that name |
| Bio, city, avatar | Country code, which identifies nobody on its own and keeps a deal's history readable |
| Every session, on every device | Reports filed about them, so moderation is still possible |
| Every verification and password-reset token, so a code already sitting in an inbox cannot act on the account afterwards | |

The profile row is **blanked, not deleted**. An event whose actor has no
profile at all reads as somebody we cannot label (#67), which is true and says
the wrong thing: this is not an unknown person, it is one who left.

#### What happens to their listings

| | |
|---|---|
| Needs that are `DRAFT` or `OPEN` | `CLOSED` |
| Helps that are `ACTIVE` or `PAUSED` | `REMOVED` |
| Their own `PENDING` proposals | `WITHDRAWN` |
| `PENDING` proposals on their needs | `DECLINED` |

The last row is the one that is easy to miss. Leaving those pending would let
a requester accept a proposal from somebody who can no longer sign in, and
create a deal that could never move.

#### Afterwards

The account cannot sign in, and cannot be signed in as: `POST /auth/login`
answers exactly as it does for an address nobody has registered, and any
session that somehow survived is refused on its next request. `GET /users/:id`
answers `404`, identically to an id that never existed (#65). A moderator can
still find the account through `GET /admin/users` (#67) — that is what the
status filter is for.

### `PATCH /me/profile`

`AUTH`. **No `:id`**, and that is the whole authorisation story: there is no
path for "edit somebody else's profile" to arrive on, so there is no ownership
check to forget. Compare `PATCH /needs/:id`, where the id is in the path and the
service has to say *only the requester* out loud.

```json
{ "displayName": "Anna B", "bio": "Ask me about Tokyo.", "city": null }
```

| Field | Rule |
|---|---|
| `displayName` | 1–50 characters after trimming |
| `bio` | 1–500 characters, or `null` |
| `countryCode` | Two letters, ISO 3166-1 alpha-2, uppercased — `"fi"` becomes `"FI"` |
| `city` | 1–80 characters, or `null` |

Every field is optional, and the two nullable ones distinguish three requests:

| The request | Means |
|---|---|
| The key is absent | Leave this field as it is |
| `"bio": null` | Empty it |
| `"bio": ""` | `422`. Emptying is `null`; a column that holds `""` is a field nobody decided about |

An empty body is accepted and changes nothing: a `PATCH` that mentions no
fields is a request to change no fields, not a mistake.

Unknown fields are dropped, as everywhere else, so a request cannot reach
through this and set `userId`, `role` or `status`. Two of the drops are worth
naming:

- **`avatarUrl`**. An avatar is an upload, `PUT /me/avatar`; accepting a URL here
  would point the site's image tags at a server we do not control.
- **`email`**, because changing an address means proving the new one. That is
  `POST /auth/verify-email`'s flow, not a profile edit.

Returns `200` with the profile as it now stands in the database — not as it was
sent:

```json
{
  "profile": {
    "displayName": "Anna B",
    "bio": "Ask me about Tokyo.",
    "countryCode": "EE",
    "city": null,
    "avatarUrl": null
  }
}
```

The same five fields, in the same shape, as the `profile` object inside
`GET /auth/me`, so a client needs one reader for both.

### `PUT /me/avatar`

`AUTH`, and like `PATCH /me/profile` there is no `:id`: you can only ever set
your own. The request body **is** the image — no JSON, no form:

```js
await fetch(`${API}/me/avatar`, { method: "PUT", body: file, credentials: "include" });
```

| Rule | |
|---|---|
| Type | JPEG, PNG or WebP, read from the file's first bytes (`Files`, below). Anything else is `422` before an image decoder sees it |
| Size | At most 5 MB: `422`. A body over 10 MB is not read at all: `413` |
| Dimensions | At least 64 × 64: `422`. A file that starts like an image and is not one: `422` |
| Limit | 20 uploads an hour per user: `429` |

What is stored is **not** what was sent. The image is turned the right way up,
cropped to a square from its middle, scaled down to at most 512 × 512 (never
up), and saved as WebP with **no metadata**: a phone photo's GPS position, its
camera and its date are dropped. Every avatar is therefore a small square WebP,
whatever was uploaded.

Replacing an avatar deletes the previous one — its row and its bytes. Returns
`200` with the caller's profile, the same shape as `PATCH /me/profile`:

```json
{
  "profile": {
    "displayName": "Anna",
    "bio": null,
    "countryCode": "EE",
    "city": null,
    "avatarUrl": "/files/cm1f…"
  }
}
```

`avatarUrl` is a **path on this API**, not a link to the store. Put the API's
address in front of it, as for any other request; `GET /files/:id` then
redirects to a signed link that works for five minutes. Storing the path is
safe; storing the link it redirects to is not.

### `DELETE /me/avatar`

`AUTH`. No body. Removes the avatar — row and bytes — and returns `200` with
the profile, `avatarUrl` now `null`. Having no avatar already is not an error:
the answer is the same.

## Needs

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/needs` | — | Filters: `buyCountry`, `deliverCountry`, `categoryId`, `q`. Only `OPEN` |
| GET | `/needs/:id` | — | Public |
| POST | `/needs` | AUTH | Limited to 5 open needs per account |
| PATCH | `/needs/:id` | AUTH | Owner only, `DRAFT` or `OPEN` only |
| DELETE | `/needs/:id` | AUTH | Owner only, no live deal. Closes it; the row stays |
| GET | `/me/needs` | SESSION | Includes non-public statuses |
| POST | `/needs/:id/photos` | AUTH | The image as the body. Owner only, `DRAFT` or `OPEN` only, at most 6 |
| DELETE | `/needs/:id/photos/:photoId` | AUTH | Owner only, `DRAFT` or `OPEN` only |

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
  "items": [
    {
      "id": "cm1…",
      "title": "Japanese sunscreen, 50 ml",
      "coverPhoto": "/files/3f1c…",
      "…": "…"
    }
  ],
  "nextCursor": "MjAyNi0wOS0yM1QxMDoxMjozMy4wMDBafGNtMWFiYw"
}
```

`coverPhoto` is the first photo of that need, as a path, or `null` when it has
none — never absent, so a card with no picture is a case the client draws
rather than guesses at. One picture per card, not the whole set: the ids are
for deleting photos, which happens on the need's own page. The whole page's
covers cost one query, however many needs are on it (#81).

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

The need carries its photos, oldest first — the order they were added:

```json
{
  "need": {
    "id": "cm1…",
    "title": "Japanese sunscreen, 50 ml",
    "photos": [{ "id": "3f1c…", "url": "/files/3f1c…" }],
    "…": "…"
  }
}
```

`photos` is `[]` when there are none. A photo follows its need: whoever got
this answer may follow those paths, and whoever may not see the need cannot see
them either, which is one rule rather than two.

### `GET /me/needs`

`SESSION`. The caller's own needs, every status, newest first, paged exactly
like the public list, each with the same `coverPhoto` as the public list. This
is where someone finds their drafts.

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

### `POST /needs/:id/photos`

Version 2 (#81). The body **is the image** — no JSON, no multipart:

```js
fetch(`/needs/${id}/photos`, { method: "POST", body: file });
```

Returns `201` with the photo and the path that serves it:

```json
{ "photo": { "id": "3f1c…", "url": "/files/3f1c…" } }
```

| Rule | |
|---|---|
| Who | The owner, and only while the need is `DRAFT` or `OPEN` |
| How many | **6 per need.** The seventh is `409`, naming the limit |
| Size and type | The shared upload rules under [Files](#files): at most 5 MB, JPEG, PNG or WebP, read from the first bytes |
| Smallest | 200 px on the shorter side, or `422` |
| Shape | At most 3 times longer than wide, or `422` |
| Stored as | WebP, at most 1280 px on its **long** edge, aspect kept, no metadata |

**A product photo is not cropped.** An avatar is squared off because a face
fits a square; crop a photo of a bottle and you throw away the bottle. So only
the long edge is capped and the shape is kept, and a picture smaller than that
is left at its own size rather than blown up.

**Which is why a shape beyond 3:1 is refused rather than resized.** A
scrolling screenshot of 1080 × 6000 capped on its long edge would be 230 ×
1280, and the small print — usually the whole reason for sending such a picture
— would be gone. Refusing says so and asks for a crop; 3:1 is wider than
anything a camera or a single phone screen produces, and it means nothing
accepted is ever stored narrower than about 426 px. The reasoning, and the
three alternatives weighed against it, are in
`docs/10-decisions/0013-need-photos-keep-their-shape.md`.

**Rate limited to 40 an hour, per signed-in user** (`RATE_LIMITS.needPhoto`).
Every upload is decoded, resized and re-encoded, which is the most expensive
thing this API does. A refused upload still spends budget, for the reason
`POST /conversations/:id/messages` gives: the limiter runs before the handler,
or a flood of invalid requests would be free.

The limit of six is enforced **under a lock on the need's row**, not by
counting and then inserting. Re-encoding sits between those two steps, so two
uploads at five photos would both count five and the need would end with seven
— the same check-then-act race `POST /reports` describes, answered the same
way: the database decides. A refused upload leaves nothing behind, not even
bytes nobody can see.

### `DELETE /needs/:id/photos/:photoId`

Returns `204`. Row and bytes both go.

The photo must belong to **this** need: a photo id from another need, even
another need of your own, answers `404`. Deleting the same photo twice answers
`404` the second time — **deliberately unlike `DELETE /needs/:id`,
`DELETE /helps/:id` and `DELETE /me/avatar`, which answer `204` again.** Those
describe a state ("this need is closed", "I have no avatar") and the second
request wants the state the first one reached. A photo id names one particular
picture, and once it is gone the id names nothing; a `204` would claim
otherwise. A client that double-clicks should treat this `404` as "already
done" rather than as an error worth showing.

Allowed only while the need is `DRAFT` or `OPEN`, the same as adding one and
the same as editing the need's words: once it is `MATCHED`, somebody has agreed
to shop for what the pictures showed.

### Who may change a need

Adding and removing photos answers exactly as editing the need does, because it
is the same rule in the same function (`loadEditableOwnNeed`):

| Case | Response |
|---|---|
| Not signed in | `401` |
| Email not confirmed, or account suspended | `403` |
| Someone else's need | `403` |
| No such need | `404` |
| Need is not `DRAFT` or `OPEN` | `409` |

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

The same is true after a **cancelled deal**: the need reopens and other
helpers may propose, but the helper whose deal was cancelled may not. That
was challenged and upheld in `docs/10-decisions/0009`.

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
| GET | `/deals/:id/events` | AUTH | The history alone, oldest first, with who did each step |
| POST | `/deals/:id/receipts/:kind` | AUTH | The file as the body. `kind` is `product` or `shipping`. Helper only, at most 3 of each |

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
| `MATCHED`, `QUOTE_AGREED` | `CANCELLED` | Either side, or a moderator | `note` |
| `PRODUCT_PAID`, `PURCHASED` | `CANCELLED` | Either side | `note` |
| `PRODUCT_PAID`, `PURCHASED`, `SHIPPED` | `DISPUTED` | Either side, or a moderator | `note` |
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

**"Either side" means either side of the deal** — the requester or the helper.
Where a row says "or a moderator" it means all three may ask, and that is only
two rows: ending a deal nobody has paid for, and freezing one somebody has
(#134, decision 0030). A moderator still cannot confirm a parcel, agree a
quote, or cancel a deal that has reached `PRODUCT_PAID` — for that they
freeze it and end it from `DISPUTED`, which leaves two events and two notes
behind instead of one click.

**When a deal is ended after money has moved**, both sides are emailed the
note and told that Farhand holds no money, so anything already sent is between
them. Nothing in the API moves money or records who owes whom: there is no
such field, deliberately (decision 0004).

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

### `GET /deals/:id/events`

The deal's history, **oldest first**, paged. `AUTH`, and the same people as
the deal itself: its requester, its helper, and moderators. Anybody else gets
`404`.

```json
{
  "items": [
    {
      "id": "cm1…",
      "fromStatus": null,
      "toStatus": "MATCHED",
      "note": null,
      "createdAt": "2026-09-14T10:02:11.000Z",
      "actor": { "id": "cm1…", "displayName": "Anna" }
    },
    {
      "fromStatus": "DELIVERED",
      "toStatus": "COMPLETED",
      "note": "Completed automatically after 14 days",
      "actor": null,
      "…": "…"
    }
  ],
  "nextCursor": null
}
```

**`actor` is `null` when nobody did it**: the sweep that completes a deal
fourteen days after delivery writes an event with no actor (see
`04-deal-lifecycle.md`). A client showing a history has to render that case,
so it is in the example.

**Why this exists when `GET /deals/:id` already embeds the same events.**
One thing: `actor` is a display name here, not only an id. A history is
something people read, and rendering "Anna marked it sent" from the embedded
log means resolving an id for every row. It is also paged, and it is the only
list in this section that runs oldest first — a history is read forwards, the
way it happened, like the moderator queue and unlike everything people browse.

A moderator reading somebody else's deal history is written to the application
log, as a moderator opening a conversation is (`07-trust-and-safety.md`). So
is a moderator reading the deal itself, which had been an unrecorded read
since #27. The deal's own two people are not logged; it is their deal.

### `GET /deals/:id`

One deal, with its quotes (newest first) and its full event log (**oldest
first** — a history reads forwards). For the deal's two people, and for a
moderator, who cannot judge a report without reading what it is about. Anybody
else gets `404`.

It also carries its receipts, oldest first, both kinds together (#82):

```json
{
  "deal": {
    "id": "cm1…",
    "status": "SHIPPED",
    "receipts": [
      {
        "id": "3f1c…",
        "kind": "product",
        "url": "/files/3f1c…",
        "uploadedAt": "2026-10-14T09:12:33.000Z"
      }
    ],
    "…": "…"
  }
}
```

Whoever may see the deal may see its receipts — there is no second rule, and
the paths are paths rather than signed links (decision 0012).

### `POST /deals/:id/receipts/:kind`

Version 2 (#82). The body **is the file**, as for the other two uploads:

```js
fetch(`/deals/${id}/receipts/product`, { method: "POST", body: file });
```

Returns `201` with `{ "receipt": { "id", "kind", "url", "uploadedAt" } }`.

| Rule | |
|---|---|
| Who | **The helper only.** The requester and a moderator get `403`; a stranger gets `404`, like everywhere else in this section |
| `kind` | `product` or `shipping`. Anything else is `422` |
| When | A product receipt from `PRODUCT_PAID`; a shipping one from `PURCHASED`. Both also in `DISPUTED`. Never in `COMPLETED` or `CANCELLED`, and never before the money is sent — otherwise `409` |
| How many | **3 of each kind**, counted separately. A fourth is `409` |
| Size and type | The shared upload rules under [Files](#files): at most 5 MB, and here a PDF is allowed as well as JPEG, PNG and WebP |
| Smallest image | 300 px on the shorter side, or `422` |
| Stored as | A photograph becomes WebP, at most 2000 px on its long edge, with no metadata. **A PDF is stored exactly as it arrived** |

**A receipt is allowed, never required.** `PRODUCT_PAID → PURCHASED` does not
check for one, and that is a decision rather than an omission
([0016](10-decisions/0016-receipts-are-evidence.md)): a receipt is evidence for
a dispute, not a gate, and requiring one would block an honest purchase over a
lost paper slip while inviting pictures of nothing from people who just want
the button to work.

**There is no way to delete one.** No endpoint, for anybody, including the
helper who uploaded it: a receipt is evidence in somebody else's dispute, so a
wrong one is followed by a right one and both stay. `DELETE /me` keeps receipts
for the same reason (#66).

**Rate limited to 20 an hour, per signed-in user** (`RATE_LIMITS.receipt`), and
a refused upload still spends budget — the limiter runs before the handler, as
it does for messages and photos.

Why the long edge is 2000 here and 1280 for a need's photo, and why a receipt
may be as long and thin as it likes while a photo may not: a receipt is nothing
but small print, and a till roll really is that shape
([0013](10-decisions/0013-need-photos-keep-their-shape.md) is the other half of
that argument).

### `GET /me/deals`

The caller's own deals, whichever side they are on, newest first, paged like
every other list here.

| Query | Meaning |
|---|---|
| `status` | One `DealStatus`. Anything else is `422` |
| `limit` | 1–50, default 20 |
| `cursor` | From `nextCursor` |

## Reviews

Version 2 (#83). A review is not feedback between two people who already know
what happened — it is a signal to the next stranger deciding whether to trade
with one of them. That is why it is public, why it hangs off a completed deal
rather than off a person, and why both sides of the same deal can write one.

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/deals/:id/review` | AUTH | Participant of a `COMPLETED` deal, once, before the window closes |
| PATCH | `/deals/:id/review` | AUTH | The caller's own, and only while it is still hidden |
| GET | `/users/:id/reviews` | — | Public. Published reviews about that person, newest first, paged |

### The blind window

**Neither side sees the other's review until both have written one**, and
**writing closes when the window does**:

```
deadline   the deal's COMPLETED event + 14 days
writable   before the deadline, and only once
visible    both sides have written, or the deadline has passed
editable   mine, and not yet visible
```

The second half is what makes the first half worth having. With a timer per
review instead, the second person could simply wait: say nothing, let an honest
two-star publish itself on day 15, read it, and answer with a revenge one-star
on day 16. Measuring from the deal means that by the time anybody can read, no
one can write. Both reviews also become visible at the same moment rather than
on two different days ([decision
0017](10-decisions/0017-reviews-are-blind-until-both-are-in.md)).

Fourteen days is the same number as the auto-complete sweep, and for the same
reason: it is this product's existing idea of how long somebody reasonably
takes to get round to something.

There is no column and no scheduled job behind any of this. "When did this deal
complete" is already in the event log, and the rest is that date and the clock.

### `POST /deals/:id/review`

```json
{ "rating": 4, "comment": "Bought exactly the right thing." }
```

| Field | Rule |
|---|---|
| `rating` | A whole number, 1–5. Also a CHECK constraint in the database, so the rule holds even if this route is bypassed |
| `comment` | 1–1000 characters, or `null`. Optional |

**The target is not in the body.** It is the other person in the deal, derived
by the service: a client that could name the target could name itself.

Returns `201` with the review, including `published: false` while the window
holds. Refusals:

| Case | Response |
|---|---|
| Not signed in | `401` |
| A deal the caller is not in | `404`, exactly as for a deal that does not exist |
| A moderator | `403` — they can read the deal; reviewing is for the two who traded |
| A deal that is not `COMPLETED` | `409` |
| After the deadline | `409` |
| A second review from the same person | `409`, refused by the unique index rather than by a look-first read (#19) |

### `PATCH /deals/:id/review`

The same body, and the same rules about what it may say. Allowed exactly as
long as the review is unpublished: until then it is a draft that only its
author can see, and afterwards it is a public statement somebody may have acted
on. `409` once published, `404` if the caller has not written one.

**Nothing deletes a review**, at any point, by anybody. There is no endpoint.

### `GET /users/:id/reviews`

Public and unauthenticated, like the profile beside it: a stranger is exactly
who this is for. Paged like every other list (`limit` 1–50, `cursor`), newest
first, and **published reviews only** — the window is a condition in the query,
not a promise the caller is trusted to keep.

A review whose author has since deleted their account reads as
`Deleted account`, because #66 blanks the profile rather than removing it. What
was said about the other person stays: it was true when it was written.

### A review a moderator has removed

It **keeps its place** in every list it was in, with `removed: true` and both
`rating` and `comment` as `null` — the same argument the contract makes for a
removed message: a hole that says "removed" is honest, one that closes up makes
the list read as though nothing was ever written. Its own author sees the same
thing; they know what they wrote, and showing it back would read as though it
were still standing.

It **counts for nothing**. Not in #84's average, not in the count beside it. If
a review was abusive or false enough to take down, its one star is very likely
part of the same abuse, and leaving it in would let somebody damage a
reputation from behind a review nobody can read.

Those are two rules, deliberately — `publishedWhere` decides what is listed,
`countedWhere` decides what is averaged
([decision 0018](10-decisions/0018-a-removed-review-keeps-its-place.md)). A
profile will therefore say *"5.0 from 3 reviews"* above a list of four. The
number and the list disagree, and the tombstone in the list is what explains
the difference.

**A removal never unpublishes anything.** "Both sides have written" is a fact
about the past, so a removed review still completes the pair that published the
other one. Otherwise there is a trick: write something abusive about the person
you expect to review you badly, get it removed, and their honest review of you
disappears until the deadline.

`GET /deals/:id` also carries `reviews`, and that list is assembled per caller:
your own always, published or not, because you are the only person who may read
it inside the window — and the only one who can still change it.

## Reports and moderation

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/reports` | AUTH | Target type and id, reason, details |
| GET | `/admin/reports` | MOD | Queue, oldest first, filter by status, target type and reason |
| GET | `/admin/reports/:id` | MOD | One report, with the thing it is about |
| POST | `/admin/reports/:id/resolve` | MOD | Resolution note required |
| GET | `/admin/users` | MOD | Find an account by email or display name, filter by status, paged |
| POST | `/admin/users/:id/actions` | MOD | Warn, suspend, ban, reactivate; reason required |
| POST | `/admin/content/:type/:id/remove` | MOD | Hide a need, offer, message or review |
| DELETE | `/admin/users/:id` | MOD | Erase a **banned** account on its owner's behalf; reason required |

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
| `targetType` | `USER`, `NEED`, `HELP`, `MESSAGE` or `REVIEW`. The list comes from the schema, not from a copy in the route (#125) |
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

### `GET /admin/users`

`MOD`. Finding a person, for a moderator who already has some idea who they
are looking for.

| Query | Meaning |
|---|---|
| `email` | **Exact match**, trimmed and lowercased first |
| `q` | Part of a display name, ignoring case. At least two characters |
| `status` | `ACTIVE`, `SUSPENDED`, `BANNED` or `DELETED` |
| `limit` | 1–50, default 20 |
| `cursor` | From the previous page's `nextCursor`. Newest account first |

An absent filter narrows nothing, and the filters combine: all of them must
match.

**`email` is exact and `q` is partial, and that asymmetry is the point.** An
email address is something you look an account up *by* — you have it already,
out of a report or a complaint. Matching it partially would make this a
different tool: `?email=@gmail.com` returning every Gmail user in the
database, twenty at a time, for as long as somebody kept turning pages.
`07-trust-and-safety.md` lists scraping personal data as a risk, and a
moderator account is not exempt from being the thing that leaks.

```json
{
  "items": [
    {
      "id": "cm1…",
      "email": "anna@example.com",
      "displayName": "Anna",
      "countryCode": "EE",
      "role": "USER",
      "status": "ACTIVE",
      "suspendedUntil": null,
      "emailVerified": true,
      "createdAt": "2026-03-04T09:12:00.000Z"
    }
  ],
  "nextCursor": null
}
```

**This is the only endpoint in the API that returns an email address.**
Everywhere else there are none at all, deliberately — `GET /users/:id` shows a
display name and a country and nothing that identifies a person off Farhand
(#65). A moderator holding a complaint about `anna@example.com` has to be able
to reach that account, so the exception exists, and it is worth knowing that
it is the only one. The password hash is never returned.

**It stayed the only one by being checked.** `GET /admin/reports/:id` returned
the whole `User` row for a report about a person until #95, which made it a
second endpoint answering with an address — and with the hash this paragraph
says is never returned. A report's target is now a shape; the search is the one
door, and it is the one that logs who went through it.

**Deleted and banned accounts are included.** They answer `404` from every
public endpoint, and they are exactly what a moderator checking whether a ban
was fair needs to find.

**Every search is logged**: who searched, whether it was by email, the filters
they used, and `resultCount` — how many rows came back. The count matters: one
lookup and somebody paging through the whole table look identical without it.

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

`type` is `NEED`, `HELP`, `MESSAGE` or `REVIEW`; `USER` is `422`, because an
account is banned rather than removed. The body is `{ "reason": "…" }`,
required.

A need or an offer becomes `REMOVED`; a message or a review keeps its row and
gets `removedAt`, so what was there still shows and its words are gone (#21,
#125). Removing something twice is `409` — it is already gone, and a second
entry in the log would suggest it had come back.

The `AdminAction` records **both** halves: `targetUserId` is whose account it
was about — the need's requester, the offer's helper, the message's sender, the
review's **author** — and `contentType`/`contentId` are what was actually taken
down. A log that cannot answer "what did you remove?" is not an audit log.

### `DELETE /admin/users/:id`

```json
{ "reason": "Erasure requested by email, 18 October" }
```

Returns `204`. The body is required, and the reason is the only place the
request will ever be recorded — the account it refers to is about to stop
saying who it was.

**Why this exists.** `DELETE /me` needs a session and a ban stops sign-in, so
the people most likely to want erasure were exactly the ones who could not ask
for it, and there is no support inbox (#88, and a risk `11-risks.md` carried
from #66 until this closed it). How somebody asks, in practice: since #86 a
ban is emailed to the person it is about, and that email ends by inviting a
reply.

**Banned accounts only.** An `ACTIVE` or `SUSPENDED` account is `409` naming
`DELETE /me`, because anybody who can sign in can erase themselves —
`DELETE /me` is marked `SESSION` for exactly that reason (#66). The power is
deliberately no bigger than the hole: a moderator who could erase any account
at all is a larger thing than this was for.

| | |
|---|---|
| Not banned | `409`, and the message names `DELETE /me` |
| Already erased | `204`, and **no second audit entry** — nothing happened |
| Themselves, or an equal or higher role | `403`, the rule a ban already follows, and a stronger case: a ban can be lifted |
| A deal still running | `409`, naming how many. The same refusal as `DELETE /me`, for the same reason |
| Unknown id | `404` |

**It is the same erasure as `DELETE /me`**, not a second one: anonymised and
kept, the profile blanked, sessions and tokens deleted, listings closed,
photos deleted and **receipts kept** (#66, decision 0016). The two paths share
one function for that reason, and a test runs both and compares what they
leave behind.

**It writes an `AdminAction` of type `ERASE_ACCOUNT`** (#27). Unlike reading a
file, this is a decision — and it is the one decision whose subject cannot be
asked about afterwards, because the row it points at no longer names anybody.

**No email is sent.** There is nowhere to send one: the address is anonymised
in the same breath, and #86's queue would skip a notification to a deleted
account anyway.

### `GET /admin/reports/:id`

One report with the thing it is about: the need, the offer, the message, the
review, or the person. #26's queue held a type and an id and nothing else, so
a moderator could see that something was reported but not what.

A target that has since been deleted comes back as `null` rather than an error,
or the queue would jam on a row nobody could close.

A reported **person** comes back as named fields — a row of `GET /admin/users`
above, without the email address:

```json
{
  "target": {
    "id": "cm1…",
    "displayName": "Yuki",
    "bio": null,
    "countryCode": "JP",
    "avatarUrl": "/files/cm1f…",
    "role": "USER",
    "status": "ACTIVE",
    "suspendedUntil": null,
    "emailVerified": true,
    "createdAt": "2026-03-04T09:12:00.000Z"
  }
}
```

**No password hash, and no email address** (#95). Until #95 this target was the
`User` row itself, which carried both. The hash was a bug. The address is a
decision, written down in [decision 0024](10-decisions/0024-a-moderators-view-of-a-person.md):
the search stays the **only** endpoint that returns one, because it is the one
that records who looked, and a report carrying an address would be an unlogged
second door beside the logged one. A moderator who needs to reach the account
searches for the display name this view gives them, and that search is logged.

`bio` is here, and it is one of two fields this shape adds to the search's: it
is the only prose a person writes about themselves, so a `HARASSMENT` or
`SEXUAL_CONTENT` report about a **person** rather than a listing is usually a
report about that paragraph — and `GET /users/:id` answers `404` once the
account is banned, so there is nowhere else left to read it. `city` is not here,
for the reason it is in no other reply either, and neither is `lastLoginAt`.

`avatarUrl` is the other, added by #139, and for the same reason one step
further on: the other thing a report about a person is usually about is the
picture. A path on this API, `null` when there is none, and the only place a
moderator is ever handed an avatar's id — the matching permission is in
[Files](#files), where a banned account's avatar is a moderator's to open and
nobody else's.

**A banned or deleted account is still shown.** Like the search, and unlike
every public view: a resolved report is read again by somebody else later, and
a report whose subject has become invisible cannot be checked.

A reported **need** comes with its `photos`, the same field `GET /needs/:id`
gives (#81). It is the only place a moderator is handed a photo id, and the
pictures are usually what a `PROHIBITED_ITEM` report is about; the matching
permission is in [Files](#files).

A reported **review** comes back **as it was written**, with its rating, its
comment and its `removedAt` — even after it has been removed, when every other
reader sees those two fields as `null` (#125). The row is kept as evidence, and
evidence the only permitted reader cannot read is not evidence. This is the one
place in the API where a removed review's words appear.

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

## Your data

Version 2 (#89). `docs/07-trust-and-safety.md` has promised this since version
1, and it is the other half of `DELETE /me`: erasure answers "forget me",
portability answers "give me a copy first".

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/me/exports` | SESSION | Asks for a copy. `202`, built in the background |
| GET | `/me/exports/:id` | SESSION | The JSON, once it is ready. `409` while building, `410` once expired |

### `POST /me/exports`

No body. Returns `202`:

```json
{ "id": "cm1…", "status": "PENDING", "requestedAt": "2026-10-20T11:00:00.000Z" }
```

`202`, not `200`: the answer is "asked for", not "here it is". Reading
somebody's whole history is a dozen queries, so it happens in the job queue
(#85) rather than inside the request — a request that takes a second is a
request people press twice.

**One at a time.** A second request while the first is still being built is
`409`, or a loop of requests is a loop of full-history queries nobody asked
for. A pending request stops blocking after an hour, because a job that gave
up after its five attempts would otherwise lock somebody out of their own data
for good.

`SESSION`, not `AUTH`, and the same reasoning as `DELETE /me`: what you may do
about your own data does not depend on the state of your account. An
unverified or suspended person is still entitled to a copy — and because the
export is handed to a session rather than emailed, nothing is sent to an
address nobody has proved they own.

### `GET /me/exports/:id`

Returns `200` with the export as JSON, and
`Content-Disposition: attachment; filename="farhand-export-<id>.json"` so a
browser saves it rather than painting somebody's whole history onto a screen.

| | |
|---|---|
| Still being built | `409` — ask again in a moment |
| Expired (seven days after it was ready) | `410 GONE` — ask again from the start |
| Somebody else's, or unknown | `404`. An export you may not read is one you may not know exists |

Ownership is checked on the **row**, not on the path, and a moderator cannot
read one either: moderators read a deal, a conversation or a receipt when they
have to judge something, and nobody needs to read a person's whole history.

### What is in it, and what is not

The sections are one per table — `account`, `profile`, `needs`, `helps`,
`proposals`, `deals` (with their events and quotes), `conversations` (with
their messages), `reviewsWritten`, `reviewsReceived`, `files`, `moderation`,
`reportsFiled`, `notifications`, `sessions` — plus a `notIncluded` section
that says in words what was left out and why.

**Everything in Farhand is two people's data**, so the rule is
([decision 0023](10-decisions/0023-an-export-is-one-persons-copy.md)):

| | |
|---|---|
| Their own rows | In full |
| Rows about them | In full — a review they received, a moderator's decision about their account |
| The other person | Their public display name, and their words **where those words were sent to this person**: a message you received is in your possession the way a received email is. Never their address, never their private profile fields, never a row from a conversation you were not in |
| Secrets | Never. No password hash, and no session or token hashes — a hash of a live credential is still a credential's fingerprint, and this is a file people forward |
| Moderator identities | Not included. A decision about the account is there with its reason; which moderator took it is not, because they were acting in a role |
| File bytes | Not included. Photographs and receipts are listed by type, size and date; the images came from the person's own device |

**It expires after seven days**, and the payload is destroyed by the daily
sweep (`npm run job:sweep-exports`, scheduled beside the deal sweep). The row
stays, because "an export was made, and when" is itself something somebody may
ask about — and it is two timestamps rather than a copy of their life.

## Prohibited items

Version 2 (#87). The list Farhand will not carry, and the tick that says
somebody read it. `docs/07-trust-and-safety.md` puts this first among the
defences against prohibited or illegal items — reports and moderation are what
happens after something has been posted, and this is the only one that happens
before.

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/prohibited-items` | — | The published list, and the version to tick against |

### `GET /prohibited-items`

Public: no session is read. Somebody deciding whether Farhand is any use to
them should be able to read what it refuses to carry before they have an
account, and a client has to fetch the version before it can show the form
that sends it back. Returns `200`:

```json
{
  "version": "3f9ac1b27d40e5aa",
  "items": [
    { "slug": "weapons", "text": "Weapons, ammunition and parts" },
    { "slug": "drugs", "text": "Drugs, including prescription medicines" }
  ]
}
```

No paging: it is a short list and the whole thing is the answer.

**`version` is a fingerprint of the wording, not a number somebody maintains.**
It is a hash of the published lines — their slugs, their text and their order —
so it changes by itself when the list is edited, and it cannot be left stale by
somebody who reworded a line and forgot to bump a counter. `slug` is permanent
and is what code should match on; `text` is what a person reads and may be
reworded at any time.

**The list lives in a table, not in the code**, so a clause can be changed
without a deployment — the same reasoning
`docs/07-trust-and-safety.md` gives for the sanctioned-country list. A line is
retired rather than deleted, because acknowledgements already recorded refer to
the wording it had.

### Acknowledging it

`POST /needs`, `PATCH /needs/:id`, `POST /helps` and `PATCH /helps/:id` take a
`prohibitedVersion`, and require it **at the moment the listing becomes
public**:

| What is being asked for | Is the tick required? |
|---|---|
| `POST /needs` with `status: "OPEN"` | Yes |
| `POST /needs` with `status: "DRAFT"` | No — nobody can see a draft |
| `PATCH /needs/:id` moving `DRAFT` → `OPEN` | **Yes** |
| `PATCH /needs/:id` editing a need that is already open | No — already ticked |
| `PATCH /needs/:id` moving `OPEN` → `DRAFT` | No |
| `POST /helps` with `status: "ACTIVE"` | Yes |
| `POST /helps` with `status: "PAUSED"` | No |
| `PATCH /helps/:id` moving `PAUSED` → `ACTIVE` | **Yes** |

The two rows in bold are the point. "Posting requires acknowledging" sounds
like a rule about `POST`, and it is not: both kinds of listing can be created
in a state nobody else can see and published later with a `PATCH` whose fields
are all optional. Saving a draft and then publishing it would otherwise put a
public listing in front of people having acknowledged nothing — and a client
would do it without meaning to, because that is simply what publishing a draft
looks like.

The answers:

| | |
|---|---|
| Missing when it is required | `422 VALIDATION_FAILED`, naming `prohibitedVersion` |
| Not the current version | `409 PROHIBITED_LIST_CHANGED`, with the current list in `details` |
| The current version | The listing is created or published, and the version is recorded on it with the time |

```json
{
  "error": {
    "code": "PROHIBITED_LIST_CHANGED",
    "message": "The prohibited list has changed since you read it",
    "requestId": "…",
    "details": {
      "version": "a91fc0d4e7b21188",
      "items": [{ "slug": "weapons", "text": "…" }]
    }
  }
}
```

The refusal carries the new list so that a client can show what changed and ask
again, rather than guessing what it missed. The cost is a rare, annoying
re-tick when the list is edited while somebody is filling in a form; what it
buys is a record that always refers to wording the person actually saw.

**What is recorded is a fingerprint, not a boolean**: the listing keeps the
version it was posted against, so when a clause is reworded afterwards, "what
did this person agree to" is still answerable. A need's or a help's
`prohibitedVersion` and `prohibitedAckAt` are null only while it has never been
public.

**It is a tick against wording, not a promise about the item.** Nothing here
inspects a listing: a need for a prohibited item is accepted, recorded, and
left to reports and moderation. There is no automatic detection, and
`docs/11-risks.md` says so rather than implying otherwise. What the
acknowledgement does is remove "I didn't know", give a moderator something to
point at, and put the rules in front of somebody at the one moment they are
deciding what to post.

## Notifications

Version 2 (#86). Email that arrives because something happened, rather than
because somebody asked for it — and the switch that stops it.

| Method | Path | Auth | Notes |
|---|---|---|---|
| PATCH | `/me/notifications` | SESSION | One switch: `emailNotifications` |

### `PATCH /me/notifications`

```json
{ "emailNotifications": false }
```

Returns `200` with the setting as it now is:

```json
{ "emailNotifications": false }
```

`.strict()`, like every body here: an unknown field is a `422` rather than a
`200` that did nothing. Asking for the state it is already in is the same
`200` — the caller asked for a state, and that is the state.

**`SESSION`, not `AUTH`, and that is the decision rather than an oversight.**
`AUTH` adds `requireVerified` and `requireActive`, which between them refuse an
unverified account and a suspended one — the two people most likely to want the
email to stop. "Confirm your email address before you may ask us to stop
emailing you" is not a sentence this API sends. `DELETE /me` is marked the same
way for the same reason (#66): what you may do to your own account does not
depend on the state of it.

**The switch is here and not in the email, deliberately.** Our provider's
unsubscribe applies to every message it sends on our behalf, verification and
password resets included, so one click on a notification would lock somebody
out of their own account recovery
(`docs/10-decisions/0015-living-with-a-transactional-unsubscribe.md`). Until
Farhand has a domain of its own and a provider that separates the two streams
(#93), the only safe place for "no thank you" is inside the product. Every
notification says so in its last line.

### What sends an email, and what deliberately does not

The rule, and the whole list follows from it: **email when the recipient must
do something, or has lost the chance to — never as an activity feed.**

| What happened | Who hears |
|---|---|
| Somebody offered to help with your need | The requester |
| A requester approached you about their need | The helper |
| Your offer was accepted | The helper |
| A quote arrived | The requester, whose move it is to agree it |
| The deal moved and the next move is yours | Whoever that is, unless they just moved it themselves |
| The deal was cancelled | The other side |
| A dispute was raised | The other side |
| A moderator resolved a dispute | Both sides, since neither of them did it |
| The deal completed | Both sides — the fourteen-day review window is news to the person who pressed it too |
| A moderator acted on your account or your content | The person it was about, **whatever their preference says** |
| Something matched a search they saved | The person who saved it, unless they posted it themselves (#90). The one line here that is not "you must do something", and the exception is argued in `docs/10-decisions/0026-the-one-email-somebody-asked-for.md` |

And the silences, which are decisions and not gaps:

| What happened | Why nothing is sent |
|---|---|
| Somebody reviewed you | Reviews are blind until both are in (decision 0017). "Yuki reviewed you" tells you they went first, which is the pressure the blind window removes |
| A message arrived in a deal | The one most people expect, and the one that turns an inbox into a chat. It needs a digest and a quiet period, which is its own issue |
| A proposal was declined or withdrawn | Nothing is waiting for the helper, and an email saying "no" invites a reply nobody reads |
| `PRODUCT_PAID`, `PURCHASED`, `DELIVERED` seen from the side that did not act | Nothing is waiting for them either; the deal page is where that belongs |
| Anything you did yourself | Nobody needs an email about the button they just pressed |
| A need expiring | Arguable, and the kind of email that teaches people to ignore us. Not in version 2 |

One event sends **one** email: a `Notification` row records it, keyed on what
happened — a deal event, a proposal, a moderator's action — and the database
refuses the second. The record also answers what was sent and when, and says
when something was deliberately not sent (the account went, or the preference
changed between the event and the sending). The reasoning is
`docs/10-decisions/0020-what-is-worth-an-email.md`.

Sending happens in #85's job queue, seconds after the request that caused it,
so no request waits for a mail provider and no request's timing says who
exists. **There are no links in these emails**, for #119's reason: `APP_ORIGIN`
is still the API's own address because there is no frontend (#93), so every
notification names the need it is about instead.

## Saved searches

Version 2 (#90). A standing query over one of the browse lists, and being told
when something matches it.

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/me/searches` | AUTH | Ten per account. `409` at the limit |
| GET | `/me/searches` | AUTH | The caller's own, newest first. No paging |
| DELETE | `/me/searches/:id` | AUTH | `204`. Somebody else's is `404` |

### `POST /me/searches`

```json
{
  "kind": "NEED",
  "name": "Sunscreen to Estonia",
  "notify": true,
  "filters": { "buyCountry": "JP", "deliverCountry": "EE", "q": "sunscreen" }
}
```

| Field | Rule |
|---|---|
| `kind` | `NEED` or `HELP` — which list the search stands over |
| `name` | 1–80 characters. What the person calls it; it is never in an email |
| `notify` | Default `true`. Whether a match emails, per search |
| `filters` | The browse endpoint's own query names, for that kind. May be `{}` |

**The filters are the browse endpoints' own names**, so a client can save the
query string it is already running: `buyCountry`, `deliverCountry`,
`categoryId` and `q` for a need (`GET /needs`); `country`, `shipsTo` and
`categoryId` for an offer (`GET /helps`). The object is `.strict()` **per
kind**, so a `country` sent for a need search is a `422` rather than a search
that quietly ignores half of what was asked for — somebody waiting on a filter
that was dropped is waiting for a narrower search than the one that exists.

Returns `201` with the search as it was stored, read back in the same words:

```json
{
  "search": {
    "id": "cm1…",
    "kind": "NEED",
    "name": "Sunscreen to Estonia",
    "notify": true,
    "filters": { "buyCountry": "JP", "deliverCountry": "EE", "q": "sunscreen" },
    "createdAt": "2026-10-21T09:12:00.000Z"
  }
}
```

A filter that was not set is **absent**, not null: the object is what was
asked for, and a list of nulls is a list of questions nobody asked.

**An empty `filters` is allowed** — "tell me about everything" is a thing
somebody may want on a small marketplace, and the per-account limit is what
stops it becoming a hundred standing queries. An unknown `categoryId` is a
`400`, the same answer a need filed under one gets.

**Ten per account**, and the eleventh is a `409` naming the number — the same
refusal as the open-needs limit, and for the same reason: the problem is the
state, not the shape of the request.

**`AUTH`, not `SESSION`.** The thing a saved search does is send email, and an
unverified address is one nobody has proved they own. This is the opposite
decision from `PATCH /me/notifications`, which is `SESSION` precisely so that
anybody can stop email; starting it is the half that needs a proved address.

**There is no `PATCH`.** Renaming a standing query or switching its email off
is a delete and a save. Version 2 scope does not grow either.

### `GET /me/searches`

```json
{ "items": [ … ] }
```

The caller's own, newest first, no cursor: ten is the whole list, and a page of
ten with a cursor nobody can use is machinery pretending to be a rule.

### `DELETE /me/searches/:id`

`204`. Somebody else's search, and an id that never existed, both answer `404`
— the rule #79 set for files: a row you may not read is one you may not know
exists.

Saved searches go when the account does (#66).

### What a match means

**When**: the moment a listing becomes public — posted openly, or a draft
published, or a paused offer reactivated. Exactly the four moments #87 asks
for the prohibited-list tick, because it is the same event.

**Where**: never in the request that published. The publish writes one row on
#85's queue and answers; the worker does the matching seconds later. A hundred
standing queries must not be a hundred comparisons inside somebody's `POST`.

**What matches**: every filter that is set must agree, and a filter that is not
set matches anything. `q` is matched against the need's title and description,
without case, the same comparison `GET /needs` makes from the other side. An
offer whose `shipsTo` is empty ships anywhere, so it matches any saved
destination — again the same rule as `GET /helps`.

**Who is told**: everybody whose search matches, **except the person who
posted it**. One email per person per listing, however many of their searches
caught it: the `Notification` row is keyed on the listing, so the second is
refused by the same unique index that stops a deal sending two.

**What stops it**: `notify: false` on the search, the account-wide switch
(`PATCH /me/notifications`), a banned or deleted account, or the listing
ceasing to be public before the worker composes the email — which is checked
again at that moment, because minutes can pass.

## Files

Version 2 (#79). A file's bytes live in private object storage
(`docs/10-decisions/0011-backblaze-b2-for-files.md`); the API holds a `File`
row describing them, and is the only way to reach them.

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/files/:id` | — | A `302` to a signed URL that expires in five minutes. Who may follow it depends on the file's purpose |

Uploads are not a generic endpoint. Each purpose arrives with its own, because
only it knows which need or deal the file belongs to: avatars (#80), need
photos (#81), receipts (#82). All of them share these rules:

| Rule | |
|---|---|
| Size | At most 5 MB. Empty is refused too |
| Type | Read from the file's first bytes, never from its name or `Content-Type`. Photos: JPEG, PNG, WebP. Receipts: those, or PDF |
| Refused | `422 VALIDATION_FAILED`, and nothing is stored — no row, no bytes |
| Storage key | Random. It names neither the file nor its owner |

### `GET /files/:id`

No body. The answer is a redirect:

```
302 Found
Location: https://…/files/3f1c…?X-Amz-Expires=300&X-Amz-Signature=…
Cache-Control: private, max-age=60
```

`<img src="/files/:id">` follows it without the page knowing. The signed URL
works for five minutes, and the browser may keep the redirect for one — less
than the signature it carries, so a cached copy can never point at a dead
one. `private`, because the answer depends on who asked. The bytes themselves
are never public: the same address without its signature is refused by the
store.

**This endpoint has its own rate limit**, not the global one: it is called
once per image, so a page of thirty photos is thirty requests. 600 a minute
per address (#102).

Who may see a file:

| Purpose | Visible to |
|---|---|
| `AVATAR` | Anyone, while the owner's profile is visible — the rule of `GET /users/:id`, so not once they are banned — **and moderators, whatever became of the account (#139)** |
| `NEED_PHOTO` | Whoever may see the need: anyone while it is `OPEN` or `MATCHED`, its owner always — and moderators, whatever its status (#81) |
| `PRODUCT_RECEIPT`, `SHIPPING_RECEIPT` | The two people in the deal, and moderators |

A file that does not exist and a file you may not see get the same
`404 NOT_FOUND`, `"File not found"`, so a receipt's id cannot be checked by
somebody it does not belong to.

**A moderator's read is written to the log** — the file, its purpose, and which
deal or need it belongs to (#82). Not an `AdminAction`: reading is not a
decision, and the same reasoning already governs a moderator opening a deal or
a conversation (#27). The deal's own two people are never logged; it is their
deal. This covers a need's photo too, which #81 allowed a moderator to see and
recorded nothing about.

The moderator case on a need's photo exists because `PROHIBITED_ITEM` is one of
`ReportReason`'s values and a report about a prohibited item is usually a
report about the picture. Without it, removing the need would hide the evidence
it was removed for — from the people who have to review that decision later.
The ids come from `GET /admin/reports/:id`, which carries a reported need's
photos; nothing else shows a moderator a photo id, so the two halves only work
together.

**An avatar is the same case, and #139 closed it late.** `ReportTarget` has
`USER` and `ReportReason` has `SEXUAL_CONTENT`, so a report about a profile
picture is a thing this API accepts — and a ban is what a moderator does about
one. Until #139 the ban hid the picture from everybody, the moderator who had
just acted included, so nothing was left to review the decision against. The
rule is now the same shape as the other two: everybody while the account is
live, and otherwise a moderator. Its two halves work together the same way too
— the id comes from the reported person's `avatarUrl` in
`GET /admin/reports/:id`, and nothing else hands a moderator an avatar's id.

A moderator reading a **live** account's avatar is not logged: it is a public
picture, and a log full of those would bury the lines that mean something.

The API does not ask the store whether the bytes still exist before
redirecting — that would be a request to the store on every image shown. If
they have vanished, the signed URL answers `404` from the store; the API never
answers `500` for it.

When an account is deleted (`DELETE /me`), its avatar and need photos are
deleted, rows and bytes. Its receipts stay: they are evidence in a deal the
other person is part of, kept for the same reason the deal's messages are.

## Not in version 1

Reviews, notifications, saved searches, real-time messaging. See
`08-scope.md`. Uploads arrived in version 2, above.
