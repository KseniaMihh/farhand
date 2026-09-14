# 0006 — Money is stored as integer minor units with a currency code

## Context

Deals involve product cost, postage and an optional thank-you amount, in
whatever currency the two people use.

## Decision

Every amount is an integer in the currency's smallest unit, stored alongside an
ISO 4217 currency code. One currency per deal. No conversion is performed.

## Alternatives considered

**Floating point.** Cannot represent decimal amounts exactly; the classic source
of one-cent errors.

**A decimal type.** Correct, but heavier in JavaScript, where integers are
simpler to handle safely.

**Converting everything to a base currency.** Requires live rates and creates
disputes when the rate moves.

## Consequences

- Formatting for display is the application's job.
- Currencies without minor units need care if they are ever supported.
- A database CHECK constraint guarantees amounts are never negative.
