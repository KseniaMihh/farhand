# 0017 — Reviews are blind until both are in, and then they close

## Context

#83 writes to the `Review` table for the first time. The rules about *who* may
review were never in doubt — a participant of a `COMPLETED` deal, once, about
the other side, with the pair refused by a unique index that has existed since
the first week. What had to be decided was **when a review becomes visible**,
and **whether it can be changed afterwards**.

The thing that decides both is what a review is for. It is not feedback between
two people who already know what happened; it is a signal to the next stranger,
and #84 will average these rows into a number on a profile. A signal everybody
has an incentive to distort is worth nothing.

The incentive is specific and well known: if I can read your review before I
write mine, my review is partly an answer to yours. Two-star honesty gets
one-star revenge, everybody learns this, and within a few months every review
on the site is a bland five.

## Decision

**Blind until both are in, with a deadline measured from the deal — and
writing closes when the window does.**

```
deadline   the deal's COMPLETED event + REVIEW_WINDOW_DAYS (14)
writable   now < deadline, and I have not written one
visible    both sides have written, or now ≥ deadline
editable   mine, and not yet visible
```

**The second line is what makes the third one work.** The first draft of this
measured fourteen days from *each review*, which is a blind window somebody can
simply wait out: write nothing, let the other person's honest review publish
itself on day 15, read it, and answer on day 16. Measuring from the deal and
closing writing at the deadline means that by the time anybody can read a
review, nobody can write one. It also means both reviews become visible at the
same moment, rather than on two different days.

**Editable exactly while hidden.** Not a separate rule — the same one, read the
other way. Until a review is published it is a draft that only its author can
see, so a typo, a wrong star count or a sentence written in temper can be
fixed. Once anybody else can read it, it is a public statement somebody may
have acted on, and it stays. **Nothing deletes a review**, at any point.

**Fourteen days**, the same number as `AUTO_COMPLETE_DAYS`, because this
product already uses it to mean "how long somebody might reasonably take to get
round to something" (`04-deal-lifecycle.md`).

**No column, and no scheduled job.** When a deal completed is already in the
event log — the same place the auto-complete sweep reads delivery times from —
and everything else is that date and the clock. Visibility is computed when
somebody asks.

**The rule is written twice, on purpose**: `isPublished()` in JavaScript, for
answering one request, and `publishedWhere()` as a Prisma `where`, for #84's
average, which belongs in the database rather than in a loop over every review
somebody ever received. A test holds the two together, because two spellings of
one rule is exactly how rules drift.

## Alternatives

**Visible immediately.** One less condition everywhere, including in #84's
average. Rejected for the reason the whole record exists: the second reviewer
has read the first review, both of them know it, and the ratings drift towards
meaningless agreement.

**A timer per review**, each publishing fourteen days after it was written.
This was the first design and it is quietly broken: the window can be waited
out, which is the one thing it exists to prevent.

**Visible only to the deal's two people.** Honest and useless — it is a trust
signal for strangers, and a stranger would never see it.

**Hidden forever until both write, with no deadline.** No revenge reviews, and
no reviews either: one silent participant and the other's review is invisible
permanently, which rewards silence. The deadline is what makes writing one
worth the effort.

**Editable forever.** Kindest to the author, and it means a rating somebody
relied on can be revised after they relied on it — including quietly upward
after a private argument, which is the pattern review systems exist to resist.

## Consequences

- A review can sit invisible for up to fourteen days, so a new account has
  nothing to show for a fortnight after its first completed deal. That is the
  cost of the window and it falls hardest on exactly the people who most want a
  reputation.
- #84's rating summary **must** use `publishedWhere`, or the average will count
  reviews nobody can read — a number that disagrees with the list below it.
- A deal that reached `COMPLETED` without an event saying so has no window and
  cannot be reviewed. Only possible for rows written outside the API; the rule
  fails closed.
- A person who leaves after writing a review leaves it behind, attributed to
  `Deleted account` (#66). The review is about the other person, and it was
  true when it was written.
- **There is no way to report or remove a review.** `ReportTarget` has no
  `REVIEW`, and `POST /admin/content/:type/:id/remove` knows needs, offers and
  messages. Public text about a real person with no removal path is a real harm
  once there are real users; it is recorded in `11-risks.md` and wants its own
  issue before the frontend goes live.
