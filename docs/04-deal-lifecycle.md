# Deal lifecycle

The heart of Farhand. Everything else is listings and messages; this is where
the rules live.

## Principles

1. A deal has exactly one status at any moment.
2. Only the transitions listed below are allowed. Anything else is rejected.
3. Every transition is performed by one identified person, and is written to
   `DealEvent`. The event log is append-only.

   It is readable two ways: embedded in `GET /deals/:id`, and on its own
   through `GET /deals/:id/events`, which is paged, oldest first, and names
   who did each step rather than only carrying their id
   (docs/06-api-contract.md). An event written by the 14-day sweep has no
   actor at all, and says so.
4. The frontend hides impossible buttons. The server rejects impossible
   requests. Both are required; only the second is a rule.

## States

A deal begins at `MATCHED`, and the only thing that creates one is
`POST /proposals/:id/accept` — five writes in one transaction, described in
docs/06-api-contract.md. The first `DealEvent` is written there too, with
`fromStatus` `null`: the log starts at the same moment the deal does.

| Status | Meaning |
|---|---|
| `MATCHED` | The proposal was accepted. Nothing agreed yet. |
| `QUOTE_AGREED` | Helper stated the real product price and estimated postage; requester accepted it. |
| `PRODUCT_PAID` | Requester says the product money has been sent. |
| `PURCHASED` | Helper has bought the item. |
| `SHIPPED` | Helper has posted it, with real postage cost and tracking number. |
| `DELIVERED` | Requester confirms the parcel arrived. |
| `COMPLETED` | Final state. Reviews unlock here. |
| `CANCELLED` | Ended without delivery. |
| `DISPUTED` | Frozen; a moderator is involved. |

## Allowed transitions

| From | To | Who | Precondition | Side effect |
|---|---|---|---|---|
| `MATCHED` | `QUOTE_AGREED` | Requester | Helper has submitted a quote | Amounts locked onto the deal |
| `QUOTE_AGREED` | `PRODUCT_PAID` | Requester | — | — |
| `PRODUCT_PAID` | `PURCHASED` | Helper | — | Receipt upload allowed, never required (#82) |
| `PURCHASED` | `SHIPPED` | Helper | Tracking number and real postage present | Requester **emailed** to settle the difference (#86) |
| `SHIPPED` | `DELIVERED` | Requester | — | — |
| `DELIVERED` | `COMPLETED` | Requester, or automatically after 14 days | — | Reviews unlock, and their 14-day window starts (#83) |
| Any state before `SHIPPED` | `CANCELLED` | Either side | Reason required | Need may reopen |
| Any state from `PRODUCT_PAID` to `SHIPPED` | `DISPUTED` | Either side | Reason required | Deal frozen |
| `DISPUTED` | `CANCELLED` or previous state | Moderator | Reason required | Resolution note recorded |

Any transition not in this table is invalid, including going backwards.

**This table exists once in the code**, as data, in
`farhand-api/src/services/transitions.ts` — `from`, `to`, who may ask, and
which extra fields the request must carry. The route validates against it, the
service enforces it, and a test walks all 81 possible moves to check that the
fourteen above are allowed and the other sixty-seven are refused. If this
document and that file ever disagree, one of them is a bug.

**A receipt is allowed at `PURCHASED`, and never required.** The transition
checks nothing about files, which is a decision rather than a gap
(`10-decisions/0016-receipts-are-evidence.md`): a receipt is evidence for a
dispute, not a gate. Requiring one would stop an honest purchase over a lost
slip of paper, and would collect blurred pictures of nothing from people who
only want the button to work. The upload is its own endpoint —
`POST /deals/:id/receipts/:kind`, helper only, three of each kind — and a
shipping receipt waits for `PURCHASED`, because the postage is paid when the
parcel is sent. Nothing deletes one.

**Who is told about a move is its own table**, and deliberately not this one:
`src/services/notifications.ts` holds it, because `transitions.ts` says of
itself that "an engine that also performed [the side effects] would be two
things at once". The rule it follows is that an email goes to the person whose
**move it now is**, and only when that is not the person who just acted —
which is why half the transitions here send nothing at all. The list, and the
silences, are in
[decision 0020](10-decisions/0020-what-is-worth-an-email.md). The `SHIPPED`
row above is the promise that waited longest for it.

Three of the rows carry more than a status change, and all three are now built:

**Cancelling releases the need.** A cancelled deal means nobody is shopping for
this any more, so the need goes back to `OPEN` and other helpers can offer —
inside the same transaction as the cancellation, so a failure leaves neither.
Only from `MATCHED`, though: a need the requester has closed, or a moderator has
removed, is not quietly republished. The original helper still cannot propose
again, because the unique constraint on `(needId, helperId)` holds that slot for
good (docs/05-data-model.md); somebody else can.

**A dispute freezes the deal.** From `DISPUTED` the table offers nothing to
either of its two people — only the moderator's row — so neither side can move
it while they disagree.

**"Or previous state" means exactly one state.** Which one is not something the
table can say, because it depends on the deal's own history: the service reads
the most recent event whose `toStatus` is `DISPUTED` and allows only its
`fromStatus`. Any other target is refused even though the table lists all three
candidates.

## Completing without being asked

A requester who goes quiet must not leave a deal open forever, so a deal that
has been `DELIVERED` for **14 days** completes itself. The event it writes has a
**null `actorId`** — the schema's way of saying the system acted rather than a
person (docs/05-data-model.md) — and a note saying so in words.

It runs as a job rather than a timer inside the API: `npm run job:auto-complete`,
scheduled by whatever runs scheduled work once the API is deployed. Two API
instances would both fire a timer; and a web process should answer requests. The
sweep is safe to run twice and safe to overlap with itself, because each deal is
moved by an update guarded on it still being `DELIVERED` — the requester
pressing the button at the same moment simply wins, and the job writes nothing.

## Quoting, separately from status

The helper submits a quote; it is not itself a status. The deal stays `MATCHED`
until the requester accepts it. A helper may revise a quote while the deal is
still `MATCHED`; each revision replaces the previous one and is logged.

Concretely: a quote is a row in `Quote`, and revising writes another one. The
newest row is the offer on the table, the older rows are the log, and the row
whose `acceptedAt` is set is the one that became the deal's own amounts. The
deal's `productAmount` and `shippingEstimate` stay `null` until that happens, so
"offered" and "agreed" are never the same field. Endpoints in
docs/06-api-contract.md.

## Money rules

- All amounts are integers in the smallest unit of the currency (cents), never
  decimals. See `10-decisions/0006-money-as-integer-cents.md`.
- One currency per deal, chosen at quote time.
- `productAmount` and `shippingEstimate` are set when the quote is agreed and are
  then immutable.
- `shippingActual` is set at `SHIPPED` and may differ from the estimate. The
  difference is settled between the two people; Farhand only records it.
- `thankYouAmount` comes from the need and is copied onto the deal at creation,
  so later edits to the need cannot change an agreed deal.

## Edge cases and how they are handled

| Situation | Handling |
|---|---|
| Requester never pays | Helper cancels. No penalty in V1. |
| Real postage is far above the estimate | Recorded; the two settle it. A large gap is a common dispute cause — surfaced in the UI as a warning, not blocked. |
| Parcel lost in transit | Requester disputes. Farhand records; it does not compensate. |
| Requester goes silent after delivery | Auto-complete after 14 days at `DELIVERED`. |
| Requester never confirms delivery at all | Deal stays `SHIPPED`. Tracking number exists as evidence in a dispute. |
| Both people want to redo a cancelled deal | They cannot, on that need. Cancelling reopens it, so **a different helper** may propose at once — but the same helper is refused, because a proposal is one per helper per need whatever became of it (`0009`). The way back is a new need. |
| Helper account banned mid-deal | Deal freezes as `DISPUTED` for moderator handling. |

## Database guarantee

A partial unique index enforces at most one non-cancelled deal per need, so a
need can never be in two live deals at once. This is a rule the database keeps
even if the application code has a bug.
