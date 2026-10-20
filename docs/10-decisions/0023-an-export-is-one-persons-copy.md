# 0023 — An export is one person's copy, not a conversation's transcript

## Context

`docs/07-trust-and-safety.md` has promised data export since version 1, and
#89 is the other half of what #66 built: erasure answers "forget me",
portability answers "give me a copy first".

The mechanics were never the hard part. #85 gave the project a queue, so the
dozen queries can happen outside the request; the delivery question answers
itself once you notice there is no frontend to land a link in.

The hard part is that **almost nothing in Farhand belongs to one person**. A
conversation has two authors. A deal has two sides, two sets of money and a
shared history. A review is one person's words about another. An export is a
file somebody can forward, so every row in it is a decision about whose data
it is — and the issue says so in its third criterion: *"It does not hand over
somebody else's personal data along the way: a conversation has two sides."*

## Decision

**Ask, then download. No email.** `POST /me/exports` answers `202` with an id;
`GET /me/exports/:id` answers `409` while the queue is building it, `200` with
the JSON when it is ready, and `410` once it has expired.

Not an emailed link, for two reasons. There is no frontend (#93), so a link
would point at the API and still need a session — saving nobody a step unless
it carried a token, and a token in an email that unlocks somebody's entire
history would be the most dangerous object this project has ever sent. And
every extra email raises the hazard in decision 0015: one unsubscribe click at
the provider stops the verification mail too.

**The payload lives in a `Json` column, not in the bucket.** Decision 0011
says file bytes belong in object storage, and this is the exception, for three
reasons. An export is kilobytes of the rows sitting beside it. It is personal
data that has to be destroyed on a clock, and clearing a column cannot leave
bytes behind in a bucket the database has forgotten — the failure #79's
two-step write exists to prevent. And nothing serves it as an image, so none
of the signed-link machinery would be reused anyway.

**Everything about them, in full. Everything about somebody else, only what
they already had.** The rule, which every `select` in `buildExport` follows:

| | |
|---|---|
| Their own rows | In full — account, profile, listings, proposals, deals, reviews they wrote, reports they filed, notifications, sessions |
| Rows about them | In full — reviews they received, moderator decisions about their account. They are entitled to know what was said and done about them |
| The other person | Public display name, and their **words where those words were sent to this person** |
| Never | The other person's email address, their private profile fields, any row from a conversation this person was not in |
| Never | Credentials. No password hash, no session or token hash |
| Never | Which moderator took a decision |
| Not included | File bytes |

**The messages decision, which is the one that could have gone either way.** A
conversation is one thread with two authors, and the export includes both
sides' words. The reasoning: a message sent *to* somebody is in their
possession the way a received email is — they have already read it, it is in
their account, and exporting it discloses nothing they did not have. The
alternative, dropping the other side's bodies, makes the export useless for
the thing people actually ask for one for: proving what was agreed in a deal
that went wrong.

What keeps that honest is the line next to it: their words, yes; their
identity beyond a public display name, no. The export can show that Yuki
promised to post on Friday. It cannot show Yuki's address, Yuki's other
dealings, or anything about Yuki a stranger could not already read.

**Hashes are secrets too.** No `passwordHash`, and no `tokenHash` from
sessions or verification tokens. A hash of a *live* credential is still that
credential's fingerprint, and this is a file people forward to lawyers,
support desks and each other. The session rows are included without them: the
address and the dates are the person's own data and are exactly what somebody
asking "where has my account been used from" wants.

**Moderator identities are not in it.** A decision about the account is there
with its reason, because the person is entitled to know what was done to them.
Which moderator did it is not: they were acting in a role, and their name is
not this person's data to collect. In a one-moderator project that distinction
is theoretical; it will not be.

**It says what it leaves out.** A `notIncluded` section, in sentences, naming
the six omissions and the reason for each. An export that quietly drops
something is worse than one that can be argued with — and this is the part a
person actually reads.

**Seven days, then the payload is destroyed.** By the daily sweep, in the same
workflow and the same run as the deal sweep, with `if: always()`. The **row**
stays: "an export was made, and when" is itself something somebody may ask
about, and two timestamps are not a copy of their life.

**`SESSION`, and one at a time.** The same marker as `DELETE /me` for the same
reason — what you may do about your own data does not depend on the state of
your account — and because the file is handed to a session rather than
emailed, nothing is ever sent to an address nobody proved. A second request
while one is building is `409`; a pending request stops blocking after an
hour, because a job that gave up after #85's five attempts would otherwise
lock somebody out of their own data for good.

## Alternatives

**Email a link when it is ready.** What large services do, and they have
frontends to land on and mail domains of their own. Here it would be a link
that still needs a session, or a token in an email that unlocks everything.

**Email the JSON as an attachment.** A complete copy of somebody's history,
through a third-party provider on a free plan, unrecallable. No.

**The bucket, as a `File` row with a new purpose.** Consistent with 0011, and
it reuses the signed links and the permission rules from #79. It also puts a
complete personal history in a bucket whose other contents are photographs,
and adds bytes that have to be swept in step with a database row — the exact
coupling the column avoids.

**Only the person's own messages.** The strictest reading of "your data", and
indefensible in practice: an export that cannot show what the other side
agreed to is one nobody will ask for twice.

**Both sides' words while a deal is live, redacted once it is settled.** A
rule with a clock in it, and the moment somebody most wants the record is
after the deal has gone wrong.

**A `status` enum on the row.** Rejected for the same reason as `Job` and
`Notification`: the state is three timestamps and whether the payload is
there, and a status column is a fourth copy of that fact which can disagree
with the other three.

## Consequences

- **The export is the widest read in the project**, and a new kind of risk:
  one endpoint whose answer contains somebody's whole history. Hence ownership
  checked on the row, `404` rather than `403` for a stranger, no moderator
  access at all, and `attachment` so no browser paints it on a screen.
- **A moderator cannot read an export**, which means a support request of the
  form "send me what you hold about me, I cannot sign in" has no answer for a
  banned account: #88 can erase such an account but nothing can export it.
  That is a deliberate gap rather than an oversight — the alternative is a
  moderator-readable copy of everybody's history — and the day somebody asks,
  the honest answer is a one-off query by the operator.
- **`notIncluded` is prose, and prose rots.** If a later issue starts
  collecting something new, that section is the thing most likely to be left
  behind. A test asserts it is non-empty and that each reason is a sentence
  rather than a word, which catches deletion but not staleness.
- **Seven days is a guess**, and a short one. It is the number that keeps a
  complete personal history from sitting in the database indefinitely while
  still giving somebody a working week to notice the email that is not sent
  to them. If anybody ever complains, lengthening it is one constant.
- **The payload is written once and never updated.** An export is a snapshot,
  so a person who changes something afterwards and downloads the old file gets
  the old answer. That is what a copy is, and the `exportedAt` field at the
  top says when it was true.
