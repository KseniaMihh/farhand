# Farhand — Overview

## The problem

Many online shops do not ship to every country. A person in country A finds a
product sold only in country B and has no way to buy it. Existing answers are
either expensive (package forwarding services), or informal and unsafe (asking
strangers in Facebook expat groups).

## What Farhand is

A platform where two kinds of people find each other:

- a **requester** who wants a product that is not available or not shippable to
  their country
- a **helper** who lives in the country where the product is sold, buys it, and
  posts it on

Farhand introduces them, gives them a shared place to agree on the details, and
tracks the deal from agreement to delivery. It does not touch the money in
version 1.

## Who it is for

- People living outside the shipping range of a shop they want to buy from.
- People who are willing to do a small favour for someone abroad, optionally for
  a thank-you amount offered by the requester.

## How it differs from what already exists

| Existing option | How it works | Farhand's difference |
|---|---|---|
| Grabr, Airfrov, Shappi, Glocalzone | Travellers carry items in luggage | Helpers are **locals** who buy and post; no travel needed |
| MyUS, Stackry, Aeropost | Commercial forwarding address | Person-to-person, no company fees, goodwill-first |
| Facebook expat groups | Informal, no structure | Structured deals, history, reports, reputation |

## Goodwill model

Reimbursing the helper's real costs (product plus postage) is **mandatory and
never negotiable**. A thank-you amount for effort is **optional** and offered by
the requester. Farhand takes no commission.

## Non-goals

These are deliberately out of scope, in every version unless stated:

- Farhand is not a courier, freight forwarder or customs broker.
- Farhand does not hold, transfer or escrow money in version 1.
- Farhand does not guarantee that any deal completes.
- Farhand does not verify anyone's identity in version 1.
- Farhand does not sell anything itself, and takes no commission.

## Project goals

Farhand is first a learning project and a portfolio piece. Launching it later is
possible but is not the current objective. The learning goals are:

1. Design and own a relational database.
2. Build a REST API with authentication and authorisation.
3. Enforce business rules on the server, not only in the UI.
4. Test the API and run those tests automatically in CI.
5. Containerise and deploy the result, then monitor it.

## Success criteria for version 1

- A user can register, post a need, receive a proposal, accept it, and follow a
  deal all the way to completed.
- Every state change is recorded and attributable to a person.
- An admin can block an abusive account.
- The API is tested, containerised and deployed, with a public repository whose
  history shows the project growing step by step.

## Assumptions

- Platform language for version 1 is English only. Multilingual support is a
  later decision, recorded separately if taken.
- All amounts are recorded in the currency the two parties agree on, with no
  conversion performed by Farhand.
