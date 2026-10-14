# 0018 — A removed review keeps its place and counts for nothing

## Context

#83 made reviews public, permanent and attached to a named person, and left
them unreachable by both moderation tools: `ReportTarget` had no `REVIEW`, and
the takedown endpoint knew needs, offers and messages. #125 closes that, and in
doing so has to answer a question #83 could avoid: **what does a removed review
look like to everybody else?**

Decision 0017 deliberately froze a review once published — the right rule for
an honest review and the wrong one for an abusive one, which is why removal had
to exist at all.

## Decision

**Two questions, two rules.** They sound like one and they are not:

| | |
|---|---|
| Is it shown? | **Yes**, in its place, with `removed: true` and both `rating` and `comment` as `null` |
| Does it count? | **No.** Not in #84's average, not in the count beside it |

In code that is `publishedWhere` (timing: both written, or the deadline passed)
for what is **listed**, and `countedWhere` — the same plus `removedAt: null` —
for what is **averaged**. Keeping them separate is the decision; an earlier
draft put `removedAt: null` inside `publishedWhere`, which quietly made a
removed review vanish, and the two questions then had one answer that was wrong
for one of them.

**It keeps its place** for the reason `06-api-contract.md` already gives about
a removed message: *a hole that says "removed" is honest; one that silently
closes up makes the thread read as though nothing was ever sent.* A list is not
a thread, but the argument carries: a profile whose fourth review silently
disappears is a profile that has been quietly edited.

**It counts for nothing**, because a review abusive or false enough to take
down almost certainly chose its rating in the same temper. Leaving the star
behind would let somebody damage a reputation from behind words nobody can
read, which is the shape of the problem rather than a remnant of it.

So a profile reads **"5.0 from 3 reviews"** above a list of four. The number
and the list disagree on purpose, and the tombstone explains the difference —
unlike an unexplained gap, which is what the alternative produces.

**A removed review still completes the pair.** "Both sides have written" is a
fact about the past and a takedown does not unmake it. This is not tidiness: if
removal broke the pair, there would be a trick — write something abusive about
the person you expect to review you badly, get it removed, and their honest
review of you disappears until the deadline. (In practice removal always
happens after publication anyway, since nobody but the author can see a review
inside the window and so nobody else can report one.)

**A moderator sees what was actually written.** `reviewAsEvidence` is a second
mapping used by `GET /admin/reports/:id` and by nothing else, because the row
is kept as evidence and evidence the only permitted reader cannot read is not
evidence. The asymmetry is a named function rather than a flag, so it is
visible at the call site.

**The takedown is recorded against the review's author**, as a message takedown
is recorded against its sender: a takedown is about who wrote the thing.

## Alternatives

**It disappears entirely.** Simpler, and it was briefly the plan — through a
drafting mistake of mine: the question put to the owner was about the *rating*,
and the option text smuggled in "visible to nobody", contradicting the issue
written an hour earlier. Rejected on its merits too: a silently shortened list
is a quietly edited profile.

**It keeps its rating, loses only its words.** Defensible — the deal happened,
and only the wording was unacceptable. Rejected because the rating is rarely
innocent when the words are not, and because it produces a profile saying "four
reviews, average 4.0" over a list of three readable ones, where the number
cannot be reconciled with anything a reader can see.

**The moderator chooses, per removal.** Fits the real difference between a rude
review and a false one, at the cost of a judgement call on every takedown, two
paths to test everywhere, and inconsistency between moderators that people
eventually notice.

**Let the author delete their own.** Not reopened. Decision 0017's reasoning
holds: a public statement others may have acted on is not its author's to
withdraw. An abuse path is not a reason to hand the ability back to the person
most likely to be the abuser.

## Consequences

- A profile's review count and the length of its review list differ whenever
  something has been removed. Documented, explained by the tombstone, and
  worth wording carefully in #93: *"5.0 from 3 reviews"* rather than
  *"3 reviews · 5.0"*, so the number is read as "how many make up the average"
  rather than "how many are listed".
- Nobody is told. The author is not notified that their review came down, and
  the subject is not notified either, because there is no notification system
  until #86. The tombstone is the only signal, and the author sees it too.
- A removed review still blocks its author from writing another on that deal:
  the unique index does not care about `removedAt`, and that is correct — a
  takedown is not a second attempt.
- `ReportTarget` gained a value, which broke the build in the one place that
  switches on it exhaustively. That is `docs/README.md`'s first rule working:
  the schema is authoritative, and the compiler enforced it.
- Two route files held a hand-written copy of that enum and quietly refused the
  new value with a `422`. They now read the list from the generated schema, so
  the next value added arrives on its own.
