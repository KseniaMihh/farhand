# 0010 — Render's free tier instead of Fly

## Context

TODO(#96): Fly ended free allowances for new accounts; the trial runs out on
2026-10-06. The project has no paid layer by intent. What docs/14-deployment.md
chose Fly for, and which of those reasons survive the move.

## Decision

TODO(#96): Render free web service, Frankfurt, Docker. Migrations move from the
platform to CI. CI tells the new version from the old one by the commit in
`GET /health`.

## Alternatives considered

TODO(#96): paying for Fly; no hosting at all until there is a frontend; Cloud
Run (card required); Render's API key to poll deploys (account-wide
credential); `autoDeployTrigger: checksPass` (would deploy before CI migrates).

## Consequences

TODO(#96): cold starts; the old version runs against the new schema for the
length of a build; Neon credentials now also live in GitHub; what would make a
paid host worth it again.
