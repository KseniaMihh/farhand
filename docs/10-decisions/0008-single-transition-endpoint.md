# 0008 — One transition endpoint per deal, not one endpoint per status

## Context

A deal moves through nine states with rules about who may perform each change.

## Decision

A single `POST /deals/:id/transition` endpoint taking a target status, validated
against one transition table shared by the whole application.

## Alternatives considered

**An endpoint per action** (`/ship`, `/deliver`, and so on). More
self-documenting, but the rules end up duplicated across handlers, and adding a
state means touching many files.

**Letting the client set the status directly.** Unsafe; the client would be
deciding the rules.

## Consequences

- The transition table is the single place where the lifecycle is defined, and
  it can be tested exhaustively.
- The endpoint is less self-describing, so `04-deal-lifecycle.md` and the API
  contract carry that weight.
- Transition-specific data (tracking number, actual postage) travels in the same
  request body and is validated per target status.
