# 0016 — A receipt is evidence, not a possession

## Context

#82 adds the third and last upload: the receipt a helper gets when they buy
somebody else's shopping. `File.dealId` and both purposes have existed since
#79, and the rule about who may read one — the two people in the deal, and
moderators — has been written and tested since then.

What #79 did not decide is the behaviour around it, and three questions had to
be answered before any code:

1. Does a receipt have to exist before a helper can say they have bought the
   thing? `docs/04-deal-lifecycle.md` said "allowed", which is not the same as
   "decided".
2. Can the person who uploaded one take it down again?
3. How many, and of what kinds?

The thing that answers all three is what a receipt is **for**. Nobody uploads
one for their own benefit. It exists so that if the two sides disagree about
what was paid, or a moderator has to judge which of them is right, there is
something to look at. It is evidence, held by one person, about a transaction
between two.

## Decision

**Allowed, never required.** `PRODUCT_PAID → PURCHASED` checks nothing about
files. A receipt is evidence for a dispute, not a gate on the deal: requiring
one would stop an honest purchase over a lost slip of paper, and would collect
blurred pictures of nothing from people who only want the button to work. The
transition table is unchanged.

**Append-only — nothing deletes a receipt.** There is no endpoint, for anybody,
including the helper who uploaded it. A wrong one is followed by a right one
and both stay, and a moderator looking at two is looking at the truth. This is
the opposite of #81's photos, which their owner may remove freely, and the
difference is exactly the one above: a photo is the requester's description of
what they want, while a receipt is a claim about what somebody else's money
bought. `DELETE /me` already keeps receipts for this reason (#66).

**Three of each kind, counted separately.** A purchase is not always one piece
of paper — two shops, or a till roll too long for one frame — and postage is
its own receipt. Separate budgets because a deal with three product receipts
and no proof of postage is the shape of a mistake; three rather than six
because the ceiling exists to stop a deal becoming an album.

**And the one that is not a product decision:** a photographed receipt is
re-encoded at 2000 px with no metadata, while **a PDF is stored exactly as it
arrived**. Nothing in this project can rewrite a PDF safely, and a receipt
emailed by a shop carries no camera position to strip — unlike a photograph of
one, which was taken where somebody lives, and which is about to be shown to a
stranger they are trading with.

## Alternatives

**Required for `PURCHASED`.** Every purchased deal would carry proof. Rejected
because the cost falls on the honest case: a helper who threw the receipt away,
or bought something with no paper at all, cannot proceed — and the ones who
would lie are exactly the ones who will photograph anything to get past a
check. Evidence collected under duress is not evidence.

**Required above some amount.** Targets the deals worth disputing and
introduces a rule with a number in it that nobody can guess from outside. If
the product ever grows a fraud problem this is where to look again.

**Replaceable while the deal is live.** Kinder to mistakes — an upside-down
photo, the wrong receipt. Rejected because it lets evidence be withdrawn at
exactly the moment a dispute starts brewing, which is when it is worth the
most.

**Deletable by a moderator only.** Safe, and it adds a moderation endpoint
nobody asked for. If something is uploaded that should never have been, the
answer today is the same as for any other file: a moderator can see it, and
removal is a support action rather than a feature.

**One of each kind.** The smallest rule, and it breaks on the first two-shop
errand.

## Consequences

- A deal can be completed with no proof of anything, and the product is honest
  about that: the receipt helps a dispute, it does not prevent one.
- Storage grows with receipts that are wrong, superseded, or both, and none of
  it can be cleaned up by the people who created it. At six files per deal this
  is arithmetic nobody needs to worry about yet.
- A mis-uploaded receipt — the wrong shop, somebody else's purchase — cannot be
  withdrawn by its owner. That is the accepted cost of the rule, and it is why
  the limit is three rather than one: there is room to correct it.
- **A moderator reading one is logged** (`services/files.ts`): the file, its
  purpose, and which deal it belongs to. Reading is not a decision, so no
  `AdminAction` is written, but a power that leaves no trace is one nobody can
  ask about afterwards. The same line now covers a need's photo, which #81
  allowed a moderator to see and recorded nothing about.
- The two kinds mean two allowlists of deal statuses, and `DISPUTED` is in
  both. A dispute is when somebody most wants to show what they paid.
