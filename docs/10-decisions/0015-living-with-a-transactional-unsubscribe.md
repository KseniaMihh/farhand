# 0015 — Living with an unsubscribe button on a confirmation email

## Context

Decision 0014 chose Brevo for email, over its HTTP API, sending from an address
whose domain Brevo rewrites because Farhand owns no domain. #119 built it and
it works: the first real message on the live site arrived in the inbox, and the
code in it confirmed an account.

It arrived with an **unsubscribe button**, which Gmail renders from the
`List-Unsubscribe` header Brevo attaches. #121 was opened to find out what that
costs, because the only email this product sends is authentication: clicking it
blocklists the address for our sender, so the person gets no confirmation code
and no password reset, ever, while `POST /auth/register` and
`POST /auth/forgot-password` go on answering exactly as they always do — the
identical-answer rule from #9 (`06-api-contract.md`, "Authentication") working
as designed, and hiding this as a side effect.

This record is the answer to #121. It **extends** 0014 rather than replacing
it: Brevo stays, for now, for the reasons 0014 gives.

## What was established

| Question | Answer | Source |
|---|---|---|
| Can Brevo be asked not to attach the header? | **No.** It is added automatically to campaigns and transactional mail alike. Swapping it for `List-Help` is an **Enterprise** feature, and the conditions Brevo attaches to that swap describe our mail exactly: triggered by the recipient, no promotional content | Brevo help centre, "About list-unsubscribe and list-help headers" |
| Does an authenticated domain of our own change it? | **No.** The header is a property of the platform's sending, not of who signs the mail. A domain fixes the rewritten sender and the spam risk from 0014 — a different problem | Same, and the absence of any statement tying the two |
| Do other providers treat transactional mail differently? | **Yes, decisively.** Resend does not manage lists for transactional sends at all: no header unless you add one. SendGrid has `bypass_unsubscribe_management` for precisely this case | Resend docs, "Add an unsubscribe link to transactional emails"; Twilio SendGrid suppressions docs |
| Does either work without a domain? | **No**, which is what eliminated them in 0014 and still does | 0014 |
| Can a blocked address be detected? | Partly. `GET /v3/smtp/blockedContacts` lists them and Brevo's own log shows a `blocked` status. **Whether our send fails or quietly succeeds is untested** | Brevo API reference; see `11-risks.md` for the experiment |

## Decision

**Keep Brevo, accept the risk, write it down, and fix it when the domain
arrives.** Nothing in the code changes.

The fix is not one setting or one header — it is **a domain plus a provider
that distinguishes transactional mail from marketing**, two things that are
bought and configured together. A domain is bought when there is a frontend to
put on it, which is #93. Doing it sooner means paying for a domain now, which
breaks the rule that nothing here costs money, to protect users who do not
exist: the only addresses in the production database are the author's own test
aliases.

**The trigger is "before the first real person who is not the author
registers"**, which in practice is #93 going live. The work at that point:
authenticate the domain, move to Resend or SendGrid, and send with no
unsubscribe header.

Until then, `14-deployment.md` carries a runbook for one person who says they
never received an email, because a support path that exists only in somebody's
memory is not a mitigation.

## Alternatives

**Buy a domain now and move provider.** The real fix, done early. Rejected
because it spends money to protect nobody, and because the domain is a decision
with its own consequences — the name, `APP_ORIGIN`, the links in emails — that
belongs with the frontend rather than ahead of it.

**Pay Brevo for Enterprise.** The only way to remove the header while staying
put. Not a candidate at any price for this project.

**Send from a second sender address for authentication**, on the theory that an
unsubscribe blocks per sender. It would move the problem rather than solve it:
the second sender's first unsubscribe does the same thing, and we would have
two senders to authenticate the day a domain appears.

**Suppress the button in the message body.** Not possible: the button is drawn
by the mail client from a header, not from anything in our HTML — and our mail
is plain text with no link in it at all.

**Detect and react**: call Brevo's blocked-contacts API before each send, or
take their webhook, and tell the person something different. Rejected for now
as the wrong shape of work — a pre-send check adds a network call to every
registration, and a webhook is a new public endpoint, both for a condition
nobody can currently reach. If it is ever built it belongs with #86, which is
where notification state lives.

## Consequences

- **A person who clicks unsubscribe is locked out and nobody is told.** That is
  the accepted risk, in full, and `11-risks.md` states it in those words.
- **We may not even know.** Whether a send to a blocked address errors or
  silently succeeds was not tested, so the honest position is that our logging
  may or may not notice. The experiment is written down rather than guessed at.
- The runbook in `14-deployment.md` is the only mitigation in place:
  `GET /v3/smtp/blockedContacts` to see the list, and
  `DELETE /v3/smtp/blockedContacts/{email}` to undo a block **that was a
  mistake** — Brevo warns that unblocking somebody who genuinely asked to be
  blocked can get an account suspended, so the runbook says to ask first.
- The test alias from #119 must not be unsubscribed; it is the address that
  proves the pipeline works.
- This is now one of the things #93 has to carry, alongside the verification
  **link** that cannot exist until there is a page to land on (0014) and the
  signed links a list response could embed (0012). Three separate decisions
  waiting on the same event is worth noticing when that issue is planned.
