# 0022 — Erasing an account its owner cannot reach

## Context

`docs/11-risks.md` has carried this since #66 built `DELETE /me`:

> A banned person cannot ask for their data to be erased. `DELETE /me` needs a
> session, and a ban stops sign-in, so the one group most likely to want
> erasure cannot reach it.

Three facts make it a real hole rather than a technicality. A ban is the one
account state that cannot sign in at all. Erasure is the one thing in this
product that only the account's owner can trigger. And Farhand has no support
inbox, so there was no route for asking either — #88's issue says so in its
first line.

The second criterion in the issue is the one that shaped the work: *"the same
anonymisation as #66 — not a second, subtly different kind of deletion"*.

## Decision

**A moderator route, not a self-service one.** `DELETE /admin/users/:id`,
`MOD`, with a required reason, writing an `AdminAction` and performing #66's
anonymisation.

The alternative — an unauthenticated endpoint that takes an address, emails a
code, and erases on confirmation — is a new unauthenticated path whose job is
destroying data. It would need the anti-enumeration wording of
`forgot-password`, a token type, a rate limit of its own, and it hands
somebody who was banned for abuse a way to erase themselves on their own
schedule. For a product with no users yet, that is a large surface to defend
for a case a human can handle.

**And the contact route already exists**, which is what makes the moderator
route sufficient rather than merely cheaper: since #86 a ban is **emailed** to
the person it is about, and that email ends by inviting a reply (decision
0020). Before #86 this issue would have needed to invent the asking as well as
the doing.

**A dedicated verb, not another `type` on the actions endpoint.**
`POST /admin/users/:id/actions` writes warnings, suspensions, bans and
reactivations, every one of which can be undone. This cannot. An irreversible
act should not be one mistyped string away from a reversible one, so it gets
its own method and its own path, and `ERASE_ACCOUNT` joins `AdminActionType`
for the log rather than for the request.

**Banned accounts only.** An `ACTIVE` or `SUSPENDED` account is `409`, and the
message names `DELETE /me`. The power should be exactly as big as the hole:
anybody who can sign in can erase themselves — `DELETE /me` is marked
`SESSION` precisely so an account in a bad state still can (#66) — and a
moderator who can erase *any* account is a larger thing than this issue asked
for. If a case ever turns up that this refuses wrongly, widening it is one
line and a test; narrowing a power after it has been used is not.

**`MOD`, like every other account action.** Not `ADMIN`-only. Farhand has one
moderator and it is the author; a second role gate would be a rule with nobody
to apply it to, and what actually makes this accountable is the audit row. The
existing rule that nobody may act on an equal or higher role still applies,
and here it matters more: a ban can be lifted and this cannot.

**One anonymisation, two doors.** #66's body is moved verbatim into
`eraseAccount(userId)` in `services/erasure.ts`, and both paths call it:
`deleteMyAccount` keeps its password check, the moderator path keeps its
authorisation and its audit row. Moved rather than reimplemented, because
several of those lines are load-bearing in ways a rewrite would miss — the
replacement password hash has to be a *real* argon2 hash or login answers
`500` where an unknown address answers `401`, and `countryCode` stays because
on its own it identifies nobody.

The test that holds this is not about moderators at all: it runs both paths
against two identical accounts and compares every row either one is supposed
to change. A drift of one forgotten line is invisible to every other test in
the file.

**The audit row is written before the erasure, and not in one transaction with
it.** `eraseAccount` opens its own transaction and then deletes bytes from
object storage after it commits, which nothing can undo. If the erasure fails
after the row is written, the log claims an erasure that did not happen — a
lie a human can read and correct. The other order risks an erasure nobody can
account for, which is the failure #27's log exists to prevent.

**No email.** The address is anonymised in the same breath, so there is
nowhere to send one, and #86's queue would skip a notification to a `DELETED`
account anyway. The audit row is the record, and the person asked for this.

**Idempotent.** Erasing an already-erased account is `204` with **no second
audit row**: nothing happened, and a log that records non-events is one nobody
can read. The same shape as `DELETE /me/avatar` when there is no avatar.

## Alternatives

**A self-service erasure flow.** Above. The right answer for a product with
real users and no humans on call; the wrong trade today.

**Reusing `POST /admin/users/:id/actions`.** One endpoint, one audit shape, no
new row in the contract — and the endpoint that writes a warning becomes the
endpoint that can destroy an account, distinguished by one string in a JSON
body.

**`ADMIN` only.** Honest about irreversibility, and it would bite only once
somebody is `MODERATOR` but not `ADMIN`, which is nobody. Worth revisiting the
day moderation is delegated.

**Letting the erasure cancel any running deals.** It would remove the deadlock
below in one line, and it would decide by implication something the deal
lifecycle has never decided: what happens to money already paid when a deal is
cancelled out from under somebody. That belongs in a decision record of its
own, not inside a deletion routine.

**Hard deletion.** Not considered seriously, and worth saying why: deals,
events and receipts refer to this account, and "soft deletion everywhere" is a
decision from `05-data-model.md`. A deal's history has to survive one party
leaving, or the other party's evidence goes with it.

## Consequences

- **A deadlock is left standing, and written down.** Erasure is refused while
  a deal is running; a banned person cannot move a deal; a moderator can only
  move one out of `DISPUTED`. So a banned account with a deal at
  `PRODUCT_PAID` can be impossible to erase until the other side cancels it.
  `11-risks.md` now carries that instead of the old entry, and the fix — a
  moderator's power to end such a deal — is #134.
- **`DELETED_DISPLAY_NAME`, `deletedEmailFor` and the settled-status list
  moved** from `services/profiles.ts` to `services/erasure.ts`, along with the
  anonymisation. `services/reviews.ts` and one test import the name from its
  new home; nothing else referred to them.
- **`deleteMyAccount` is now six lines**: check the password, refuse a running
  deal, erase. Everything it used to do is still done, in the same order, by
  the function it calls.
- **The audit log can say an account was erased and not who it was.**
  `targetUserId` points at a row whose email is `deleted-<id>@farhand.invalid`
  and whose profile says "Deleted account". That is the intended outcome of an
  erasure and it does make the log less useful than it looks: the `reason`
  field is the only place the request itself is recorded, which is why it is
  required.
- **Nothing shows a moderator what a deleted account used to be.** There is no
  endpoint that reveals it, deliberately, and no plan to add one.
