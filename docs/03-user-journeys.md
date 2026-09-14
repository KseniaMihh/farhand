# User journeys

Written in plain language, no technical terms. Each journey is the source for
the endpoints in `06-api-contract.md`.

## J1 — Requester posts a need and it succeeds

1. Kadri registers and confirms her email.
2. She posts a need: a skincare product sold only in Japan, delivered to Estonia,
   with an estimated price and an optional thank-you amount of €10.
3. Yuki, who lives in Japan, sees the need while browsing and sends a proposal.
4. Kadri reads Yuki's profile and their conversation opens. She asks whether the
   100 ml size is available. Yuki checks and confirms.
5. Kadri accepts the proposal. The need closes to other helpers and a deal is
   created.
6. Yuki confirms the real price and estimated postage. This is the quote.
7. Kadri sends the money for the product directly to Yuki and marks it as sent.
8. Yuki buys the product and marks it as purchased.
9. Yuki posts the parcel, enters the real postage cost and the tracking number.
   Kadri settles the difference between the estimate and the real cost.
10. The parcel arrives. Kadri marks it delivered. The deal completes.
11. Both leave a review.

## J2 — Helper advertises and is approached

1. Marek posts a help: he lives in Germany, can buy electronics and books, and
   posts to anywhere in the EU.
2. Anna browses helps, finds Marek, and sends him a proposal attached to a need
   she already posted.
3. From step 4 of J1 onwards, the flow is identical.

The only difference between J1 and J2 is who started the contact. This is
recorded on the proposal as `initiatedBy`, and nothing else in the system
branches on it.

## J3 — Nothing happens

1. Kadri posts a need. No one proposes.
2. The need reaches its expiry date and becomes `EXPIRED`.
3. She can repost it.

This is the most common journey on a young platform and must not look like an
error.

## J4 — A deal is cancelled

1. A deal is agreed. Before any money moves, Yuki realises the shop is out of
   stock.
2. Either side cancels, giving a reason.
3. The deal becomes `CANCELLED` and the need can be reopened.

Cancellation is normal, not a failure. It is only restricted after money has
moved (see `04-deal-lifecycle.md`).

## J5 — Something goes wrong

1. Kadri sent money. Two weeks pass and Yuki has not marked the item purchased
   and does not answer messages.
2. Kadri marks the deal as disputed, with a description.
3. The deal stops advancing. A moderator can read the conversation and the deal
   history.
4. A moderator may warn, suspend or ban the account, and records the reason.

Farhand cannot recover the money. This limitation is stated plainly to users
before they pay.

## J6 — Reporting content

1. Ivan sees a need asking for prescription medicine.
2. He reports it as a prohibited item.
3. The report appears in the moderator queue.
4. A moderator hides the need and warns the account. Both actions are recorded.

## J7 — Leaving

1. A user asks to delete their account.
2. Personal data is anonymised. The account becomes `DELETED`.
3. Past deals remain, so the other party keeps their own history and reviews.
