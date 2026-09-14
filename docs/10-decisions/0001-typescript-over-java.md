# 0001 — TypeScript and Node for the backend, not Java and Spring Boot

## Context

The developer's existing depth is TypeScript and React. The Estonian market has
a large Java and Spring Boot sector (banks, e-government, consultancies) and a
separate TypeScript sector (product companies and startups).

## Decision

Build the Farhand API in Node.js with TypeScript. Learn Spring Boot afterwards,
as a second project.

## Alternatives considered

**Java with Spring Boot now.** Strong market, imposed architecture, but means
learning a language, an ecosystem and backend concepts simultaneously. Estonian
Java openings skew mid and senior.

**Python with FastAPI.** Pleasant, but adds a third language without matching a
target market.

## Consequences

- One new thing to learn instead of three; a finished project sooner.
- Structure is not imposed by a framework, so it must be chosen deliberately:
  strict TypeScript, Zod validation, a layered structure, linting and tests in CI.
- Rebuilding the same API in Spring Boot later becomes a strong second portfolio
  piece, since the domain is already understood.
