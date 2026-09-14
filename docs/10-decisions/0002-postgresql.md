# 0002 — PostgreSQL as the database

## Context

The data is highly relational: users, needs, proposals, deals, events. Rules
such as "one live deal per need" and "ratings are 1–5" must hold absolutely.

## Decision

PostgreSQL, run locally in Docker.

## Alternatives considered

**MySQL.** Capable, but weaker support for partial indexes and array columns.

**MongoDB.** Poor fit: the relationships are the point, and it cannot enforce
these constraints.

**SQLite.** Excellent for tests, but not what the deployment target will run.

## Consequences

- Constraints and partial indexes are available and used.
- The local version matches the intended production version.
- Docker is required for local development.
