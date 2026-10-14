# Data model

The authoritative version is `farhand-api/prisma/schema.prisma`. This file
explains **why** each table exists. When the two disagree, the schema is right
and this file needs updating.

## Accounts

**`User`** — private account data: email, password hash, role, status. Never
returned to other users.

**`Profile`** — what a person writes about themselves: display name, country,
bio, city, avatar. Split from `User` so that returning a profile can never
accidentally leak an email address.

Public is per field, not per table. `GET /users/:id` answers with the display
name, the country, the bio and the avatar; the city stays visible to its owner
alone (`06-api-contract.md`).

The avatar is `avatarFileId`, a link to a `File` row (#80) — not a URL. A URL
would be either a signed link that dies in five minutes or a string the
database cannot check; a foreign key is neither. It is unique, because one
file is at most one person's avatar, and `ON DELETE SET NULL`, because
deleting a file must never delete a profile. The old `avatarUrl` text column
is **gone** (#103): it was in the table from the first migration, no code
ever wrote a value to it, and removing it took two releases for the reason
in `14-deployment.md`.

**`Session`** — one row per signed-in device. Stores a *hash* of the session
token, not the token itself, so a database leak does not hand over live
sessions. Lets a user see and revoke their sessions.

**`VerificationToken`** — email confirmation and password reset tokens. Also
stored hashed, also expiring, also single-use.

## Listings

**`Category`** — a fixed list, seeded by the project rather than created by
users, so browsing stays coherent. `slug` is permanent, because filters and URLs
use it. `name` is display text and can be renamed.

| Slug | Name |
|---|---|
| `cosmetics` | Cosmetics & skincare |
| `electronics` | Electronics & accessories |
| `clothing` | Clothing & shoes |
| `books` | Books & media |
| `toys` | Toys & games |
| `baby` | Baby & kids |
| `home` | Home & kitchen |
| `sports` | Sports & outdoors |
| `hobbies` | Hobbies & crafts |
| `food` | Packaged food (non-perishable) |
| `other` | Other |

The list stays clear of the prohibited items in `07-trust-and-safety.md`: food
is non-perishable only, and there is no health or medicine category. `other`
exists so that a legitimate item never has nowhere to go. The source of truth is
`farhand-api/src/seed.ts`; `npm run seed` applies it and is safe to re-run.
Removing a category is a migration, not a seed change, because listings may
already reference it.

**`Need`** — what someone wants. Holds two countries: `buyCountry` (where the
product must be bought) and `deliverCountry` (where it must arrive). These two
plus `status` form the main browse index.

**`Help`** — what someone offers. `shipsTo` is an array of country codes with an
empty array meaning anywhere, indexed with a GIN index so "ships to EE" stays
fast.

## Matching

**`Proposal`** — the handshake, and the single junction between a need and a
helper. It exists so that both directions of contact (helper answers a need,
requester approaches a helper) converge on one shape. `initiatedBy` records the
direction for display only. A unique constraint on `(needId, helperId)` stops
duplicate proposals. It is what decides them, too: the service inserts and
catches the violation rather than reading first, because two requests arriving
together would both read "no proposal yet" and both write.

The constraint takes no notice of `status`, so the row a helper withdraws keeps
its slot and they cannot propose on that need again — and the same after a deal
of theirs is cancelled. That is deliberate: the consequence is spelled out in
docs/06-api-contract.md, and it was challenged and upheld in
docs/10-decisions/0009.

**`Conversation`** — one per proposal, so questions can be asked before
agreeing. Unread state is two timestamps, `requesterLastReadAt` and
`helperLastReadAt`; anything newer is unread. This is one small write per read,
instead of a read flag on every message.

The row is made by the first message, not by the proposal, so an unused thread
never reaches an inbox. `lastMessageAt` exists to sort that inbox and is kept
in step with the newest message; it is null until somebody writes, and a null
sorts *first* in a descending order, which is why the inbox filters those rows
out rather than trusting them to be absent.

**`Message`** — `senderId` is nullable: a null sender means a system message such
as "deal marked as shipped", so the timeline reads as one story. `removedAt`
hides a moderated message without destroying evidence. `body` is **not**
nullable — a message always had words — so a removed one is served with its
body blanked rather than stored that way.

## Deals

**`Deal`** — created only when a proposal is accepted. It repeats `needId`,
`requesterId` and `helperId` even though all three could be found through the
proposal. This is deliberate denormalisation: "show me my deals" becomes one
indexed query instead of a join chain. The cost is that these fields must never
be edited after creation.

**`Quote`** — what the helper says it will cost, before anybody has agreed. A
row per revision rather than a column per amount, because "each revision is
logged" (docs/04-deal-lifecycle.md) and a row that stays *is* the log. The
newest row is the offer on the table; the one with `acceptedAt` set is the one
that became the deal's own amounts. A partial unique index allows only one
accepted quote per deal:

```sql
CREATE UNIQUE INDEX "one_accepted_quote_per_deal"
  ON "Quote" ("dealId") WHERE "acceptedAt" IS NOT NULL;
```

Keeping the offer out of `Deal.productAmount` is what lets a reader tell an
offer from an agreement without consulting the status: those columns are null
until something is agreed, and immutable afterwards.

**`DealEvent`** — append-only history of status changes. `Deal.status` answers
"where is this now"; `DealEvent` answers "how did it get here and who did it".
`actorId` is nullable because not every change has a person behind it: the sweep
that completes a delivered deal after fourteen days writes an event with no
actor, and `GET /deals/:id/events` reports that as `actor: null` rather than
inventing one.
Disputes and the admin view both depend on it. A null `actorId` means the system
acted, for example the 14-day auto-complete.

## Moderation

**`AdminAction`** — audit log of decisions about an account. Recorded separately
from `User.status` for the same reason as above: the status is the current
state, the log is the history. `User.status` says "suspended"; only the log says
"after two warnings, by this moderator, for this reason".

`contentType` and `contentId` are set for `REMOVE_CONTENT` and null for
everything else. Without them the log could say that something of somebody's
was removed and never which, and "has this listing been removed before?" would
have no answer. The enum is the reports one; `USER` never appears, because an
account is banned rather than removed.

The action and the state it causes are written in one transaction. An action
nobody can account for, and a record of something that did not happen, are both
worse than neither.

**Reading is not in here.** A moderator opening a conversation they are not part
of is logged to the application log instead — `AdminAction` is about what was
done to an account (docs/07-trust-and-safety.md).

**`Report`** — user complaints. Uses a polymorphic target (`targetType` plus
`targetId`) so one table covers users, needs, helps and messages. The trade-off
is that the database cannot verify the target exists, so the service layer must.

That check is about **visibility** and not only existence: a target the reporter
could not see answers the same way as one that is not there, or the endpoint
becomes a way of asking whether any given id exists
(`assertTargetIsReportable` in `src/services/reports.ts`). A `switch` with an
exhaustive `never` case means a fifth kind of target cannot be added to the enum
without the compiler stopping at the one function that has to know about it.

Duplicates are held off by a partial unique index, the same shape as the deal
and quote ones:

```sql
CREATE UNIQUE INDEX "one_open_report_per_reporter_target"
  ON "Report" ("reporterId", "targetType", "targetId")
  WHERE "status" = 'OPEN';
```

Partial, because the rule is "one *open* report", not "one report ever" — a
thing that is reported, resolved and then happens again deserves a new report.

## Trust and files (V2)

**`Review`** — unique on `(dealId, authorId)`, so one review per side per deal,
and only after `COMPLETED`. Ratings are constrained to 1–5 in the database.
Both rules are enforced there rather than only in code, and #83 proves each
with a test that writes straight to the table.

`removedAt` is the one column a moderator writes (#125) — the same column, the
same nullable timestamp and the same reason as `Message.removedAt`: hidden,
kept as evidence. A removed review still occupies its place in a list with its
words and rating gone, still completes the pair that published the other side's
review, and counts towards no average. The three behaviours are deliberate and
are in decision 0018.

**There is no `publishedAt`, and no job that sets one.** Whether a review is
visible is a question about rows and the clock — both sides have written, or
the deal's `COMPLETED` event is more than 14 days old — so it is computed when
somebody asks (decision 0017). A column would be a second copy of a fact the
data already contains, and the sort of copy that is wrong at three in the
morning when a job did not run. Nothing updates a review after it is published
either: it is public text somebody may have acted on.

**`File`** — metadata only; the bytes live in object storage (Backblaze B2,
decision 0011). A row names the owner, the purpose, a random storage key, the
type read from the file's own first bytes, and the size. Built in #79.

The row and the bytes are written in a fixed order — bytes first, then the row,
deleting the bytes again if the row fails — so a failure leaves invisible
garbage, never a row pointing at nothing. Who may read a file depends on its
purpose: an avatar follows its owner's profile, a need photo its need, and a
receipt is private to the two deal participants and moderators
(`06-api-contract.md`, "Files"). Deleting an account deletes its avatar and
need photos and keeps its receipts.

A need's photos are `File` rows with `needId` set and no table of their own
(#81). **There is no position column**: they are read oldest first, with the id
breaking ties, which is the order they were added. Re-ordering is a feature
nobody has asked for, and a column that exists but is never set is what #103
spent two releases removing. Nothing limits them in the schema either — six per
need is a rule the service holds under a row lock, because a count cannot be a
unique index.

Photos stay when a need is closed, expires or is taken down. They become
invisible to everybody but the owner and moderators by the same rule that hides
the need itself, so keeping them costs storage and no new code — and a
moderator reviewing a takedown can still see what was taken down.

A deal's receipts are the same shape with `dealId` set instead, in two kinds —
`PRODUCT_RECEIPT` and `SHIPPING_RECEIPT` — and **no table of their own either**
(#82). Two things about them are unlike every other file here: the row is
**never deleted by anybody**, because a receipt is evidence in somebody else's
dispute rather than a possession of whoever uploaded it; and the bytes may be a
**PDF**, stored exactly as they arrived, because nothing here can safely
rewrite one and a receipt emailed by a shop has no camera position to strip.
Three of each kind per deal, held by a lock on the deal's row rather than by a
constraint, for the reason the photo limit is.

## Cross-cutting decisions

| Decision | Reason |
|---|---|
| Money as integer cents plus a currency code | Floating point cannot represent money exactly |
| Soft deletion everywhere | Deals, reviews and evidence must survive one party leaving. `DELETE /me` is what that means in practice: the `User` row stays with `status = DELETED`, an unusable address at a domain RFC 2606 reserves, and a `Profile` **blanked rather than deleted** — an event whose actor has no profile reads as somebody we cannot label (#67), which says the wrong thing about a person who left (#66) |
| Rules duplicated in the database | A CHECK constraint holds even when application code has a bug |
| `cuid()` identifiers | Not guessable, unlike sequential integers, and generated without a database round trip |

## Rules the database enforces directly

```sql
-- one live deal per need
CREATE UNIQUE INDEX "one_active_deal_per_need"
  ON "Deal" ("needId") WHERE "status" <> 'CANCELLED';
-- ratings 1..5
ALTER TABLE "Review" ADD CONSTRAINT "rating_range" CHECK ("rating" BETWEEN 1 AND 5);
-- money never negative (Need and Deal)
```

## Known gaps, to decide later

- The GIN index on `Help.shipsTo` is not used by the browse filter, and this
  was measured rather than assumed. The index answers containment
  (`shipsTo @> ARRAY['EE']` plans as a bitmap scan on
  `Help_shipsTo_idx`), but "empty means anywhere" makes the live condition
  `shipsTo = '{}' OR shipsTo @> ARRAY['EE']`, and no GIN array index can
  answer the first half — so Postgres scans by status and filters. Adding a
  partial index for the empty half did not change the plan, and neither did
  forbidding plain index scans. The fix, when the table is big enough to care,
  is to replace the OR with two index-friendly queries combined by UNION ALL,
  one per half. Covered by tests in `tests/helps/browse.test.ts`, including
  one that fails if this is ever fixed.

- No notification table yet; email sending is V2.
- No currency conversion, by design.
- No address storage: delivery addresses are exchanged in messages in V1. This is
  a privacy question to revisit before any real launch.
