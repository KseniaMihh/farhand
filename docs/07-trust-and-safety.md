# Trust and safety

Version 1 handles no money, so the platform's exposure is smaller than it looks.
The design still has to be honest about what it cannot promise.

## What Farhand promises, and what it does not

| Promises | Does not promise |
|---|---|
| A record of what was agreed and when | That either side keeps the agreement |
| A way to report and block accounts | Recovery of lost money |
| Reputation built from completed deals | Verified identity |
| Private receipts and evidence for disputes | Insurance, refunds or compensation |

This is shown to users in plain language before the first payment step, not
buried in terms of service.

## Threats and mitigations

| Threat | Mitigation in V1 | Later |
|---|---|---|
| Fake accounts, spam listings | Email confirmation; limit on open listings; rate limits | Phone or ID verification |
| Helper takes the money and disappears | Reputation, reports, bans; requester warned before paying | Escrow via payment provider |
| Requester never reimburses | Helper does not buy until paid | Escrow |
| Prohibited or illegal items | Prohibited list at posting time, reports, moderation | Automated screening |
| Harassment in messages | Report on every message, moderator visibility, block; 20 messages a minute per sender, so flooding somebody's inbox takes effort | Filtering |
| Fake reviews | Reviews only after a `COMPLETED` deal, one per side | Anomaly detection |
| Scraping personal data | Profiles show display name and country only; no email addresses anywhere in the API | Rate limiting per IP |
| Another website acting as a signed-in user | `SameSite=lax` on the session cookie, and every write must carry an `Origin` or `Referer` matching `APP_ORIGIN` | — |
| One machine hammering the API | 300 requests a minute per address, above the specific limits on login and messages | Something distributed, once there is more than one instance |
| A browser misreading an answer | `helmet`: `nosniff`, no framing, a referrer policy, HSTS in production | — |
| An error message that explains our infrastructure | In production the body is `{ code: "INTERNAL", message: "Something went wrong" }` and nothing else | — |

## How the browser is kept honest

The session is a cookie, which browsers attach to a request whatever page caused
it — the cost recorded in docs/10-decisions/0007-sessions-over-jwt.md. Two
things answer for it:

1. **`SameSite=lax`**, so the cookie is not sent on a cross-site write at all.
2. **An `Origin` check** on every `POST`, `PATCH` and `DELETE`, because the
   first depends on cookie attributes staying right forever, and because a
   request whose provenance we cannot see is not one to trust with somebody's
   session. Missing *both* headers is refused too: every real browser sends one.

An `Origin` is compared exactly, and a `Referer` is parsed and compared as an
origin. `https://farhand.ee.evil.example` begins with our origin as text and is
a different site; a prefix match is precisely how it would get in.

Reads are deliberately left alone. A `GET` changes nothing, CORS already stops
another page from reading the answer, and refusing them would break every link
and bookmark.

## A known advisory, and why nothing was done

`npm audit` reports high-severity advisories in `mysql2` and `deepmerge-ts`.
Both arrive through the **Prisma CLI**, which is a development dependency, and
`mysql2` is a driver for a database this project does not use. Nothing
vulnerable is shipped or executed.

The offered fix downgrades Prisma 7 to 6, which is exactly the trap
docs/11-risks.md records about `npm audit fix --force`. The decision is to leave
it, and to recheck when Prisma releases a version with the dependency bumped.
An advisory nobody has explained is worse than one written down.

## Prohibited items

Worldwide scope means Farhand cannot enumerate every country's rules. The list
below is the floor; users remain responsible for their own country's law.

Never allowed: weapons, ammunition and parts; drugs, including prescription
medicines; alcohol and tobacco; live animals; perishable food; hazardous or
flammable goods; counterfeit goods; adult content; anything requiring an export
or import licence; anything whose purchase or shipment is restricted by
sanctions.

Enforcement in V1 is a checkbox acknowledgement at posting time, a visible list,
and reports. There is no automatic detection, and that limitation is documented
rather than hidden.

## Sanctions and export control

A worldwide platform can be misused to move goods into sanctioned jurisdictions.
Farhand's V1 answer is a country allowlist: countries under comprehensive
sanctions are not selectable as `buyCountry` or `deliverCountry`. The list lives
in configuration, not in code, so it can be updated without a deployment. This
is a genuine legal risk and is recorded in `11-risks.md`.

## Customs, duties and VAT

Farhand states clearly that the recipient is usually liable for import duties
and VAT, that the declared value must be truthful, and that under-declaring to
avoid duty is illegal. The platform never suggests a declared value.

## Moderation workflow

1. A user reports content or an account, with a reason.
2. The report enters the moderator queue, ordered oldest first.
3. A moderator reviews the target and, for message reports, the surrounding
   conversation.
4. The moderator resolves it: dismiss, hide the content, or act on the account.
5. A resolution note is required, and every action is written to `AdminAction`.

Moderators can read a conversation only when it is attached to a report or a
disputed deal. That restriction is enforced in the service layer and logged.

Concretely, a moderator gets in through one of exactly two openings:

- an **open** report whose target is a message in that conversation
- the deal on that proposal is `DISPUTED`

Neither answers `404`, the same as for anybody else — "you may not read this
particular thread" would confirm it exists. Resolving the report closes the
thread again: the permission comes from the reason, so it ends when the reason
does.

The access itself goes to the **application log**, not to `AdminAction` — one
line naming the moderator, the conversation and which opening allowed it.
`AdminAction` is a record of decisions taken about an account, and reading is
not a decision. The log line is what makes "enforced in the service layer and
logged" checkable afterwards.

Reporting itself is narrower than reading: a report about a message can only be
filed by one of the two people in the conversation, and a moderator's read
access does not extend to reporting on their behalf.

## Dispute handling

Farhand does not arbitrate. A moderator's role is to look at the deal history and
the conversation, decide whether an account behaved abusively, and act on the
account. Money is between the two people. Saying this clearly is more honest
than implying protection that does not exist.

## Privacy and GDPR

The project is built from Estonia, so GDPR applies even to a portfolio version.

- Only necessary data is collected; no date of birth, no address in the database
  in V1.
- Passwords are hashed with argon2id; session and verification tokens are stored
  hashed.
- Account deletion anonymises personal data while keeping deal records, which is
  a legitimate interest that must be documented.
- Data export on request is a V2 feature.
- Delivery addresses are exchanged in messages in V1. This is a deliberate
  simplification with a privacy cost, recorded as an open question.

## Age

Users must be 18 or older. Version 1 asks for confirmation only; there is no
verification.
