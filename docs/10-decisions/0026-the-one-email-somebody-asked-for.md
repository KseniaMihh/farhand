# 0026 — The one email somebody asked for

Refines [0020](0020-what-is-worth-an-email.md), which is still the rule. This
records the single exception to it, and the test it had to pass to earn one.

## Context

#90 is saved searches, and the issue says the quiet part out loud: *"a saved
search is only worth having if it tells you something. That makes this the
first real customer of the notification work."*

Which puts it straight into an argument with decision 0020, whose rule is one
sentence: **email when the recipient must do something, or has lost the chance
to — never as an activity feed.** "A need you might like has been posted" is
an activity feed. It is the exact thing that sentence was written to keep out,
and 0020 says so itself: it is the sentence to argue with if a future issue
wants to add a line to the table.

The hazard behind that rule has not gone away either. Decision 0015: our
provider's unsubscribe applies to **everything** it sends on our behalf, so an
unwanted email is not merely annoying — one click and that address can no
longer receive a verification code or a password reset. Every email added to
this product is a small chance of locking somebody out of their own account.

## Decision

**A saved search sends email, and the rule survives, because of who asked.**

An activity feed is a product deciding what somebody might want to hear about.
A standing query is a **person naming the thing they want to hear about, in
their own words, and storing it**. The difference is not the content of the
email; it is who chose. 0020's rule is about a product's judgment of what is
worth interrupting somebody for, and this is the one case where that judgment
is not ours to make.

So the rule gains a clause rather than an exception:

> Email when the recipient must do something, has lost the chance to, **or
> asked for this specific thing by name**.

**Four things keep that clause honest**, and without them it is a loophole
anything could be driven through:

| | |
|---|---|
| It is **stored**, not inferred | A saved search is a row the person created. Nothing infers interest from what they browsed, and nothing ever will under this clause |
| It has **its own switch** | `notify` per search, so somebody can keep ten standing queries and be emailed about one. The account-wide switch (#86) still wins, and so does a ban |
| It is **capped** | Ten per account. A clause that lets somebody receive a hundred streams is a clause that produces a hundred streams |
| It is **one email per listing** | However many of their searches matched, keyed on the listing, enforced by the index that already stops a deal sending two |

**Not a digest, and this is the part most likely to be revisited.** One email
per match, immediately — because a digest needs a schedule, a "since when"
marker per search, and a second notification path that is not "one row, one
email". 0020 says the message-arrived email would need exactly that machinery
before it could exist; this is the same debt, declined for the same reason, at
a volume where it does not yet hurt. The day somebody's search matches twenty
listings a day, the digest becomes an issue and this decision is the one that
gets superseded.

**Matching runs in the queue, never in the publish.** `POST /needs` writes one
row on #85's queue and answers. The worker does the comparing seconds later.
Two reasons, and the second is the one that will matter later: a request must
not pay for everybody else's standing queries, and a failing mail provider must
not be able to fail somebody's posting.

**It runs at the moment a listing becomes public** — posted openly, a draft
published, a paused offer reactivated — which is exactly where #87 asks for the
prohibited-list tick. That is not a coincidence worth hiding: `needsAcknowledgement`
already names this event, and both features hang off it.

## Alternatives

**No email: save the filters and let people come back and re-run them.** The
honest reading of 0020, and it makes saved searches a bookmark. The issue's own
sentence is the answer — a saved search that tells you nothing is a saved
search nobody opens — and the acceptance criteria ask for the notification.

**A daily digest per search.** Kinder, and probably where this ends up. It
needs a schedule, a per-search cursor, and a notification path that batches,
which is a second mechanism beside the one #86 built. Deferred, deliberately,
and named here so the deferral is visible.

**One email per match with a cooldown per search** — at most one an hour, say.
It is a digest with the state kept in a different column, and it has a worse
failure: the matches inside the quiet hour are silently dropped rather than
collected.

**Infer interest instead of storing it** — "needs like the ones you have
offered on". This is the thing the clause above is written to exclude. Nobody
asked, so it is an activity feed, and it is how a product ends up emailing
people about things they looked at once.

## Consequences

- **The email table has a line that is not about a deal**, and the shape of
  the silences changes: a saved search can be silent for a reason that is
  nobody's decision but the person's own (`notify: false`), which no other
  notification has.
- **The volume is now a function of how busy the marketplace is**, not of how
  many deals one person has. That is new. Ten searches with no filters would
  mean an email for every listing posted; the cap bounds it per account, and
  nothing bounds it per listing except that everybody who matched genuinely
  asked.
- **A saved search is a reason to keep an address verified.** `AUTH` on
  `POST /me/searches`, which is the opposite marker from `PATCH
  /me/notifications` (`SESSION`, so anybody can stop email). Starting a stream
  needs a proved address; stopping one must never need anything.
- **The matching is the first query in this project that runs backwards** —
  filters in the table, the subject in the request. The `NULL means any`
  convention is what makes it a single `WHERE`, and it is the thing to
  preserve if a browse endpoint ever gains a filter.
