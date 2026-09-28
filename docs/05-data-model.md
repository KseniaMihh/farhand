# Data model

The authoritative version is `farhand-api/prisma/schema.prisma`. This file
explains **why** each table exists. When the two disagree, the schema is right
and this file needs updating.

## Accounts

**`User`** — private account data: email, password hash, role, status. Never
returned to other users.

**`Profile`** — public data: display name, country, bio, avatar. Split from
`User` so that returning a profile can never accidentally leak an email address.

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
its slot and they cannot propose on that need again. That is deliberate — the
consequence is spelled out in docs/06-api-contract.md.

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
Disputes and the admin view both depend on it. A null `actorId` means the system
acted, for example the 14-day auto-complete.

## Moderation

**`AdminAction`** — audit log of decisions about an account. Recorded separately
from `User.status` for the same reason as above: the status is the current
state, the log is the history.

**`Report`** — user complaints. Uses a polymorphic target (`targetType` plus
`targetId`) so one table covers users, needs, helps and messages. The trade-off
is that the database cannot verify the target exists, so the service layer must.

## Trust and files (V2)

**`Review`** — unique on `(dealId, authorId)`, so one review per side per deal,
and only after `COMPLETED`. Ratings are constrained to 1–5 in the database.

**`File`** — metadata only; the bytes live in object storage. Receipts are
private to the two deal participants and moderators.

## Cross-cutting decisions

| Decision | Reason |
|---|---|
| Money as integer cents plus a currency code | Floating point cannot represent money exactly |
| Soft deletion everywhere | Deals, reviews and evidence must survive one party leaving |
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
