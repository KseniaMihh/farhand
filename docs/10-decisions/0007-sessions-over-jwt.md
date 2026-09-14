# 0007 — Server-side sessions in an httpOnly cookie, not JWTs

## Context

The API needs authentication for a browser-based frontend, with the ability to
block accounts immediately.

## Decision

A random session token, stored hashed in the `Session` table, delivered in an
httpOnly, Secure, SameSite cookie.

## Alternatives considered

**Stateless JWTs.** No database lookup, but they cannot be revoked before
expiry, which conflicts directly with banning an account. Storing them in
localStorage also exposes them to cross-site scripting.

**JWT plus a refresh-token table.** Ends up with the same database lookups as
sessions, with more moving parts.

## Consequences

- Banning or suspending an account takes effect immediately.
- Users can see and revoke their own sessions.
- Every authenticated request costs one indexed lookup, which is acceptable.
- CSRF must be handled, since cookies are sent automatically.
