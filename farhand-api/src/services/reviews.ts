import { Prisma } from "@prisma/client";
import type { Review, User } from "@prisma/client";
import { prisma } from "../db.js";
import { HttpError } from "../errors.js";
import { sideOf } from "./deals.js";
import { DELETED_DISPLAY_NAME } from "./profiles.js";
import {
  afterCursor,
  type CursorPosition,
  NEWEST_FIRST,
  type Page,
  toPageWith,
} from "./shared.js";

/**
 * Reviews (#83).
 *
 * `Review` has been in schema.prisma since the first week — unique on
 * `(dealId, authorId)`, rating constrained to 1–5 by a CHECK constraint — and
 * nothing has ever written to it. This writes to it.
 *
 * What a review is FOR decides most of the rules below: it is not feedback
 * between two people who already know what happened. It is a signal to the
 * next stranger deciding whether to trade with one of them, which is why it is
 * public, why it is attached to a completed deal rather than to a person, and
 * why #84 can build a rating summary out of these rows.
 *
 * Contract: docs/06-api-contract.md, "Reviews".
 */

/**
 * How long after a deal completes both sides have to review it.
 *
 * ONE DEADLINE FOR THE DEAL, NOT A TIMER PER REVIEW, and the difference is the
 * whole design. A blind window exists so that nobody can read the other side's
 * review before writing their own. Measured per review it can simply be waited
 * out: write nothing, let the honest 2★ publish itself on day 15, read it, and
 * answer with a revenge 1★ on day 16. Measured from the deal, writing CLOSES
 * when the window does, so by the time anybody can read, nobody can write.
 *
 *   deadline   completed at + REVIEW_WINDOW_DAYS
 *   writable   before the deadline, and only once
 *   visible    both sides have written, or the deadline has passed
 *   editable   mine, and not yet visible
 *
 * Fourteen days, the same as `AUTO_COMPLETE_DAYS`: it is already this
 * product's idea of how long somebody reasonably takes to get round to
 * something (docs/04-deal-lifecycle.md).
 *
 * It needs NO column and NO scheduled job. "When did this deal complete" is
 * already in the event log, which is where the auto-complete sweep reads
 * delivery times from, and everything else is that date and the clock.
 */
export const REVIEW_WINDOW_DAYS = 14;

/** Matches `@db.VarChar(1000)` on the column. */
export const MAX_COMMENT_LENGTH = 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

/** What a review looks like in an answer. */
export interface ReviewView {
  id: string;
  /**
   * TODO(#125): `null` once a moderator has removed it, along with the
   * comment. The row keeps its place in the list and says what happened to
   * it; what it said and what it scored are gone.
   */
  rating: number | null;
  comment: string | null;
  createdAt: Date;
  /** The author as a stranger sees them — "Deleted account" if they left. */
  author: { id: string; displayName: string };
  /** Which deal it came from, so a reader can tell two reviews apart. */
  dealId: string;
  /**
   * False while the window holds and the other side has not written. Only
   * ever sent to the review's own author, who is the only person allowed to
   * see it in that state — and the only one who can still edit it.
   */
  published: boolean;
  /**
   * TODO(#125): true when a moderator has taken it down. It still occupies
   * its place — a hole that says "removed" is honest, and `06-api-contract.md`
   * already makes that argument for a removed message — but it counts for
   * nothing (see `countedWhere`).
   */
  removed: boolean;
}

export interface WriteReviewInput {
  rating: number;
  comment: string | null;
}

/** The columns a view needs, with the author's name for display. */
const REVIEW_FACTS = {
  id: true,
  rating: true,
  comment: true,
  createdAt: true,
  dealId: true,
  authorId: true,
  // Every reader needs it: one to hide the words, the other to show that they
  // were hidden (#125).
  removedAt: true,
  author: { select: { profile: { select: { displayName: true } } } },
} as const;

type ReviewFacts = Prisma.ReviewGetPayload<{ select: typeof REVIEW_FACTS }>;

function reviewView(review: ReviewFacts, published: boolean): ReviewView {
  // A removed review loses its words and its stars here, in one place, so
  // that no caller has to remember — and keeps its place in every list it was
  // in. `reviewAsEvidence` is the one way to see what it said, and only a
  // moderator reaches that (#125).
  const removed = review.removedAt !== null;

  return {
    id: review.id,
    removed,
    rating: removed ? null : review.rating,
    comment: removed ? null : review.comment,
    createdAt: review.createdAt,
    author: {
      id: review.authorId,
      // A profile is blanked rather than deleted when somebody leaves (#66),
      // so this already reads "Deleted account" without a special case. The
      // `??` is for the row that cannot exist: a user with no profile at all.
      displayName: review.author.profile?.displayName ?? DELETED_DISPLAY_NAME,
    },
    dealId: review.dealId,
    published,
  };
}

/**
 * TODO(#125): the same review as EVIDENCE, for the people allowed to judge it.
 *
 * A separate function, and separate on purpose. `reviewView` nulls the words
 * and the stars of a removed review, which is right for every reader but one:
 * a moderator deciding whether a takedown was fair, or reading a second report
 * about the same author, needs exactly what was taken down. The row is kept
 * "as evidence" (`Message.removedAt`'s wording, and now this column's) — and
 * evidence the only permitted reader cannot read is the hole #81 left when it
 * granted access to photo ids that nothing handed out.
 *
 * Named rather than a boolean on `reviewView`, so the asymmetry is something
 * you can see at the call site instead of a `true` to decode. Used by
 * `getReportWithTarget`, and by nothing else.
 */
export function reviewAsEvidence(
  review: ReviewFacts & { removedAt: Date | null },
) {
  return {
    id: review.id,
    // The ORIGINAL, whatever `removedAt` says. That is the point of the row.
    rating: review.rating,
    comment: review.comment,
    createdAt: review.createdAt,
    // So a moderator can see it has already been dealt with, and by the shape
    // of the answer rather than by remembering.
    removedAt: review.removedAt,
    dealId: review.dealId,
    author: {
      id: review.authorId,
      displayName: review.author.profile?.displayName ?? DELETED_DISPLAY_NAME,
    },
  };
}

/** When a deal's review window closes. */
function deadlineFor(completedAt: Date): Date {
  return new Date(completedAt.getTime() + REVIEW_WINDOW_DAYS * DAY_MS);
}

/**
 * When a deal completed, from the event log.
 *
 * `COMPLETED` is terminal — the transition table has no way out of it — so
 * unlike `autoCompleteDeals`'s search for the newest `DELIVERED`, there can
 * only ever be one of these. Null means the deal has not completed, or
 * completed before there was an event log to say so, and both answer the same
 * way: no window, so no reviewing.
 */
async function completedAt(dealId: string): Promise<Date | null> {
  const event = await prisma.dealEvent.findFirst({
    where: { dealId, toStatus: "COMPLETED" },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });

  return event?.createdAt ?? null;
}

/**
 * Whether a review is out of its blind window.
 *
 * `now` is a parameter rather than `new Date()` for the reason
 * `autoCompleteDeals(now)` takes one: a test that wants day 13 and day 15
 * should say so, not fake a clock.
 *
 * Two reviews means both sides, because `@@unique([dealId, authorId])` and a
 * deal has exactly two people.
 */
function isPublished(
  reviewsOnThisDeal: Pick<Review, "id">[],
  completed: Date,
  now: Date,
): boolean {
  return reviewsOnThisDeal.length >= 2 || now >= deadlineFor(completed);
}

/**
 * WHAT IS SHOWN: the timing rule as a query, for the readers that must not
 * load every row to apply it.
 *
 * Timing only. Whether a moderator has removed a review is a different
 * question with a different answer, and conflating the two was a mistake
 * caught in review (#125): a removed review is still SHOWN, in its place, as
 * a hole that says "removed" — it just does not COUNT. See `countedWhere`.
 *
 * "Both sides have written" is expressible because `targetId` is known: a
 * review ABOUT somebody was written by the other side, so the pair is complete
 * exactly when the deal also holds a review AUTHORED by that somebody.
 */
export function publishedWhere(
  targetId: string,
  now: Date,
): Prisma.ReviewWhereInput {
  const cutoff = new Date(now.getTime() - REVIEW_WINDOW_DAYS * DAY_MS);

  return {
    targetId,
    OR: [
      { deal: { reviews: { some: { authorId: targetId } } } },
      {
        deal: {
          events: {
            some: { toStatus: "COMPLETED", createdAt: { lte: cutoff } },
          },
        },
      },
    ],
  };
}

/**
 * TODO(#125): WHAT COUNTS: published, and not taken down.
 *
 * Two questions, two rules, because they have different answers. A review a
 * moderator removed keeps its place in the list — a hole that says "removed"
 * is honest, and the same argument the contract already makes for a removed
 * message — but it must not drag a rating with it. If a review was abusive or
 * false enough to take down, its one star is very likely part of the same
 * abuse, and leaving it in the average would let somebody damage a person's
 * reputation from behind a review nobody can read.
 *
 * #84 averages with THIS one. The profile then says three reviews where the
 * list shows four, and the fourth explains itself: "removed by a moderator".
 * A count that disagrees with a visible reason is honest; an unexplained gap
 * is not.
 */
export function countedWhere(
  targetId: string,
  now: Date,
): Prisma.ReviewWhereInput {
  return { AND: [publishedWhere(targetId, now)], removedAt: null };
}

/**
 * The deal, if this caller may review it at all — and when it completed.
 *
 * A stranger gets the `404` the whole deal section gives: a deal they are not
 * in must not be confirmable. A moderator gets `403`, as for a receipt (#82):
 * they can read this deal, so refusing says nothing new, and reviewing is for
 * the two people who did the trade.
 */
async function dealForReview(actor: User, dealId: string, now: Date) {
  const deal = await prisma.deal.findUnique({
    where: { id: dealId },
    select: { id: true, status: true, requesterId: true, helperId: true },
  });

  const side = sideOf(actor, deal);

  if (!deal || side === null) {
    throw HttpError.notFound("Deal not found");
  }

  if (side === "moderator") {
    throw HttpError.forbidden("Only the people in a deal can review it");
  }

  if (deal.status !== "COMPLETED") {
    throw HttpError.conflict("A deal can only be reviewed once it is complete");
  }

  const completed = await completedAt(deal.id);

  if (!completed || now >= deadlineFor(completed)) {
    // Closed, or never opened. Both are the same answer, and the reason the
    // closing matters is that it is what stops a revenge review: by the time
    // anybody can read one, nobody can write one.
    throw HttpError.conflict(
      `Reviews close ${String(REVIEW_WINDOW_DAYS)} days after a deal completes`,
    );
  }

  return {
    ...deal,
    completed,
    otherSide: side === "requester" ? deal.helperId : deal.requesterId,
  };
}

/** Every review on a deal, for the published rule and for the answers. */
async function allOnDeal(dealId: string): Promise<ReviewFacts[]> {
  // REMOVED REVIEWS STILL COUNT TOWARDS THE PAIR, deliberately (#125). "Both
  // sides have written" is a fact about the past, and a takedown does not
  // unmake it. Two reasons, and the second is the one that matters:
  //
  //   a review that has been public for three weeks would UNPUBLISH itself
  //   the moment the other review on that deal came down, which is a worse
  //   outcome than anything removal was meant to fix;
  //
  //   and it would be a trick somebody could run on purpose — write an
  //   abusive review of the person you expect to review you badly, get it
  //   removed, and their honest review of you vanishes until the deadline.
  //
  // (In practice removal always happens after publication anyway: nobody but
  // the author can see a review inside the window, so nobody else can report
  // one.)
  return prisma.review.findMany({
    where: { dealId },
    orderBy: NEWEST_FIRST,
    select: REVIEW_FACTS,
  });
}

/**
 * Writes one review.
 *
 * `targetId` is NOT taken from the request. It is the other participant,
 * derived here — a client that could name the target could name itself, and
 * "five stars, from me, about me" is not a thing the API should have to argue
 * about.
 *
 * The second review from the same person is refused BY THE DATABASE, not by a
 * read-then-write: `@@unique([dealId, authorId])` already exists, and two taps
 * on a slow connection both pass a look-first check (#19's P2002 pattern,
 * services/proposals.ts). So the insert goes first and the error is read
 * afterwards.
 */
export async function writeReview(
  actor: User,
  dealId: string,
  input: WriteReviewInput,
  now: Date,
): Promise<ReviewView> {
  const deal = await dealForReview(actor, dealId, now);

  let written: ReviewFacts;
  try {
    written = await prisma.review.create({
      data: {
        dealId: deal.id,
        authorId: actor.id,
        targetId: deal.otherSide,
        rating: input.rating,
        comment: input.comment,
      },
      select: REVIEW_FACTS,
    });
  } catch (error) {
    if (!isDuplicate(error)) throw error;
    throw HttpError.conflict("You have already reviewed this deal");
  }

  return reviewView(
    written,
    isPublished(await allOnDeal(deal.id), deal.completed, now),
  );
}

/**
 * Changes the caller's own review, while nobody else can read it.
 *
 * Allowed exactly as long as it is unpublished, and refused the moment it is
 * not. The rule is derived from the visibility rule rather than invented
 * beside it: until it is published it is a draft only its author can see, and
 * afterwards it is a public statement somebody may have acted on.
 *
 * There is no way to delete one, at any point.
 */
export async function editReview(
  actor: User,
  dealId: string,
  input: WriteReviewInput,
  now: Date,
): Promise<ReviewView> {
  const deal = await dealForReview(actor, dealId, now);
  const onDeal = await allOnDeal(deal.id);
  const mine = onDeal.find((one) => one.authorId === actor.id);

  if (!mine) {
    throw HttpError.notFound("You have not reviewed this deal");
  }

  if (isPublished(onDeal, deal.completed, now)) {
    throw HttpError.conflict(
      "This review has been published and can no longer be changed",
    );
  }

  const changed = await prisma.review.update({
    where: { id: mine.id },
    data: { rating: input.rating, comment: input.comment },
    select: REVIEW_FACTS,
  });

  return reviewView(changed, false);
}

/**
 * The reviews written about one person, newest first.
 *
 * Public, and published ones only — the window is not a privacy setting a
 * stranger can be trusted to respect, it is a condition in the query.
 */
export async function reviewsAbout(
  targetId: string,
  position: CursorPosition | undefined,
  limit: number,
  now: Date,
): Promise<Page<ReviewView>> {
  const rows = await prisma.review.findMany({
    where: { AND: [publishedWhere(targetId, now), afterCursor(position)] },
    orderBy: NEWEST_FIRST,
    take: limit + 1,
    select: REVIEW_FACTS,
  });

  return toPageWith(
    // Everything this query returns is published by definition.
    rows.map((row) => reviewView(row, true)),
    limit,
    (row) => ({ createdAt: row.createdAt, id: row.id }),
  );
}

/**
 * The reviews on one deal, as this caller may see them.
 *
 * Their own always, published or not, because the author is the one person who
 * may read a review inside its window — and has to, to edit it. The other
 * side's only once it is published.
 *
 * No permission check: the only caller is the deal's own answer, which has
 * already decided who may see the deal.
 */
export async function reviewsOnDeal(
  actor: User,
  dealId: string,
  now: Date,
): Promise<ReviewView[]> {
  const onDeal = await allOnDeal(dealId);
  if (onDeal.length === 0) return [];

  const completed = await completedAt(dealId);
  // No completion event means no window, which means nothing is published —
  // and a review can only exist on a completed deal anyway.
  const published = completed !== null && isPublished(onDeal, completed, now);

  return onDeal
    .filter((one) => published || one.authorId === actor.id)
    .map((one) => reviewView(one, published));
}

/**
 * Prisma's unique constraint violation — here, a second review from the same
 * person on the same deal.
 */
function isDuplicate(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002"
  );
}
