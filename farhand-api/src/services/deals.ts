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
import {
  findTransition,
  mayTransition,
  TRANSITION_FIELDS,
} from "./transitions.js";
import { logger } from "../logger.js";

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
  // "?: string | undefined" and not "?: string": with
  // exactOptionalPropertyTypes, a key that is present and undefined is not the
  // same as a key that is absent, and that is exactly what an optional Zod
  // field produces. The same settlement as the needs fields in #15.
  note?: string | undefined;
  trackingNumber?: string | undefined;
  shippingActual?: number | undefined;
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

  const missing = rule.requires.filter((field) => input[field] === undefined);
  if (missing.length > 0) {
    throw HttpError.validationFailed(
      `Moving a deal to ${to} needs: ${missing.join(", ")}`,
    );
  }

  // A field this move has no use for means the caller believes something
  // untrue, so say rather than dropping it.
  //
  // Checked against the fixed list rather than the keys of `input`: the keys
  // would need a cast to be usable here, and a cast is a promise about a value
  // this function did not make. The list is the same promise, kept locally.
  const unexpected = TRANSITION_FIELDS.filter(
    (field) => input[field] !== undefined && !rule.requires.includes(field),
  );
  if (unexpected.length > 0) {
    throw HttpError.validationFailed(
      `Moving a deal to ${to} has no use for: ${unexpected.join(", ")}`,
    );
  }

  // Preconditions about the DEAL rather than the move, which no list of field
  // names can express.
  const quote = deal.quotes[0];
  if (to === "QUOTE_AGREED" && !quote) {
    // Nothing to agree to until the helper has quoted.
    throw HttpError.conflict("There is no quote to accept yet");
  }

  // Leaving a dispute for anywhere but CANCELLED means going back to where the
  // deal was when the dispute began, and only the event log knows that.
  if (deal.status === "DISPUTED" && to !== "CANCELLED") {
    const disputeStart = await prisma.dealEvent.findFirst({
      where: { dealId, toStatus: "DISPUTED" },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });
    if (disputeStart?.fromStatus !== to) {
      throw HttpError.conflict(
        `This dispute can only be returned to ${disputeStart?.fromStatus ?? "CANCELLED"}`,
      );
    }
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

    const moved = await tx.deal.updateMany({
      where: { id: dealId, status: fromStatus },
      data: { status: to, ...effects },
    });
    if (moved.count === 0) {
      throw HttpError.conflict(
        "This deal has just changed. Reload and try again",
      );
    }

    if (to === "CANCELLED") {
      await tx.need.updateMany({
        where: { id: deal.needId, status: "MATCHED" },
        data: { status: "OPEN" },
      });
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

/**
 * How long a delivered deal waits before it completes itself.
 *
 * From docs/04-deal-lifecycle.md: "Requester goes silent after delivery →
 * auto-complete after 14 days at DELIVERED." The parcel arrived; if nobody
 * says otherwise, the deal is done and the reviews it unlocks should not wait
 * on a person remembering to press a button.
 */
export const AUTO_COMPLETE_DAYS = 14;

export async function autoCompleteDeals(now: Date): Promise<number> {
  const rule = findTransition("DELIVERED", "COMPLETED");
  // If the table ever stops allowing this, the job must stop too.
  if (!rule) return 0;

  const cutoff = new Date(
    now.getTime() - AUTO_COMPLETE_DAYS * 24 * 60 * 60 * 1000,
  );

  // "When was it delivered" lives in the event log, and only the NEWEST
  // DELIVERED event counts: an old one must not make a re-delivered deal due.
  //
  // Every delivered deal is read, and the due ones picked out here rather than
  // in the query, because "the newest event per deal, older than X" is awkward
  // to ask Prisma for in one go. That is fine while delivered deals number in
  // the hundreds and wrong when they number in the hundreds of thousands: the
  // fix then is to page through them, or to move the decision into SQL. A
  // deliberate limit, not an oversight.
  const candidates = await prisma.deal.findMany({
    where: { status: "DELIVERED" },
    include: {
      events: {
        where: { toStatus: "DELIVERED" },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: 1,
      },
    },
  });
  const due = candidates.filter((deal) => {
    const delivered = deal.events[0];
    return delivered !== undefined && delivered.createdAt < cutoff;
  });

  let completed = 0;
  for (const deal of due) {
    try {
      const done = await prisma.$transaction(async (tx) => {
        // Guarded: the requester may be pressing the button right now. Count 0
        // means they got there first, which is fine.
        const moved = await tx.deal.updateMany({
          where: { id: deal.id, status: "DELIVERED" },
          data: { status: rule.to },
        });
        if (moved.count === 0) return false;

        await tx.dealEvent.create({
          data: {
            dealId: deal.id,
            actorId: null, // null actor = the system acted
            fromStatus: "DELIVERED",
            toStatus: rule.to,
            note: `Completed automatically ${String(AUTO_COMPLETE_DAYS)} days after delivery`,
          },
        });
        return true;
      });
      if (done) completed += 1;
    } catch (error) {
      // One bad row must not stop the other ninety-nine.
      logger.error({ error, dealId: deal.id }, "auto-complete failed for deal");
    }
  }

  return completed;
}
