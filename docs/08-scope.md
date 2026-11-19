# Scope

The purpose of this file is to make it obvious when something is out of scope,
so that new ideas become entries in a list instead of unplanned work.

## Version 1 — the learning core

Accounts: registration, email confirmation, login and logout, sessions, password
reset, public profiles, account deletion.

Listings: needs and helps with create, edit, delete; browsing with country and
category filters; cursor pagination.

Matching: proposals in both directions, accept, decline, withdraw; conversations
and messages with unread counts.

Deals: quotes, the full status lifecycle, the event log.

Moderation: reports, moderator queue, warn, suspend, ban, content hiding, audit
log.

Engineering: strict TypeScript, request validation, layered structure, automated
tests, CI, Docker, one cloud deployment, structured logging and error tracking.

**Version 1 is finished when** a full journey from registration to a completed
deal works against the deployed API, with tests passing in CI.

## Version 2 — trust and polish

File uploads for product photos and receipts; reviews and ratings; email
notifications through a background job queue; the prohibited-items
acknowledgement flow; saved searches; a data export endpoint; the Next.js
frontend as a separate project.

**A landing page** belongs to that last item and is named here because it was
not obvious that it did (#168). It is not a promotion into version 1 and
displaces nothing, so rule 4 is answered rather than bent: the frontend is a
version 2 line already, and a frontend whose first screen is a list of other
people's needs has not said what the product is. The trust rules in
`07-trust-and-safety.md` also only work on somebody who has read them, and
until there was a front door there was nowhere to say them.

**Rendering the public lists on the server** — a version 2 idea with a
warning attached, and the warning is why it is written down. A server
component would fetch the API from Vercel's own machine, without the vouch
header, so every visitor's browsing would count as **one** caller against the
global by-address limit — which is the bug #164 closed, returning by another
door. It would also make the page wait for an API that sleeps. Anyone
"optimising" a list into a server component has to solve the vouch for
server-side calls first (decision 0035).

## Version 3 — if it ever becomes real

Payments held until delivery, using a provider such as Stripe Connect; identity
verification; real-time messaging; multi-language interface; mobile apps.

## Not doing, deliberately

| Idea | Why not |
|---|---|
| Farhand handling money in V1 | Financial licensing, anti-money-laundering obligations, and it is not needed to learn the backend |
| Automatic currency conversion | Rates go stale; the two people agree an amount |
| Ratings before a deal completes | Invites fake reviews |
| Public real names | No benefit, real privacy cost |
| Chat with typing indicators and presence | Large effort, no learning value here |
| Microservices | One well-built service teaches more |
| GraphQL | REST is what junior job postings ask for |
| Mobile apps | The web works everywhere |
| Recommendation algorithms | There is no data to recommend from |

## How to add something

Anything not listed above goes into version 2 by default. Promoting it into
version 1 requires writing down what it replaces, because the scope of version 1
does not grow.
