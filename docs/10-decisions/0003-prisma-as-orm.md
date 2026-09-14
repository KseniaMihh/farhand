# 0003 — Prisma for database access and migrations

## Context

The API needs typed database access and a repeatable way to evolve the schema.

## Decision

Prisma 7, pinned. Hand-written SQL in migrations where Prisma cannot express
something.

## Alternatives considered

**Drizzle.** Closer to SQL, lighter, but fewer learning resources.

**Raw SQL with a query builder.** Best for learning SQL, slowest to build with.

**TypeORM.** Older, and its migration story is less pleasant.

## Consequences

- The schema is a single readable source of truth, and the client is typed.
- Prisma does not know about hand-written indexes, so every generated migration
  must be read before it is applied.
- Prisma 7 keeps the connection URL in `prisma.config.ts`, not in the schema.
- The version is pinned, because `npm audit fix --force` will otherwise downgrade
  it to a major version behind.
