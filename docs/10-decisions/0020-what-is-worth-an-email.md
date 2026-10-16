# 0020 — What is worth an email

## Context

#86 was never about sending. #85 built the sending, and #119 before it: a row
on a queue, a worker two seconds later, a `fetch` to Brevo. The code that
delivers a notification is four lines.

The issue is what to put in them. Every email Farhand sends spends something
that cannot be earned back quickly — the willingness of a person to look at
the next one. Send the wrong ones and the right ones stop being read, and then
the one that says "your parcel needs postage settling" is filtered with the
rest.

There is also a specific hazard here that a normal product does not have.
Decision 0015 recorded it: Farhand sends through a provider whose unsubscribe
applies to **everything** it sends on our behalf. One click on a notification
and that address can no longer receive a verification code or a password
reset. So an email nobody wanted is not merely annoying; it is a route to
locking somebody out of their own account.

Three questions had to be answered: which events, where the opt-out lives, and
how one event is stopped from sending two emails.

## Decision

**Email when the recipient must do something, or has lost the chance to.
Never as an activity feed.** Every line below follows from that sentence, and
it is the sentence to argue with if a future issue wants to add one.

**What sends an email:**

| What happened | Who hears | Why |
|---|---|---|
| Somebody offered to help with your need | The requester | Nothing happens until they accept it |
| A requester approached you about their need | The helper | Theirs to answer |
| Your offer was accepted | The helper | They owe a quote |
| A quote arrived | The requester | Agreeing it is their move, and a quote is not a status change, so no transition would ever have told them |
| The deal moved and the next move is theirs | Whoever that is | The whole point |
| The deal was cancelled | The other side | They were waiting to do something, and now must not |
| A dispute was raised | The other side | The deal is frozen; they would otherwise find out by trying to act |
| A moderator resolved a dispute | Both sides | Neither of them did it |
| The deal completed | Both sides | What is announced is not the press of a button, it is the fourteen-day review window it opened (#83) |
| A moderator acted on your account or content | The person it was about | **Whatever their preference says** |

**What deliberately sends nothing**, and this half is tested as carefully as
the other:

| What happened | Why not |
|---|---|
| Somebody reviewed you | Reviews are blind until both are in (0017). "Yuki reviewed you" tells you they went first, which is exactly the pressure the blind window removes |
| A message arrived in a deal | The one most people expect. It also turns an inbox into a chat notification: it needs a quiet period and a digest to be bearable, and that is an issue of its own, not a line here |
| A proposal was declined or withdrawn | Nothing is waiting for the helper, and an email saying "no" invites a reply nobody reads |
| `PRODUCT_PAID`, `PURCHASED`, `DELIVERED`, seen from the side that did not act | Nothing is waiting for them. The deal page is where that belongs |
| Anything you did yourself | Nobody needs an email about the button they just pressed |
| A need about to expire | Arguable — it is a "you are about to lose the chance to" — and it is also the kind of email that teaches people to ignore us. Not in version 2 |

**One switch, on the `User` row, and moderation is exempt.**
`User.emailNotifications`, default true, changed through
`PATCH /me/notifications`. On the user and not the profile because
`DELETE /me` blanks a profile (#66), and a preference that forgets itself when
somebody deletes their account is a preference that emails a deleted account.

Exempt means exempt: a moderator's decision is sent to a person who has turned
notifications off, and to a banned account. Being told that your account was
suspended is not marketing, and somebody who cannot be told cannot appeal.

**Not a per-category preference.** Three switches would be honest about these
being different kinds of interruption, and would be three times the surface to
explain and to test, for a product with one kind of email so far. The day
there are digests and reminders is the day to look again.

**The opt-out lives in Farhand, not in the email.** Every notification ends
with a line saying where to turn them off, and there is no unsubscribe link of
our own, because of the provider hazard above. This is the part of 0015 that
#86 could act on without a domain: keep the only "no thank you" button on a
page we control.

**One event sends one email, and the database decides it.** A `Notification`
row records that somebody should be told, with a unique index on
`(userId, kind, subjectId)`. `subjectId` is **what happened** — a `DealEvent`,
a `Proposal`, a `Quote`, an `AdminAction` — not what it is about, because the
same person can legitimately be told the same kind of thing about the same
deal twice: a moderator who un-disputes a deal makes it the helper's turn
again, and a deal-keyed index would swallow that second, true email as a
duplicate. A `subjectType` column says which table the id points into, so the
sender never guesses by trying tables in turn.

The row is also the memory the queue needs. #85 is at-least-once by
construction — a crash after the provider accepted a message leaves the job to
be claimed again — so the handler checks `sentAt` and `skippedAt` before doing
anything. `sentAt` is written **after** the provider accepts, never before:
marking first and then failing loses the email for good, which is the one
outcome the queue exists to prevent.

**The email is composed when it is sent, from the rows as they are then.** The
job payload carries an id and nothing else. An email saying "waiting for your
payment" about a deal that was cancelled an hour ago is worse than a late
email. It also means the preference is read twice — at the event and at the
sending — because the gap between them is exactly where somebody goes and
turns these off.

**No links**, for #119's reason: `APP_ORIGIN` is still the API's own address
because there is no frontend (#93). So every notification names the need it is
about, because somebody with three deals open cannot click to find out which
one this is.

## Alternatives

**Notify on every status change.** The simplest rule, and the one that needs
no table of exceptions. It also emails the person who just pressed the button,
twice per move once both sides are counted, and turns six useful emails per
deal into fourteen. The rule at the top exists to refuse this.

**Include messages.** The feature people would ask for first. Rejected *for
now* rather than on principle: done badly it is one email per line of a
conversation, and doing it well means a quiet period, a digest, and a decision
about how much of somebody's private message may appear in an inbox. That is
an issue, not a row in this table.

**A `Notification` row per recipient per deal, rather than per event.** Fewer
rows, and it makes "have we told them about this deal?" a single question. It
also silently loses the second legitimate email about the same deal, which is
the case above.

**Marking the row sent before calling the provider.** Guarantees no duplicate
email, and pays for it with lost ones: a provider timeout would mark the
notification sent and nobody would ever know. The trade is deliberate — at
most one duplicate in a crash window, never a silent loss — and it is the same
way round as #85's job rows.

**Per-category preferences.** Above.

**An unsubscribe link in the email.** What every other product does, and what
0015 says we cannot safely do until Farhand has its own domain and a provider
that keeps transactional and notification mail apart. The trigger is #93.

## Consequences

- **A person who turns notifications off still gets moderation email**, and
  the last line of every notification says so. If that ever reads as a
  loophole, the answer is a separate moderation-only switch, not a silent one.
- **Nothing tells anybody about a new message**, which is the gap a real user
  would notice first. It is written down here so that it is a decision rather
  than an oversight.
- **An unverified account can receive notifications.** It can also turn them
  off without verifying, which is the point of marking
  `PATCH /me/notifications` as `SESSION` rather than `AUTH`. Requiring a
  confirmed address before somebody may stop email is the kind of rule that
  gets a sender blocked.
- **`Notification` rows accumulate**, one per told event, and nothing sweeps
  them. They are the answer to "what did we send, and when", which is worth
  keeping; #114's scheduled sweep is where a cleanup goes if the count ever
  matters.
- **A notification whose subject has vanished is skipped, not failed.**
  Nothing in this project hard-deletes a proposal or a deal event, so this is
  defence rather than a daily case — but a job that retries five times and
  reports itself over a row that no longer exists is noise, not an alert.
- **The silences are tested.** `tests/notifications/events.test.ts` asserts the
  full record after each action, so an email added anywhere — by this issue or
  a later one — fails a test that names the silence it broke. That is how a
  decision stays a decision.
