# 0009 — One proposal per helper per need, for good

## Context

`Proposal` carries `@@unique([needId, helperId])`, added in #19. It takes no
notice of status, so once a helper has proposed on a need — whatever became of
that proposal — they can never propose on it again.

Two of our own documents then described opposite behaviour, which is what #68
was opened to settle:

- `06-api-contract.md` states the constraint plainly and calls it deliberate:
  *"Withdrawing is not undo … a proposal is a record that the two of them have
  already been in touch about this, not a message that can be unsent."*
- `04-deal-lifecycle.md`, under edge cases, said *"Both people want to redo a
  cancelled deal → Create a new proposal."* With the same two people, they
  cannot. That row predates the constraint and was never revisited.

The contradiction is narrow but real. Cancelling a deal reopens the need
(`06-api-contract.md`), so the need is public again and other helpers can
propose — but not the one whose deal was just cancelled.

## Decision

**The constraint stays as it is, and `04-deal-lifecycle.md` is corrected.**

Two people who cancel a deal cannot redo it on that need. A different helper can
propose on the reopened need immediately, and the requester can post a fresh
need if they want the same helper again.

## Alternatives considered

**Free the slot when a proposal is settled** — a partial unique index covering
only `PENDING` and `ACCEPTED`. It fixes the edge case, and it also silently
reverses #19: withdrawing becomes undo, and a helper can withdraw and re-propose
at the same requester as often as they like. The constraint is one of the few
anti-nuisance rules in version 1 that costs nothing to enforce, and this would
trade it away for a rare case with a workaround.

**Free the slot only after a cancelled deal.** Faithful to exactly what the
document described and nothing more. But no index can see `Deal.status` from
`Proposal`, so the rule would move half into application code — and the point of
this constraint is that the database is what guarantees it. A guarantee that
holds *unless the application forgets* is a weaker thing than the one we have.

Both alternatives also mean a migration and new behaviour in a version whose
scope is closed (`08-scope.md`, rule 4).

## Consequences

- The database keeps a rule that the application cannot get wrong, and there is
  one fewer state for the proposal endpoints to reason about.
- Two people who cancelled by mutual mistake — wrong price, bad timing — cannot
  simply try again on that need. The cost is one new need, and the honest
  version of this trade is that the rare case pays for the common one.
- `04-deal-lifecycle.md` now says which helper can come back and which cannot,
  rather than implying both can.
- The behaviour was already pinned by tests before this decision was written:
  `tests/deals/cancellation.test.ts` covers both halves — a new helper may
  propose on the reopened need, and the original helper may not. The second of
  those asserts the need is `OPEN` first, so it cannot pass for the wrong
  reason.
