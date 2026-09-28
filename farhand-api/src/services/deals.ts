import type { Deal, DealEvent, Quote, User } from "@prisma/client";
import { prisma } from "../db.js";
import { HttpError } from "../errors.js";
import { NEWEST_FIRST } from "./shared.js";

/**
 * Deals: what the two of them actually agreed, and what it costs.
 *
 * A deal is created by accepting a proposal (#20) and starts at `MATCHED`:
 * they have agreed to do this, and nothing about the money is settled yet.
 * This issue is the next step — the helper says what it will cost, and the
 * requester says yes.
 *
 * A QUOTE IS NOT A STATUS. The helper can revise it as often as they like
 * while the deal is still `MATCHED`; the deal only moves when the requester
 * accepts one (docs/04-deal-lifecycle.md). That is why a quote is its own row
 * rather than a column on the deal: each revision stays, so "what was I
 * offered last week?" has an answer, and the deal's own `productAmount` and
 * `shippingEstimate` stay null until something is actually agreed.
 *
 * MONEY IS INTEGER CENTS, never a decimal — docs/10-decisions/0006. €24.00 is
 * 2400. Nothing here ever multiplies or divides, so nothing can round.
 */

/** What the helper offers. Whole cents, and a currency for both amounts. */
export interface QuoteInput {
  currency: string;
  productAmount: number;
  shippingEstimate: number;
}

/** A deal after a transition, with the event that recorded it. */
export type DealWithEvents = Deal & { events: DealEvent[] };

/**
 * A deal the caller is in, or a 404.
 *
 * "No such deal" and "not your deal" are deliberately the same answer: a deal
 * is private to its two people, so a stranger must not be able to tell a real
 * id from an invented one. 403 here would confirm that it exists.
 * Visibility rule: see docs/06-api-contract.md
 */
async function loadOwnDeal(actor: User, dealId: string): Promise<Deal> {
  const deal = await prisma.deal.findUnique({ where: { id: dealId } });

  if (!deal || (deal.requesterId !== actor.id && deal.helperId !== actor.id)) {
    throw HttpError.notFound("Deal not found");
  }

  return deal;
}

/**
 * The helper says what it will cost.
 */
export async function submitQuote(
  actor: User,
  dealId: string,
  input: QuoteInput,
): Promise<Quote> {
  const deal = await loadOwnDeal(actor, dealId);

  if (deal.helperId !== actor.id) {
    throw HttpError.forbidden("Only the helper may quote");
  }

  if (deal.status !== "MATCHED") {
    throw HttpError.conflict("This deal can no longer be quoted");
  }

  // The deal's own amounts stay null: those are what was AGREED.
  return prisma.quote.create({
    data: {
      dealId,
      currency: input.currency,
      productAmount: input.productAmount,
      shippingEstimate: input.shippingEstimate,
    },
  });
}

/**
 * The requester agrees, and the money stops being a suggestion.
 */
export async function transitionDeal(
  actor: User,
  dealId: string,
  to: "QUOTE_AGREED",
): Promise<DealWithEvents> {
  const deal = await prisma.deal.findUnique({
    where: { id: dealId },
    // NEWEST_FIRST, not createdAt alone: two revisions can share a
    // millisecond, and then which one is "newest" is undefined — so accepting
    // could lock in the older amounts. The id breaks the tie, which does not
    // make the order chronological but does make it decided (see shared.ts).
    include: { quotes: { orderBy: NEWEST_FIRST, take: 1 } },
  });

  if (!deal || (deal.requesterId !== actor.id && deal.helperId !== actor.id)) {
    throw HttpError.notFound("Deal not found");
  }

  if (deal.requesterId !== actor.id) {
    throw HttpError.forbidden("Only the requester may accept a quote");
  }

  if (deal.status !== "MATCHED") {
    throw HttpError.conflict("This deal is not waiting for a quote");
  }

  const quote = deal.quotes[0];
  if (!quote) {
    throw HttpError.conflict("There is no quote to accept yet");
  }

  return prisma.$transaction(async (tx) => {
    // a. The deal moves, and copies the agreed money from the quote.
    // Guarded: a count of 0 means somebody else got there first.
    const moved = await tx.deal.updateMany({
      where: { id: dealId, status: "MATCHED" },
      data: {
        status: to,
        currency: quote.currency,
        productAmount: quote.productAmount,
        shippingEstimate: quote.shippingEstimate,
      },
    });
    if (moved.count === 0) {
      throw HttpError.conflict("This deal is not waiting for a quote");
    }

    // b. The quote is marked accepted.
    await tx.quote.update({
      where: { id: quote.id },
      data: { acceptedAt: new Date() },
    });

    // c. The append-only log gets its entry.
    await tx.dealEvent.create({
      data: {
        dealId,
        actorId: actor.id,
        fromStatus: "MATCHED",
        toStatus: to,
      },
    });

    // Read back rather than building the answer by hand.
    return tx.deal.findUniqueOrThrow({
      where: { id: dealId },
      include: { events: true },
    });
  });
}

/**
 * Every quote on a deal, newest first — the history the issue asks to keep.
 */
export async function listQuotes(
  actor: User,
  dealId: string,
): Promise<Quote[]> {
  await loadOwnDeal(actor, dealId);

  return prisma.quote.findMany({
    where: { dealId },
    orderBy: NEWEST_FIRST,
  });
}
