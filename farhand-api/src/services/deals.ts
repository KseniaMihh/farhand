import type {
  Deal,
  DealEvent,
  DealStatus,
  Prisma,
  Quote,
  User,
} from "@prisma/client";
import { prisma } from "../db.js";
import { HttpError } from "../errors.js";
import {
  afterCursor,
  type CursorPosition,
  NEWEST_FIRST,
  type Page,
  toPage,
} from "./shared.js";
import { findTransition, mayTransition } from "./transitions.js";

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
 * What a transition request may carry, beyond where it is going.
 *
 * Which of these are required — and which are refused — depends on the target
 * status, and the route has already checked that against the table before this
 * is called (docs/04-deal-lifecycle.md).
 */
export interface TransitionInput {
  note?: string;
  trackingNumber?: string;
  shippingActual?: number;
}

/**
 * Every status change in the product goes through here.
 */
export async function transitionDeal(
  actor: User,
  dealId: string,
  to: DealStatus,
  input: TransitionInput,
): Promise<DealWithEvents> {
  const deal = await prisma.deal.findUnique({
    where: { id: dealId },
    include: { quotes: { orderBy: NEWEST_FIRST, take: 1 } },
  });

  const side = sideOf(actor, deal);
  if (!deal || side === null) {
    throw HttpError.notFound("Deal not found");
  }

  // "This cannot be done" (409) and "you may not do it" (403) are different
  // answers, and the caller can tell them apart.
  const rule = findTransition(deal.status, to);
  if (!rule) {
    throw HttpError.conflict(`A deal cannot go from ${deal.status} to ${to}`);
  }

  if (!mayTransition(rule, side)) {
    throw HttpError.forbidden("You may not make this change to the deal");
  }

  // Which fields a transition demands is the table's business, not this
  // function's: adding a row that needs one must not mean remembering to edit
  // a switch here as well. The route refuses a malformed request first — that
  // is the boundary doing types, lengths and unexpected fields — but the rule
  // itself is read from the row.
  const missing = rule.requires.filter((field) => input[field] === undefined);
  if (missing.length > 0) {
    throw HttpError.badRequest(
      `Moving a deal to ${to} needs: ${missing.join(", ")}`,
    );
  }

  // Preconditions about the DEAL rather than the move, which no list of field
  // names can express.
  const quote = deal.quotes[0];
  if (to === "QUOTE_AGREED" && !quote) {
    // Nothing to agree to until the helper has quoted.
    throw HttpError.conflict("There is no quote to accept yet");
  }

  const fromStatus = deal.status;

  return prisma.$transaction(async (tx) => {
    // Side effects this issue owns: agreed money, or shipping details.
    let effects: Prisma.DealUpdateManyMutationInput = {};
    if (to === "QUOTE_AGREED" && quote) {
      effects = {
        currency: quote.currency,
        productAmount: quote.productAmount,
        shippingEstimate: quote.shippingEstimate,
      };
    } else if (to === "SHIPPED") {
      effects = {
        trackingNumber: input.trackingNumber ?? null,
        shippingActual: input.shippingActual ?? null,
      };
    }

    // Guarded by the status we READ: a count of 0 means somebody moved the
    // deal between our read and this write.
    const moved = await tx.deal.updateMany({
      where: { id: dealId, status: fromStatus },
      data: { status: to, ...effects },
    });
    if (moved.count === 0) {
      throw HttpError.conflict(
        "This deal has just changed. Reload and try again",
      );
    }

    if (to === "QUOTE_AGREED" && quote) {
      await tx.quote.update({
        where: { id: quote.id },
        data: { acceptedAt: new Date() },
      });
    }

    // Every transition writes one event.
    await tx.dealEvent.create({
      data: {
        dealId,
        actorId: actor.id,
        fromStatus,
        toStatus: to,
        note: input.note ?? null,
      },
    });

    return tx.deal.findUniqueOrThrow({
      where: { id: dealId },
      include: { events: { orderBy: [{ createdAt: "asc" }, { id: "asc" }] } },
    });
  });
}

/**
 * One deal, for the two people in it — and for a moderator, who may need to
 * read it to judge a report (docs/06-api-contract.md).
 */
export async function getDeal(
  actor: User,
  dealId: string,
): Promise<DealWithEvents> {
  const deal = await prisma.deal.findUnique({
    where: { id: dealId },
    include: {
      quotes: { orderBy: NEWEST_FIRST },
      // An event log reads forwards.
      events: { orderBy: [{ createdAt: "asc" }, { id: "asc" }] },
    },
  });

  if (!deal || sideOf(actor, deal) === null) {
    throw HttpError.notFound("Deal not found");
  }

  return deal;
}

/**
 * The caller's own deals, whichever side they are on.
 */
export async function listMyDeals(
  actor: User,
  status: DealStatus | undefined,
  position: CursorPosition | undefined,
  limit: number,
): Promise<Page<Deal>> {
  const rows = await prisma.deal.findMany({
    where: {
      OR: [{ requesterId: actor.id }, { helperId: actor.id }],
      ...(status ? { status } : {}),
      // The cursor's own OR goes in an AND array, so it can't replace the
      // "mine" OR above. Same trap as #16, #18 and #19.
      AND: [afterCursor(position)],
    },
    orderBy: NEWEST_FIRST,
    take: limit + 1,
  });

  return toPage(rows, limit);
}

/**
 * Which side of a deal the caller is on, if any.
 */
function sideOf(
  actor: User,
  deal: { requesterId: string; helperId: string } | null,
): "requester" | "helper" | "moderator" | null {
  if (!deal) return null;
  if (deal.requesterId === actor.id) return "requester";
  if (deal.helperId === actor.id) return "helper";
  if (actor.role === "MODERATOR" || actor.role === "ADMIN") return "moderator";
  return null;
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
