# 0030 — Ending a deal nobody can finish

## Context

#88 gave a moderator the power to erase a banned account, and refused it while
a deal of that account's is still running — the same refusal `DELETE /me`
makes, for the same reason: there is somebody on the other side who is owed
either the thing or their money, and erasing one of the two people leaves them
with neither.

That left a deadlock, recorded in `docs/11-risks.md` and in the comment on
`assertNoRunningDeals`. Reading the transition table rather than the issue
makes it precise, and narrower than it sounded:

| Deal sits at | The live party may | A moderator may |
|---|---|---|
| `MATCHED`, `QUOTE_AGREED` | cancel | nothing |
| `PRODUCT_PAID`, `PURCHASED` | cancel, or dispute | nothing |
| `SHIPPED` | dispute only — the cancel row stops at `PURCHASED` | nothing |
| `DELIVERED` | requester only, → `COMPLETED` | nothing |
| `DISPUTED` | nothing | cancel, or send it back |

So the live party was never completely stuck, and `DELIVERED` settles itself:
`autoCompleteDeliveredDeals` sweeps on status alone, with no condition about
either account, so a delivered deal completes within fourteen days whoever is
banned. The real hole is the third column. **A moderator had no move of their
own on any live deal except `DISPUTED`** — a state one of the deal's two
people had to open. A banned account cannot open it, so an obligation the
product treats as an obligation waited on a stranger choosing to click
something, and when both parties were gone it waited for good.

Two decisions, as #134 said from the start: what power a moderator gets, and
what the product says about money that has already moved.

## Decision

**A moderator may end a deal nobody has paid for, and may only freeze one
somebody has.** Two rows, split on whether money has moved:

```
MATCHED, QUOTE_AGREED            → CANCELLED  requester, helper, moderator
PRODUCT_PAID, PURCHASED, SHIPPED → DISPUTED   requester, helper, moderator
```

Nothing has been sent at `MATCHED` or `QUOTE_AGREED` — the quote is a number,
not a payment — so cancelling there says only what is true, and is exactly
what either party could already have done. From `PRODUCT_PAID` onwards the
requester's money is gone, and a one-click cancel over the top of that is a
bigger power than the problem needs. The moderator freezes it, looks, and ends
it through `DISPUTED → CANCELLED`, which already existed and already demands a
resolution note. Two events, two notes, and a human decision in between.

**The alternative was one row** — "any live state → `CANCELLED`, moderator" —
which is what the issue sketched. Rejected for what it costs rather than for
what it does: it is the same outcome in one step, with nothing on the record
between a moderator seeing a deal and ending it, and it would have reached
`DELIVERED`, where cancelling a deal whose parcel arrived is a lie about what
happened. A precondition — "only when a party is banned" — was also rejected:
it reads as the tighter permission, but it puts a fact about *people* into a
table that otherwise only talks about a deal's state and a request's fields,
and the honest scope of the power is "a deal nobody left can settle", which is
not only bans.

**`DELIVERED` gets no new row at all.** The sweep settles it. An erasure may
therefore wait up to fourteen days on a delivered deal, and that is a wait
rather than a deadlock.

**`who` became a set.** It was one actor per row, with `"either"` as a magic
value meaning the two parties and not a moderator. Both new rows name three
kinds of actor, and `findTransition` returns **one** rule per `(from, to)`
pair — so a second row for a move already in the table would have been
unreachable code that nothing could have reported. Rows now carry
`who: TransitionActor[]`, `"either"` is gone in favour of a written-out
`EITHER_SIDE`, and the table keeps its one-row-per-move invariant.

**What Farhand says about the money: whose it is, and nothing more.** The
moderator's note is mandatory and both sides are emailed it — they are the
only people who learn why a stranger closed their deal — and where the deal
had reached `PRODUCT_PAID` the email also says that Farhand never holds their
money, so anything already sent is between the two of them.

Rejected: **recording who is out of pocket.** A moderator stating "the helper
owes 24 euros" is a verdict with no mechanism behind it, in a product that
holds no money by design (decision 0004), and a verdict that looks enforceable
invites being treated as one. Also rejected: **saying nothing beyond
"cancelled"**, which is what the code did before this and is worse than it
looks — the old wording was *"so nothing more is owed by either side"*, which
is false the moment money has moved.

## Consequences

- **The old cancellation email was already wrong, and this fixes that too.** A
  requester may cancel a deal they have paid for, so "nothing more is owed by
  either side" has been going out since #86 in a case where something very
  much is. The wording now depends on the status the deal came *from*:
  `PRODUCT_PAID` onwards, including `DISPUTED` (which can only be entered from
  those states), gets the money sentence instead.
- **An email can now say "a moderator ended this"**, which no email said
  before: every deal ending was somebody in the deal doing it. The composer
  works it out from the event's actor rather than from a role lookup — if the
  actor is in neither seat, it was a moderator — because what matters to the
  reader is that it was not the other person, and somebody who later stops
  being a moderator does not change what happened.
- **A moderator can freeze a deal that is not in dispute**, and the email for
  that case had to change as well: "frozen until a moderator looks at it" is
  the wrong sentence when a moderator is the one who froze it.
- **The erasure refusal now names a remedy that depends on who is asking.**
  The owner is told to settle or cancel; a moderator is told that a deal
  nobody has paid for can be cancelled and one somebody has can be frozen and
  then ended. One sentence each, because an error naming the wrong remedy
  wastes somebody's afternoon.
- **Two guards still hold, and both are tested.** A moderator cannot cancel
  from `PRODUCT_PAID`, and cannot confirm a parcel from `SHIPPED`. The second
  was already tested; the first was not testable before, because no row had an
  actor who might plausibly have been allowed — which is why the 81-move walk
  gained a second dimension in this issue: for every listed move, every actor
  the row does not name is refused. Twenty-two of those, asserted by count,
  because a row that quietly grows an actor would otherwise leave the test
  checking one case fewer and saying nothing.
