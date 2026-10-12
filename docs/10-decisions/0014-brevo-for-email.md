# 0014 — Brevo for email, and a borrowed sender address

## Context

`src/mailer.ts` has never delivered anything. In development it writes the
verification token to the log, which is how every local account has been
confirmed; in production it writes a warning saying nothing was sent, and
deliberately does not write the token, because a token in a production log is a
working credential in a place far more people can read than can read the
database.

The consequence was invisible while nothing else worked, and became the whole
blocker once #80 and #81 shipped: `requireVerified` guards 41 routes across 8
routers, so an account that cannot confirm its address can read and do nothing
else. The only account ever verified on production was verified by hand with
`UPDATE "User" SET "emailVerifiedAt" = now()`. #119 is the issue; this is the
choice it had to make.

Two constraints came with it, and together they decided almost everything:

- **Render's free plan blocks outbound SMTP** — ports 25, 465 and 587
  (`docs/14-deployment.md`). Whatever sends mail has to be reachable over
  HTTPS. That is not a preference; it removes every SMTP library from the
  table.
- **Nothing paid, and no card on file.** The same rule that chose Render, Neon
  and B2 (decision 0011).

And one fact nobody had priced in: **Farhand has no domain.** `APP_ORIGIN` is
the API's own `onrender.com` address, a placeholder until #93. Every provider's
free tier assumes a domain you control, because that is what DKIM signs.

## Decision

**Brevo, over its HTTP API, sending from a project address that Brevo has
verified, with the sender rewritten by Brevo and no Reply-To at all.**

| | |
|---|---|
| Free tier | 300 emails a day, no expiry, no card |
| Transport | `POST https://api.brevo.com/v3/smtp/email` — HTTPS, despite the path |
| Sender | `MAIL_FROM`, an address Brevo has verified |
| Visible From | rewritten by Brevo to `<local part>@<id>.brevosend.com` |
| Reply-To | none, unless `MAIL_REPLY_TO` is set |
| Volume needed | a handful a day: registrations, resends, password resets |

**The sender is rewritten and that is accepted, for now.** A `gmail.com`
address cannot be DKIM-authenticated, because the domain is not ours to sign
for, so Brevo replaces the domain part of the From with one of its own and
delivers the message authenticated by itself. Brevo calls this a stopgap and
warns that recipients may not recognise the address. For a code somebody asked
for ten seconds earlier it is a reasonable trade, and it is the only free one
available without buying a domain. The moment there is a domain, the fix is
three DNS records and a change to `MAIL_FROM` in Render — no release.

**No Reply-To.** A reply to a rewritten From goes nowhere, so the only way to
make replies work today would be to put a personal address in the header of
every message sent to every stranger who registers. A verification email does
not need replies. `MAIL_REPLY_TO` exists for the day there is an address that
belongs to the project rather than to a person.

**Every part of it is a setting**, all-or-none for the pair that matters:
`MAIL_API_KEY` and `MAIL_FROM` are refused separately by `src/env.ts`, exactly
as the five `STORAGE_*` variables are, so a half-configured provider cannot
start. Moving to a domain is then a dashboard change rather than a pull
request.

**No SDK.** One `fetch` to one URL, in one file, which is also what makes the
request testable without a network: `transport.send` is spied on by most tests
and exercised against a stubbed `fetch` by a few. An SDK would add a dependency
and a mock of somebody else's object model to test the same three fields.

## Alternatives

**Resend**, the obvious modern choice, and it cannot do this job at all without
a domain: its shared `resend.dev` sender refuses every recipient except the
account's own address (`403 You can only send testing emails to your own email
address`). Good product, wrong prerequisite. It is the first thing to revisit
once Farhand owns a domain.

**SMTP through anybody** — Gmail, a mailbox provider, a relay. Not available:
Render's free plan blocks the ports.

**Buying a domain** (about €10 a year) would give a clean, authenticated sender
and remove the rewriting entirely. It also breaks the rule that nothing here
costs money, so it is the owner's call rather than this document's; it was
offered and declined for now.

**Mailjet, SendGrid, MailerSend** and the rest land in the same place: a free
tier that needs either a domain or a card, or both, and the same inability to
authenticate a free-mail sender. None of them beats 300 a day with no card.

**Postponing #119** until there is a domain. Rejected because the site is
unusable by anybody but its author until mail works, and because the rewriting
is cosmetic rather than a correctness problem.

## Consequences

- The From address looks foreign, which is the one thing most likely to put a
  verification email in a spam folder. If that turns out to happen, the answer
  is a domain, not a different provider.
- The free plan appends **"Sent with Brevo"** to the message and it cannot be
  removed at any price on Free.
- **Brevo can see the tokens.** The code is in the body of the message, so it
  is in the provider's logs for as long as they keep them. That is inherent to
  having somebody else deliver mail, and the mitigation is the token's life:
  24 hours for a confirmation, one hour for a reset. Nothing else about an
  account is ever in a message.
- A send that fails is logged and reported, and the request that caused it
  still succeeds. So a person can register during a Brevo outage, receive
  nothing, and have no idea why — `POST /auth/resend-verification` (#41) is
  the way back, and it is the reason that endpoint exists.
- 300 a day is a ceiling with no warning before it. At the current volume it is
  unreachable; the day it is reachable, Farhand has other problems and a reason
  to pay for something.
- Mail is still sent inside the request. #85's queue is where that stops being
  true, and this decision deliberately does not do half of it.
- The message is a **code** rather than a link, because there is no page for a
  link to land on. #93 changes that, and it changes the copy in `mailer.ts`
  only.
