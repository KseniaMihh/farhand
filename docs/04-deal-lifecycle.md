# Deal lifecycle

The heart of Farhand. Everything else is listings and messages; this is where
the rules live.

## Principles

1. A deal has exactly one status at any moment.
2. Only the transitions listed below are allowed. Anything else is rejected.
3. Every transition is performed by one identified person, and is written to
   `DealEvent`. The event log is append-only.
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
| `PRODUCT_PAID` | `PURCHASED` | Helper | — | Receipt upload allowed (V2) |
| `PURCHASED` | `SHIPPED` | Helper | Tracking number and real postage present | Requester notified to settle the difference |
| `SHIPPED` | `DELIVERED` | Requester | — | — |
| `DELIVERED` | `COMPLETED` | Requester, or automatically after 14 days | — | Reviews unlock |
| Any state before `SHIPPED` | `CANCELLED` | Either side | Reason required | Need may reopen |
| Any state from `PRODUCT_PAID` to `SHIPPED` | `DISPUTED` | Either side | Reason required | Deal frozen |
| `DISPUTED` | `CANCELLED` or previous state | Moderator | — | Resolution note recorded |

Any transition not in this table is invalid, including going backwards.

**This table exists once in the code**, as data, in
`farhand-api/src/services/transitions.ts` — `from`, `to`, who may ask, and
which extra fields the request must carry. The route validates against it, the
service enforces it, and a test walks all 81 possible moves to check that the
fourteen above are allowed and the other sixty-seven are refused. If this
document and that file ever disagree, one of them is a bug.

Two things in the table are not in the engine yet, because they are more than a
status change: returning a disputed deal to the state it came from (which needs
the event log to know what that was), and the automatic completion after 14
days (which needs something to run without a person asking). Both belong to the
cancellation and dispute issue.

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
| Both people want to redo a cancelled deal | Create a new proposal. Cancelled deals are never reopened. |
| Helper account banned mid-deal | Deal freezes as `DISPUTED` for moderator handling. |

## Database guarantee

A partial unique index enforces at most one non-cancelled deal per need, so a
need can never be in two live deals at once. This is a rule the database keeps
even if the application code has a bug.
