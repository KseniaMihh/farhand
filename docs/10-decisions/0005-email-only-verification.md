# 0005 — Email confirmation is the only identity check in version 1

## Context

A cross-border favour platform depends on trust, and the scope is worldwide.
Verification options range from an email link to full document checks.

## Decision

Email confirmation only, combined with limits on open listings, rate limiting,
reports, reputation from completed deals, and account blocking.

## Alternatives considered

**Phone verification.** Costs money per message, adds friction, and proves
little across many countries.

**Document verification via a provider.** Genuine trust, but expensive, and it
would make Farhand a processor of identity documents under GDPR.

## Consequences

- Registration stays frictionless, which matters when there are few users.
- Fake accounts are possible; the design limits what they can achieve, since no
  money passes through the platform.
- Reputation only becomes meaningful after deals complete, which is slow at the
  start. This is accepted.
