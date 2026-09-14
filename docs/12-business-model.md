# Business model — how Farhand could work as a live platform

Version 1 has no revenue and that is correct. This document is about what
happens if Farhand ever becomes a real service: how comparable platforms make
money, what would actually fit a goodwill model, and what the constraints are.

Nothing here changes the version 1 scope in `08-scope.md`.

---

## 1. How comparable platforms make money

### 1a. Take-rate marketplaces (Grabr and similar)

Grabr's fee structure has three separate parts. The shopper pays the product
price, a traveller reward, and a Grabr service fee. Grabr's own help pages
describe the traveller reward as typically 10–20% of the item's total cost, with
a minimum of about $5, and describe the Grabr fee as a service fee charged to
shoppers to cover operations and support. Grabr collects the money when the bid
is accepted and pays the traveller after delivery.

The important structural point: **the platform's revenue is a separate line item
from the helper's reward.** The helper's payment is not the platform's income.

### 1b. Service businesses (package forwarders)

Forwarders do not take a commission on the goods at all. They charge for the
service around them:

| Model | Example | Shape |
|---|---|---|
| Subscription | MyUS Premium, roughly $10/month or about $60/year | Recurring, unlocks consolidation and better rates |
| Pay-per-shipment | Stackry, roughly $1.50–$3 per outbound shipment | No recurring fee; charges for what you use |
| Percentage handling fee | Shipito, around 5% of declared value | Scales with order value |
| Paid add-ons | Consolidation ~$2, repacking ~$5, extra photos, hazmat handling | Small, high-margin extras |
| Carrier rate margin | All of them | Buy postage wholesale, resell at retail |

Storage is free for a window (30–180 days depending on provider) and then
charged per day, which doubles as an inventory-management incentive.

### 1c. What this tells us

There are two viable archetypes, and they demand very different things:

- **Take a cut of the transaction.** Requires being in the flow of money, which
  requires trust, licensing and operations.
- **Sell a service alongside the transaction.** Does not require touching the
  money at all.

Farhand's goodwill positioning points strongly toward the second.

---

## 2. The warning from Grabr

Grabr's public reviews are worth reading before choosing to hold money. The
recurring complaints are payout delays to travellers, funds held while a payment
is "pending verification", and support tickets going unanswered — with some
reviewers speculating openly about the company's solvency.

The lesson is not that escrow is wrong. It is that **the moment a platform holds
money, it takes on an operational business, not just a software product**:
refunds, chargebacks, fraud, dispute arbitration, payout timing, and support
staffed by humans. A trust feature that fails operationally destroys more trust
than never having offered it.

This is directly relevant to a one-person project.

---

## 3. The regulatory constraint (this decides a lot)

Under EU payment rules, a platform that comes into possession or control of
funds owed by one user to another is performing a regulated payment service and
needs a licence, unless an exemption applies. The "commercial agent" exemption
was narrowed by PSD2: it does not apply to a platform acting on behalf of both
the buyer and the seller while holding their funds. PSD3 narrows it further,
adding that the agent must genuinely be authorised to negotiate or conclude the
transaction for one party, and that party must have real room to negotiate.

Analyses of the current position are blunt about the practical effect: if money
belonging to someone else passes through an account in the platform's name, even
for a day, that is regulated activity in the EU.

**Consequence for Farhand.** Do-it-yourself escrow is not an option. Any future
money-handling must go through a licensed provider (Stripe Connect, Mangopay,
Adyen for Platforms or similar), structured so that Farhand never controls the
funds. That is achievable, but it makes the platform an intermediary with
compliance obligations (onboarding checks on payees, tax reporting), not just a
website.

---

## 4. Revenue options, assessed for Farhand

Rated for a goodwill-positioned platform run initially by one person.

| # | Option | How it works | Fit | Notes |
|---|---|---|---|---|
| 1 | **Affiliate revenue from retailers** | The need links to a product page; the helper buys through an affiliate link; the shop pays a commission | **Strong** | Costs users nothing, requires no payment handling, no licence. Rates typically low single digits, higher in beauty and fashion. Must be disclosed |
| 2 | **Buyer protection fee** | Optional paid protection on a deal, with payment held by a licensed provider until delivery | **Strong, later** | Turns the platform's weakness into its product. Requires a PSP and real operations |
| 3 | **Service fee on protected deals** | A percentage taken only where the platform actually adds protection | **Good, later** | Honest version of the Grabr fee: charge where value is delivered |
| 4 | **Subscription for frequent users** | More open needs, priority visibility, lower protection fee | Medium | Works only once there is enough activity to be worth paying for |
| 5 | **Featured or boosted listings** | Pay to appear higher in browse results | Medium | Simple to build; can degrade trust if overdone |
| 6 | **Verified badge** | Paid identity verification through a provider, shown on the profile | Medium | Users pay for trust rather than for access. Costs per check, and turns Farhand into a processor of ID data |
| 7 | **Discounted postage labels** | Resell carrier rates to helpers at a small margin | Medium, later | The forwarders' quiet margin. Requires carrier contracts |
| 8 | **Commission on the thank-you amount** | Take a cut of the optional appreciation | **Poor** | Contradicts the goodwill promise, and the base is tiny: 10% of €10 is €1 |
| 9 | **Advertising** | Shop ads on browse pages | Poor | Needs large traffic; cheapens a trust product |
| 10 | **Selling data** | Aggregated demand insights | Reject | Incompatible with the privacy position in `07-trust-and-safety.md` |
| 11 | **B2B: "we ship where you don't"** | Retailers pay to reach customers in countries they refuse to ship to | Speculative, high ceiling | The most interesting long-term idea: the shop, not the user, is the paying customer |

### The mandatory-vs-optional principle

Reimbursement of real costs stays untouched, always. Anything Farhand charges
for is a **separate, optional service**, priced transparently and visible before
anyone commits. That keeps the goodwill promise intact while still allowing
revenue. It is also the structure Grabr uses, with the platform fee separated
from the traveller's reward.

---

## 5. Unit economics, roughly

Assume an average order of €100 and a €10 thank-you amount.

| Model | Revenue per completed deal | Deals needed for €1,000/month |
|---|---|---|
| Affiliate at 3% of the product | €3.00 | ~333 |
| Protection fee at 5%, charged on ~30% of deals | €5.00 on those deals | ~660 total deals |
| Subscription at €5/month, 5% of active users subscribing | — | ~4,000 active users |
| Commission on thank-you at 10% | €1.00 | ~1,000 |

Payment processing typically costs around 1.5–3% plus a fixed amount per
transaction, which eats a meaningful share of any percentage below about 5%.

**The honest conclusion:** none of these produces meaningful income at low
volume. Farhand only becomes a business at a few hundred completed deals per
month, and that is a demand problem, not a pricing problem.

---

## 6. The real constraint is liquidity, not monetisation

Analyses of failed peer-to-peer marketplaces repeatedly identify three causes:
the concept does not solve a real problem, the focus is too broad, or the
business model does not scale. Farhand clears the first. The second is the
danger.

**Worldwide scope, which is right for a learning project, is wrong for a real
launch.** A worldwide platform with 200 users has no liquidity anywhere: a
Japanese need with no Japanese helper looks like a dead site. The same 200 users
concentrated on two corridors — say Germany and the UK into Estonia, Latvia and
Lithuania — can actually match.

If Farhand were ever launched, the sequence would be:

1. Pick two or three corridors with real, documented demand.
2. Seed the helper side first. Helpers are the scarce side, because a need
   without a helper is a dead listing while a helper without needs simply waits.
3. Reach the point where a typical need receives a proposal within 48 hours.
4. Only then think about charging for anything.

Communities are the natural distribution channel: diaspora and expat groups,
student networks, hobby communities that buy niche goods internationally.

---

## 7. Cost of running it

| Item | Rough monthly cost at small scale |
|---|---|
| Hosting (small managed container plus database) | €20–50 |
| Transactional email | €0–20 |
| Domain and TLS | ~€2 |
| Error tracking and uptime monitoring | €0–30 |
| Object storage for photos and receipts | €1–10 |
| **Total infrastructure** | **roughly €25–110** |

Infrastructure is not the real cost. Moderation, support and dispute handling
are, and they scale with users rather than with revenue. A platform that holds
money needs those hours; one that does not can survive on far fewer.

---

## 8. Recommended path, if Farhand ever goes live

**Phase A — no revenue (versions 1 and 2).** Prove that deals complete at all.
Metric: percentage of needs that receive a proposal, and percentage of deals
that reach `COMPLETED`.

**Phase B — affiliate revenue.** Non-extractive, requires no licence, changes
nothing for users, and rewards exactly the behaviour the platform wants
(purchases actually happening through the shops users link to).

**Phase C — optional buyer protection through a licensed PSP.** The single
biggest thing a real platform could add, and the only feature users would
plausibly pay for. Introduce it only when there is capacity to run disputes
properly, remembering Grabr's example.

**Phase D — subscriptions and boosts.** Only once there is enough traffic that
visibility has value.

**Never — a cut of the thank-you amount.** It would undermine the one thing that
makes Farhand different.

---

## 9. Metrics that matter, in order

1. Proposal rate: share of needs receiving at least one proposal within 48 hours.
2. Match rate: share of needs that become a deal.
3. Completion rate: share of deals reaching `COMPLETED`.
4. Repeat rate: share of users doing a second deal.
5. Dispute rate.
6. Only then: revenue per completed deal.

A marketplace with a high completion rate and no revenue can add revenue. One
with revenue and a low completion rate cannot fix itself.

---

## 10. Sources

- Grabr help centre, fee explanation (traveller reward, minimum fee, Grabr service fee)
- TechCrunch, Grabr launch coverage (payment held on bid acceptance, released after delivery)
- Grabr reviews on Trustpilot (payout delays, held funds, support failures)
- Stackry and MyUS published pricing; comparison write-ups of forwarder pricing models
- Stripe, "How PSD2 impacts marketplaces and platforms"; Ryft, PSD3 analysis; commentary on the commercial agent exemption
- Sharetribe, on why peer-to-peer marketplaces fail

Figures in this document are indicative and were accurate when written. Verify
before relying on any of them.
