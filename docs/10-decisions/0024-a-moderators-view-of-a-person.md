# 0024 — A moderator's view of a person is a shape, not a row

## Context

`GET /admin/reports/:id` answered a report about a person with the `User` row.
`getReportWithTarget` loaded it whole — `findUnique({ include: { profile:
true } })` — and the route answered `res.json(found)`. There is no global
serialiser between a service and a response in this project, deliberately, so
what the query loads is what the moderator receives: `passwordHash`, `email`,
and every other column.

Two sentences in `docs/06-api-contract.md` were false while that was true. "The
password hash is never part of any reply", and `GET /admin/users` being "the
only endpoint in the API that returns an email address" — the search was built
as the one controlled exception (#67): exact match only, paged, and every call
logged with who asked and how many rows came back. A report's target was a
second door beside it with none of that.

Nothing caught it. `tests/admin/user-search.test.ts` asserts the hash never
appears in a search response; the report tests asked only that the target was
not `null`, which a whole row satisfies perfectly. It was found by reading the
code while drafting #94, not by the suite — which is the part worth keeping in
mind: the assertion existed, one file away, and the endpoint it was written for
was not the endpoint that needed it.

## Decision

**A person in a moderator's response is a named shape.** `ReportedUser` is a
row of the search, minus the email, plus `bio` — and it is built the way
`getPublicProfile` is built (`src/services/profiles.ts`): named columns in the
`select`, then named fields again on the way out. The first makes the secret
unloadable; the second still holds the day somebody widens the select.

**No email address, and that is a decision rather than the same bug twice.**
The search remains the only endpoint that returns one, because the search is
the one that records who looked. An address in a report's target would be an
unlogged second door, and the asymmetry #67 was argued around — exact match,
never partial — would mean nothing if a second endpoint handed addresses out by
id. A moderator who has to reach the account searches for the display name this
view gives them, and that search is logged.

**`bio`, because it is evidence.** The one field added to the search's shape. A
bio is the only prose a person writes about themselves, so a `HARASSMENT` or
`SEXUAL_CONTENT` report about a *person* rather than a listing is usually a
report about that paragraph — and `GET /users/:id` answers `404` for a banned
account (#65), so after the ban there is nowhere else to read it. The same
argument as #81's photos: evidence the only permitted reader cannot reach is
not evidence.

**`city` stays out**, for the reason it is in no other reply (#65: a display
name and a city are often enough to find a real person, and no report is judged
by one), and so does `lastLoginAt`.

**The other four target types keep their rows, and are pinned instead.** A
need, an offer, a message and a review come back as the rows they are, because
a moderator judging one wants everything about it, and `Need`, `Help`,
`Message` and `Review` hold no secrets today. The risk is tomorrow's column, so
a test records **every key at every depth** each of those targets returns
(`keysWithin`, `tests/helpers/http.ts`). A column added to any of those tables
fails that test instead of quietly arriving in a moderator's reply, and whoever
adds it decides then whether it belongs there. That tripwire is the thing #95
did not have.

## Alternatives

**Keep the email, and log the read.** The honest version of the convenient
option: a moderator opening a report about a person would have the address in
front of them, and the read would be recorded the way a search is. Rejected
because it buys very little and costs the simplest true sentence in the
contract. Everything a moderator *does* to an account — warn, suspend, ban,
erase — takes an id, not an address, and all of it is already recorded as an
`AdminAction`. The address is for reaching somebody outside Farhand, which is
rare enough to be worth one extra, logged step.

**Keep the email and log nothing.** The smallest diff, and exactly the state
#95 found: two endpoints returning addresses, one of them audited.

**A global response serialiser that strips `passwordHash` everywhere.** One
piece of middleware, and every leak of that one column closed at once. Rejected
twice over. It would have made this bug invisible rather than impossible — the
row would still be sent, minus one field, so `email`, `city` and every column
added later would carry on leaving the API unexamined. And a serialiser that
rewrites bodies on their way out makes a response something nobody can read off
the handler, which is the property that let this bug be *found* by reading the
code.

**Named columns for every target type.** The consistent version: an explicit
`select` and an explicit mapper in all five branches. Rejected as the larger
change that buys less — it duplicates shapes the public views already define,
and it makes every field a moderator ought to see an argument to have twice. The
pinning test gives the same protection against the next column without
pretending a moderator's view of a need is a different thing from the need.

**Narrow the reviewed person inside a reported review too.** That branch
already selects only `id` and `profile`, so no credential is in reach; what it
spreads is the `Profile` row, `city` and all. Left as it is, and pinned: a
moderator may know more than a stranger, and the one thing promised nowhere —
the email — is not in it.

## Consequences

- **A report no longer gets a moderator to an email address in one step.** The
  search cannot be narrowed by id, so the route from a report about a person to
  their address is: read the display name, search for it, match the id. Two
  steps, both of them logged where it matters. If that ever becomes real
  friction, the answer is an `id` filter on the search — which keeps the
  logging — and not a second endpoint that answers with an address.
- **`ReportedUser` is declared as `Omit<UserSummary, "email">`**, so the type
  itself says what it is. A field added to the search's shape appears here too,
  which is right for a status or a flag and would be wrong for a second
  identifier; the pinning tests make that visible the day it happens.
- **A banned account's avatar is still unreachable.** `isVisibleTo` admits a
  moderator to a need's photo (#81) but an `AVATAR` is visible only while its
  owner is `ACTIVE` or `SUSPENDED`, so a report about an obscene picture
  becomes unreadable the moment a moderator bans the account — #81's gap, in
  the one place it was not closed. This decision does not fix it; the target
  shape carries no `avatarUrl` at all, so nothing here hands out a path that
  would 404.
- **The suite now says what a moderator's reply contains**, in five places. It
  is a test that fails on purpose when somebody adds a column, which reads as
  noise until the column is one that should never have left the database.
