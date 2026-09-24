import { Prisma } from "@prisma/client";
import type { Deal, DealEvent, Proposal, User } from "@prisma/client";
import { prisma } from "../db.js";
import { HttpError } from "../errors.js";
import {
  afterCursor,
  type CursorPosition,
  NEWEST_FIRST,
  type Page,
  toPage,
} from "./shared.js";

/**
 * Proposals: the handshake between a need and a helper.
 *
 * One row covers both ways people find each other
 * (docs/03-user-journeys.md, J1 and J2):
 *
 *   HELPER    Yuki is browsing needs, sees Kadri's, and offers to help.
 *   REQUESTER Anna is browsing offers, finds Marek's, and asks him about a
 *             need she has already posted.
 *
 * Same table, same statuses, same conversation afterwards —
 * `initiatedBy` only records which way round it happened, and nothing else in
 * the system branches on it (docs/05-data-model.md).
 *
 * Accepting is #20: one transaction that accepts this proposal, declines the
 * others, closes the need and opens a deal. It does not belong beside these.
 */

/**
 * What either side may say when they get in touch.
 *
 * "string | null", never undefined: Proposal.message is a nullable column, and
 * the schema in ../routes/proposals.js has already turned a missing note into
 * null — the same settlement as the needs fields in #15.
 */
export interface ProposalMessageInput {
  message: string | null;
}

/** A proposal with enough of its need to be worth reading in a list. */
export type ProposalWithNeed = Proposal & {
  need: { id: string; title: string; status: string; requesterId: string };
};

/** What accepting produces: the new deal, its proposal and its first event. */
export type AcceptedDeal = Deal & {
  proposal: Proposal;
  events: DealEvent[];
};

/** Lists and single reads always carry that much of the need. */
const withNeed = {
  need: {
    select: { id: true, title: true, status: true, requesterId: true },
  },
} as const;

/**
 * A helper offers to shop for a need: journey J1, step 3.
 */
export async function proposeAsHelper(
  actor: User,
  needId: string,
  input: ProposalMessageInput,
): Promise<ProposalWithNeed> {
  const need = await prisma.need.findUnique({ where: { id: needId } });

  if (!need) {
    throw HttpError.notFound("Need not found");
  }

  // A need nobody may see is a need that does not exist: drafts, closed and
  // expired needs are 404 for everyone but their owner.
  // Visibility rule: see docs/06-api-contract.md
  const isVisible =
    need.status === "OPEN" ||
    need.status === "MATCHED" ||
    need.requesterId === actor.id;
  if (!isVisible) {
    throw HttpError.notFound("Need not found");
  }

  // 403, not 404: an open need is public, so refusing its owner tells them
  // nothing they could not already read.
  if (need.requesterId === actor.id) {
    throw HttpError.forbidden("You cannot offer to shop for your own need");
  }

  if (need.status !== "OPEN") {
    throw HttpError.conflict("This need is no longer open");
  }

  // One proposal per helper per need, decided by the unique constraint on
  // (needId, helperId) and by nothing else — two requests arriving together
  // would both pass a look-first check and both write.
  // The constraint: see docs/05-data-model.md
  try {
    return await prisma.proposal.create({
      data: {
        needId,
        helperId: actor.id,
        initiatedBy: "HELPER",
        message: input.message,
      },
      include: withNeed,
    });
  } catch (error) {
    if (isDuplicate(error)) {
      throw HttpError.conflict("You have already proposed on this need");
    }
    throw error;
  }
}

/**
 * A requester approaches a helper about a need they already posted: journey
 * J2, step 2.
 */
export async function proposeAsRequester(
  actor: User,
  helpId: string,
  needId: string,
  input: ProposalMessageInput,
): Promise<ProposalWithNeed> {
  const help = await prisma.help.findUnique({ where: { id: helpId } });

  if (!help) {
    throw HttpError.notFound("Help not found");
  }

  // Paused and removed offers are invisible to everyone but their owner, the
  // same rule as GET /helps/:id: see docs/06-api-contract.md
  if (help.status !== "ACTIVE" && help.helperId !== actor.id) {
    throw HttpError.notFound("Help not found");
  }

  // The mirror of the own-need refusal above: approaching yourself is the same
  // mistake seen from the other side.
  if (help.helperId === actor.id) {
    throw HttpError.forbidden("You cannot approach your own offer");
  }

  const need = await prisma.need.findUnique({ where: { id: needId } });

  if (!need) {
    throw HttpError.notFound("Need not found");
  }

  if (need.requesterId !== actor.id) {
    throw HttpError.forbidden("You may only introduce your own need");
  }

  if (need.status !== "OPEN") {
    throw HttpError.conflict("This need is no longer open");
  }

  // helperId is the offer's owner and not the caller: here the caller is the
  // requester. The same constraint as above also stops a requester asking a
  // helper who has already proposed on that need — they are already talking.
  try {
    return await prisma.proposal.create({
      data: {
        needId,
        helperId: help.helperId,
        helpId: help.id,
        initiatedBy: "REQUESTER",
        message: input.message,
      },
      include: withNeed,
    });
  } catch (error) {
    if (isDuplicate(error)) {
      throw HttpError.conflict(
        "You are already in touch with this helper about this need",
      );
    }
    throw error;
  }
}

/**
 * The requester says no thank you.
 */
export async function declineProposal(
  actor: User,
  proposalId: string,
): Promise<ProposalWithNeed> {
  const proposal = await prisma.proposal.findUnique({
    where: { id: proposalId },
    include: withNeed,
  });

  if (!proposal) {
    throw HttpError.notFound("Proposal not found");
  }

  if (proposal.need.requesterId !== actor.id) {
    throw HttpError.forbidden("Only the requester may decline a proposal");
  }

  // Declining something already withdrawn, declined or accepted answers a
  // question nobody is asking any more.
  if (proposal.status !== "PENDING") {
    throw HttpError.conflict("This proposal is no longer pending");
  }

  return prisma.proposal.update({
    where: { id: proposalId },
    data: { status: "DECLINED", respondedAt: new Date() },
    include: withNeed,
  });
}

/**
 * The helper changes their mind.
 *
 * Withdrawing does not free the slot: the unique constraint is on
 * (needId, helperId) and takes no notice of status, so the same helper cannot
 * propose on that need a second time.
 * Written down in docs/06-api-contract.md
 */
export async function withdrawProposal(
  actor: User,
  proposalId: string,
): Promise<ProposalWithNeed> {
  const proposal = await prisma.proposal.findUnique({
    where: { id: proposalId },
    include: withNeed,
  });

  if (!proposal) {
    throw HttpError.notFound("Proposal not found");
  }

  if (proposal.helperId !== actor.id) {
    throw HttpError.forbidden("Only the helper may withdraw a proposal");
  }

  if (proposal.status !== "PENDING") {
    throw HttpError.conflict("This proposal is no longer pending");
  }

  return prisma.proposal.update({
    where: { id: proposalId },
    data: { status: "WITHDRAWN", respondedAt: new Date() },
    include: withNeed,
  });
}

/**
 * The requester accepts, and the deal begins: journey J1, step 5.
 *
 * Five writes that are one decision. docs/11-risks.md names this as the
 * project's hardest part, and the reason is that a half-finished accept is
 * worse than a failed one: a deal with no accepted proposal, or a need still
 * open with a deal already running, is a state nothing in the system knows how
 * to read.
 */
export async function acceptProposal(
  actor: User,
  proposalId: string,
): Promise<AcceptedDeal> {
  const proposal = await prisma.proposal.findUnique({
    where: { id: proposalId },
    include: withNeed,
  });

  if (!proposal) {
    throw HttpError.notFound("Proposal not found");
  }

  if (proposal.need.requesterId !== actor.id) {
    throw HttpError.forbidden("Only the requester may accept a proposal");
  }

  if (proposal.status !== "PENDING") {
    throw HttpError.conflict("This proposal is no longer pending");
  }

  if (proposal.need.status !== "OPEN") {
    throw HttpError.conflict("This need is no longer open");
  }

  // One moment for all five writes: the proposal accepted and the ones declined
  // in its place answered at the same instant, because they are one decision.
  const respondedAt = new Date();

  try {
    return await prisma.$transaction(async (tx) => {
      // a. Accept THIS proposal — guarded again, in case another accept won
      // the race since step 1's read.
      const acceptedCount = await tx.proposal.updateMany({
        where: { id: proposalId, status: "PENDING" },
        data: { status: "ACCEPTED", respondedAt },
      });
      if (acceptedCount.count === 0) {
        throw HttpError.conflict("This proposal is no longer pending");
      }

      // b. Every other still-pending proposal on this need → DECLINED.
      await tx.proposal.updateMany({
        where: {
          needId: proposal.needId,
          id: { not: proposalId },
          status: "PENDING",
        },
        data: { status: "DECLINED", respondedAt },
      });

      // c. The need → MATCHED, guarded the same way.
      const need = await tx.need.findUniqueOrThrow({
        where: { id: proposal.needId },
      });

      const matchedCount = await tx.need.updateMany({
        where: { id: proposal.needId, status: "OPEN" },
        data: { status: "MATCHED" },
      });
      if (matchedCount.count === 0) {
        throw HttpError.conflict("This need is no longer open");
      }

      // d. Create the deal — money copied now, so later edits to the need
      // (docs/04-deal-lifecycle.md) cannot change an agreed deal.
      const deal = await tx.deal.create({
        data: {
          proposalId,
          needId: proposal.needId,
          requesterId: proposal.need.requesterId,
          helperId: proposal.helperId,
          status: "MATCHED",
          currency: need.currency,
          thankYouAmount: need.thankYouAmount,
        },
      });

      // e. The first event: append-only, starts here.
      await tx.dealEvent.create({
        data: {
          dealId: deal.id,
          actorId: proposal.need.requesterId,
          fromStatus: null,
          toStatus: "MATCHED",
        },
      });

      // Read it back rather than assembling the answer by hand: a copy built
      // from the rows we held a moment ago drifts from what was actually
      // written — a stale updatedAt, and the need we joined on the way in.
      return tx.deal.findUniqueOrThrow({
        where: { id: deal.id },
        include: { proposal: true, events: true },
      });
    });
  } catch (error) {
    // The last line of defence: the partial unique index refuses a second live
    // deal on this need even if every check above passed.
    // The index: see docs/05-data-model.md
    if (isDuplicate(error)) {
      throw HttpError.conflict("This need already has an active deal");
    }
    throw error;
  }
}

/**
 * Everything the caller is part of, whichever side they are on.
 */
export async function listMyProposals(
  actor: User,
  position: CursorPosition | undefined,
  limit: number,
): Promise<Page<ProposalWithNeed>> {
  const rows = await prisma.proposal.findMany({
    where: {
      // Two sibling keys, which Prisma joins with AND: the cursor's own OR
      // stays inside its own bracket instead of widening this one into
      // "mine, or anything older than the cursor". The trap from #16 and #18.
      OR: [{ helperId: actor.id }, { need: { requesterId: actor.id } }],
      AND: [afterCursor(position)],
    },
    include: withNeed,
    orderBy: NEWEST_FIRST,
    take: limit + 1,
  });

  return toPage(rows, limit);
}

/**
 * Prisma's unique constraint violation — here, a second proposal from the same
 * helper on the same need.
 */
function isDuplicate(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002"
  );
}
