# 0025 — A moderator sees what a ban hides

Supersedes the third consequence of
[0024](0024-a-moderators-view-of-a-person.md), which recorded this gap as
open and said the shape carried no `avatarUrl`. It does now.

## Context

#81 found that taking a reported need down hid the picture it was taken down
for, from the only people allowed to look at it, and fixed it in two halves:
`isVisibleTo` admits a moderator to a `NEED_PHOTO` whatever the need's status,
and `GET /admin/reports/:id` carries the need's photo ids so a moderator has
something to ask for. Its lesson: *a rule that admits a moderator to an address
nothing gives them is dead code; a path they are not allowed to follow is a
404.*

The avatar branch of the same function was left as it was, answering by the
owner's status alone — `ACTIVE` or `SUSPENDED` is visible, anything else is
not, with no moderator case at all. #95 noticed while narrowing the report
target, and #139 is that gap.

It is the same shape of bug as #81's, one step further on. A report about a
person is how an obscene or impersonating picture gets reported: `ReportTarget`
has `USER`, `ReportReason` has `SEXUAL_CONTENT`. A ban is what a moderator does
about one. And the ban made the picture unreadable by everybody — including the
moderator who had just acted, and including whoever reviews that decision
afterwards. The evidence disappeared at the moment it was acted on.

## Decision

**The avatar rule gets the moderator fallback the other purposes have.**
Everybody may see an avatar while the account is live; otherwise a moderator
may, and nobody else:

```ts
if (owner?.status === "ACTIVE" || owner?.status === "SUSPENDED") return "yes";
return isModerator(viewer) ? "moderator" : "no";
```

**Uniform, rather than a list of statuses.** The alternative was naming the
cases a moderator may see — `BANNED`, and not `DELETED` — which reads tighter
and is not. This fallback can only ever add a case the public has already been
refused, so the two lines cannot disagree, and nothing has to be kept in step
with the line above when a status is added one day. `DELETED` costs nothing to
include because #66's erasure deletes an avatar's row and its bytes: a deleted
account has no avatar to argue about, and the rule does not have to know that.

**`ReportedUser` carries `avatarUrl`** — the second half, without which the
first is dead code. A path on this API rather than a signed link, like every
other image (decision 0012): `GET /files/:id` decides afresh who may follow it,
which is what makes a path safe to put in a reply. This is the only place in
the API that hands anybody an avatar's id other than the person's own profile.

**The read is logged, and only when it is a power being used.** The
`"moderator"` verdict already writes `moderator read a file` with the file, its
purpose and the moderator (#82), so a banned account's avatar is recorded the
way a receipt and a removed need's photo are. A **live** account's avatar is
`"yes"` for everybody, so a moderator looking at one writes nothing: it is a
public picture, and a log full of public pictures buries the lines that mean
something.

## Alternatives

**Leave it, and let a moderator ask the operator.** What 0024 did, deliberately
— it was a known gap with an issue number against it, not an oversight. It
stopped being defensible the moment the report target was being rewritten
anyway: the fix is six lines and one field, and the alternative is a moderation
decision nobody can review.

**Name the statuses a moderator may see.** `BANNED` only, so the rule says
exactly what it means. Rejected above: two lists that must agree, and the day
somebody adds a status they have to remember both.

**Let a moderator see any avatar, and log every read.** Simpler to state, and
it turns thirty public pictures on a page into thirty audit lines when a
moderator happens to browse. The audit log's value is that a line in it means
something.

**Put the whole avatar in the report target** — the bytes, or a signed link.
Rejected for the reason decision 0012 gives: a path is re-checked on every
follow, a signed link is a five-minute bearer token for an image, and a report
view is exactly the kind of thing that gets quoted into another window.

## Consequences

- **A moderator can now follow a report about a person to the picture**, before
  and after they act on it, and a second moderator can check that decision. The
  test runs both halves in that order, because the second is the one that used
  to fail.
- **The pinned key set in `tests/admin/moderation.test.ts` changed**, which is
  the tripwire #95 built doing its job: adding a field to a moderator's reply
  is an edit to the test that records what that reply contains.
- **Three purposes now have the same fallback**, and that is now the pattern
  rather than a coincidence: an avatar, a need's photo and a receipt. The one
  thing to notice if a fourth purpose is ever added is that `isVisibleTo` is
  the only place this rule lives, which is why it is a `switch` that the
  compiler makes exhaustive.
- **An avatar is still deleted with the account**, so "a moderator may see it"
  never means "forever". Erasure wins over evidence here, which is the opposite
  of a receipt (decision 0016) and right for the same reason: a receipt is the
  other person's evidence, a profile picture is only ever your own.
