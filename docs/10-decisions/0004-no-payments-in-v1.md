# 0004 — Farhand does not handle money in version 1

## Context

Holding money between two parties is what would make the platform trustworthy.
It also brings financial regulation, anti-money-laundering obligations and real
operational risk.

## Decision

Version 1 records amounts and confirmations. The two people pay each other
directly. Farhand never receives, holds or transfers funds.

## Alternatives considered

**Stripe Connect with delayed payout**, as Grabr uses. Genuinely better for
users; disproportionate for a portfolio project and legally significant for a
sole individual.

**A tipping link only.** Half a solution with most of the complexity.

## Consequences

- The lifecycle is identical either way; only the confirmation steps would be
  replaced by real payments, so adding escrow later is not a rewrite.
- Users carry the counterparty risk, which must be stated plainly rather than
  implied away.
- The scam risk is smaller than it appears, because Farhand never becomes a
  place where money sits.
