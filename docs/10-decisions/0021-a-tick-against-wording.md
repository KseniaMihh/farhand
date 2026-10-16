# 0021 — A tick against wording, at the moment it matters

## Context

`docs/07-trust-and-safety.md` lists three defences against prohibited or
illegal items, in order: **a prohibited list at posting time**, reports, and
moderation. The second and third are what happens after something has already
been posted. The first is the only one that happens before, and until #87 it
was the only one not built.

It is also the weakest-looking of the three, and worth being honest about
before deciding anything: a checkbox stops nobody determined. What it does is
narrower and still worth having — it removes "I didn't know", it gives a
moderator something to point at when they take a listing down, and it puts the
rules in front of somebody at the one moment they are thinking about what to
post. `docs/11-risks.md` already says there is no automatic detection in
version 1 rather than implying otherwise, and that has not changed.

Three questions had to be answered: where the list lives, what is recorded,
and — the one that turned out to matter most — **when** it is required.

## Decision

**The list lives in a table, seeded with a floor.** `ProhibitedItem` rows:
`slug` (permanent), `text` (what a person reads), `position`, `retiredAt`.
`npm run seed` creates what is missing and **never rewords what is already
there**, so running it after somebody has tightened a clause cannot quietly
undo them. The wording in the seed comes from
`docs/07-trust-and-safety.md`, which stays the authority.

Rows rather than a constant in the code, because the list is a rule about the
world and not a fact about the program: it changes when a law does, and
changing it must not need a deployment. This is the same reasoning
`07-trust-and-safety.md` gives for the sanctioned-country list, and a line is
**retired rather than deleted** so that acknowledgements already recorded still
refer to wording that can be read.

**The version is a fingerprint, computed, never stored.** A sha256 over the
published lines — slug, text and order — cut to sixteen characters.

A `version` column would be a number somebody has to remember to bump after
rewording a line in Neon, and the one time they forget, every acknowledgement
afterwards records agreement to wording nobody agreed to. A hash of the rows
cannot be forgotten. The separator inside it is a NUL byte, which no text can
contain: joining on a comma would make `["a,b"]` and `["a", "b"]` the same
list, and a fingerprint two different lists share is a fingerprint that can be
ticked against the wrong wording.

**What is recorded is the fingerprint and the time, on the listing itself.**
`prohibitedVersion` and `prohibitedAckAt` on `Need` and on `Help`. So when a
clause is reworded afterwards, "what did this person actually agree to" is
still answerable — which is the only reason to record a version rather than a
boolean. A moderator reading a reported need sees it without a join.

**It is required at the moment the listing becomes public, which is not always
when it is created.** This is the part of the issue with teeth, and the title's
"at the moment it matters".

Both kinds of listing can be created in a state nobody else can see — `DRAFT`
for a need, `PAUSED` for a help — and both can be made public later with a
`PATCH` whose schema is `create…Schema.partial()`, where every field is
optional. So "the tick is required by `POST`" leaves a way in: save a draft
with no tick, then publish it. The listing goes public having acknowledged
nothing, and a client would do it without meaning to, because that is simply
what publishing a draft looks like.

The rule is therefore about the transition:

| | |
|---|---|
| not public → public | required |
| public → public | already ticked; asking on every edit teaches people to tick without reading |
| anything → not public | nothing to acknowledge, nobody can see it |

A need that goes back to being a draft and out again is asked again, because
the rule is about the transition and not about the column being empty. A
listing that was withdrawn and is going out once more goes out against today's
list.

**A stale fingerprint is refused with `409 PROHIBITED_LIST_CHANGED`, carrying
the current list.** The request was right when it was written and the world
moved, so a client can show what changed and ask again rather than guessing
what it missed. The cost is a rare, annoying re-tick when the list is edited
while somebody is filling in a form.

**A missing tick is `422`, naming the field. There is no default.** A boolean
that defaults to true is not an acknowledgement, it is a formality the server
fills in on your behalf — and the issue's third criterion is exactly that a
client which simply does not send it cannot get past.

**The field is pulled out of the body before the rest is copied onto the
row.** Everything else a caller sends is spread onto the record; the version
must not be, or a client could write whatever it liked into the column that
records what it agreed to. What lands there is the version this service
checked.

**An empty list is treated as our bug, loudly.** The table is seeded by hand
after a migration, like the categories, and if somebody forgets, the
alternative to a `500` is every posting ticking the fingerprint of nothing and
being recorded as having acknowledged a list with no lines in it. That looks
like success, which is worse than a failure. The real reason goes to the log
and to Sentry (#29); the caller is told nothing about our configuration.

## Alternatives

**A JSON file in the repository.** Reviewable in a pull request, next to the
prose it mirrors, and the fingerprint would be a hash of the file. Rejected on
the issue's first criterion: changing it is a commit, a CI run and a deploy,
which is not something a non-programmer can do.

**An environment variable in Render.** What the sanctioned-country decision
implies, and editable in a web form with no deploy. A legal list of ten clauses
in one variable has no ordering, no slugs, no history, and is one bad paste
from being wrong — and the restart that applies it is a worse way to find out.

**A boolean `prohibitedAccepted` instead of a version.** One column, no
hashing, no 409. It answers "did they tick something" and never "what did they
tick", so the first time a clause is reworded the whole record becomes
unfalsifiable. The hash exists precisely so that an answer given in October is
still meaningful in March.

**Accepting a stale fingerprint and recording it.** Nobody loses a
half-written listing to an edit they had nothing to do with, and the record is
still honest about which wording they agreed to. Rejected because a client that
caches an old version would keep posting against it forever, and because the
one time the list is edited to forbid something new, the postings that matter
most are the ones still ticking last week's wording.

**Asking on every edit.** Simpler to describe — "every write to a public
listing carries a tick". It also teaches people to tick without reading, which
is the one thing this mechanism cannot survive.

**An `Acknowledgement` table, one row per tick.** A full audit trail,
including the tick a draft was saved with and the one it was published with,
and the same shape could later record a tick at registration. Rejected for now
as a table whose extra rows nobody has asked to read: two columns on the
listing answer the question that is actually asked, which is "what did the
author of *this* listing agree to". If a tick ever needs to exist apart from a
listing, that is the table to add.

## Consequences

- **`needBody()` in the test helpers is now async**, and so is the help
  equivalent, because a public posting needs a fingerprint read from the
  database. That rippled through 34 call sites in seven files. It is the
  honest cost of making the tick mandatory, and the alternative — a hard-coded
  fingerprint in the fixtures — is a number somebody has to recompute by hand
  the first time the fixture wording changes.
- **The test harness puts the list back after every truncation**
  (`tests/setup/truncate.ts`), which is the one exception to "a test creates
  the fixtures it needs". An empty table does not mean "no list to bother
  with" any more, it means every posting in the suite is refused.
  `tests/prohibited/acknowledgement.test.ts` replaces that list with its own
  and deletes it outright, which is what keeps the harness honest.
- **Production needs `npm run seed` after this deploy**, for the same reason
  and with a louder symptom than the categories had: postings answer `500`
  until the list exists. `docs/14-deployment.md` says so where the category
  step already is.
- **A moderator can now see what a listing was posted against**, and nothing
  shows it to them yet — there is no field for it in any moderator answer.
  That is deliberate: the column is the record, and the day a takedown needs
  to quote it is the day to put it in the admin API.
- **Nothing inspects a listing.** A need for a prohibited item is accepted,
  recorded, and left to reports and moderation. A test says so, so that nobody
  later reads the acknowledgement as a screening step.
