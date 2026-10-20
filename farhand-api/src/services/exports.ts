import { Prisma } from "@prisma/client";
import type { User } from "@prisma/client";
import { prisma } from "../db.js";
import { HttpError } from "../errors.js";
import { logger } from "../logger.js";
import { enqueue } from "./jobs.js";

/**
 * Taking your data with you (#89).
 *
 * docs/07-trust-and-safety.md has promised this since version 1 — "Data
 * export on request is a V2 feature" — and it is the other half of what #66
 * built: erasure answers "forget me", portability answers "give me a copy
 * first".
 *
 * Four things decide its shape, and the second is the whole issue.
 *
 * 1. IT RUNS IN THE QUEUE (#85). Reading somebody's whole history is a dozen
 *    queries, and a request that takes a second is a request people press
 *    twice.
 *
 * 2. EVERYTHING HERE IS TWO PEOPLE'S DATA — a conversation, a deal, a review
 *    — and an export is a file that can be forwarded. What is included and
 *    what is deliberately not is decision 0023; the rules are in
 *    `buildExport` beside the queries they govern.
 *
 * 3. It says what it leaves out. An export that quietly drops something is
 *    worse than one that can be argued with.
 *
 * 4. The payload is personal data, so it is destroyed on a clock.
 *
 * what is included: see docs/10-decisions/0023-an-export-is-one-persons-copy.md
 */

/** How long a finished export can be downloaded for. */
export const EXPORT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * How long a pending request blocks another one.
 *
 * One at a time per person, or a loop of requests is a loop of full-history
 * queries nobody asked for. But not forever: a job that gives up after #85's
 * five attempts leaves a row that will never be ready, and without this one
 * failure would lock somebody out of their own data permanently.
 */
const STALE_AFTER_MS = 60 * 60 * 1000;

/** What a person gets back when they ask. */
export interface ExportRequestView {
  id: string;
  status: "PENDING";
  requestedAt: Date;
}

/**
 * Asks for an export, and answers at once.
 */
export async function requestExport(
  actor: User,
  now = new Date(),
): Promise<ExportRequestView> {
  const pending = await prisma.dataExport.findFirst({
    where: {
      userId: actor.id,
      readyAt: null,
      createdAt: { gt: new Date(now.getTime() - STALE_AFTER_MS) },
    },
  });

  if (pending) {
    throw HttpError.conflict(
      "An export is already being prepared. Try downloading it in a moment",
    );
  }

  // One transaction for the row and the job: #85's rule, learned by
  // registration — a job for a row that was rolled back is a job that fails
  // five times and then reports itself.
  const row = await prisma.$transaction(async (tx) => {
    const created = await tx.dataExport.create({
      data: { userId: actor.id },
    });

    await enqueue("data-export", { exportId: created.id }, tx);

    return created;
  });

  return { id: row.id, status: "PENDING", requestedAt: row.createdAt };
}

/**
 * The job: build it, store it, and set the clock running.
 *
 * Registered as a `JobKind`, so #85's retries, backoff and reporting come for
 * free. Idempotent for the same reason notifications are: the queue is
 * at-least-once, so a second run must not rebuild an export somebody is
 * already downloading.
 */
export async function fulfilExport(
  exportId: string,
  now = new Date(),
): Promise<void> {
  const row = await prisma.dataExport.findUnique({ where: { id: exportId } });

  // Gone, or already built. Nothing to do and nothing to retry — the queue is
  // at-least-once, so a second run must not rebuild a copy somebody may be
  // downloading.
  if (row?.readyAt !== null) return;

  const payload = await buildExport(row.userId);

  await prisma.dataExport.update({
    where: { id: exportId },
    data: {
      payload: payload as unknown as Prisma.InputJsonValue,
      readyAt: now,
      expiresAt: new Date(now.getTime() + EXPORT_TTL_MS),
    },
  });
}

/**
 * Hands it over, to the person it is about and nobody else.
 *
 *   not theirs      404 — an export somebody may not read is one they may not
 *                   know exists, and the ownership is checked on the ROW
 *                   rather than on the path (#79's lesson about files)
 *   not ready       409 — ask again in a moment
 *   expired         410 — it was here, it is gone, and asking again is the fix
 */
export async function downloadExport(
  actor: User,
  exportId: string,
  now = new Date(),
): Promise<unknown> {
  const row = await prisma.dataExport.findUnique({ where: { id: exportId } });

  if (row?.userId !== actor.id) {
    // 404 and not 403: an export somebody may not read is one they may not
    // know exists, and a missing row answers the same as somebody else's.
    throw HttpError.notFound("Export not found");
  }

  if (row.readyAt === null) {
    throw HttpError.conflict("This export is not ready yet");
  }

  if (row.payload === null || (row.expiresAt && row.expiresAt <= now)) {
    throw HttpError.gone(
      "This export has expired. Ask for a new one with POST /me/exports",
    );
  }

  return row.payload;
}

/**
 * Destroys the payloads that have had their seven days.
 *
 * The ROW stays: "an export was made, and when" is itself something somebody
 * may ask about, and it is two timestamps rather than a copy of their life.
 */
export async function sweepExpiredExports(now: Date): Promise<number> {
  const { count } = await prisma.dataExport.updateMany({
    // `Prisma.DbNull`, not `null`: for a nullable Json column Prisma makes
    // you say which null you mean — the column holding SQL NULL, or the
    // column holding the JSON value `null`. We want the row to hold nothing
    // at all, so the payload is gone rather than replaced by a token value
    // that still reads as "there is a payload".
    where: { expiresAt: { lte: now }, payload: { not: Prisma.DbNull } },
    data: { payload: Prisma.DbNull },
  });

  if (count > 0) {
    logger.info({ count }, "Expired data exports cleared");
  }

  return count;
}

/**
 * Everything held about one person, as JSON.
 *
 * THE RULE, and every query below follows it (decision 0023):
 *
 *   their own rows        in full
 *   rows about them       in full — a review they received, a moderator's
 *                         decision about them. They are entitled to know
 *   the other person      their public display name, and their words where
 *                         those words were sent TO this person. Never their
 *                         address, never their private fields, never a row
 *                         from a conversation this person was not in
 *   secrets               never. No password hash, no session or token hash,
 *                         not even hashed — a hash of a session token is
 *                         still a credential's fingerprint
 */
export async function buildExport(
  userId: string,
): Promise<Record<string, unknown>> {
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    // Named fields, never the whole row: `select` is what keeps
    // `passwordHash` out of here, and a spread would have put it in.
    select: {
      id: true,
      email: true,
      role: true,
      status: true,
      emailVerifiedAt: true,
      emailNotifications: true,
      createdAt: true,
      deletedAt: true,
      profile: {
        select: {
          displayName: true,
          bio: true,
          countryCode: true,
          city: true,
        },
      },
    },
  });

  const needs = await prisma.need.findMany({
    where: { requesterId: userId },
    select: {
      id: true,
      title: true,
      description: true,
      buyCountry: true,
      deliverCountry: true,
      currency: true,
      estimatedPrice: true,
      thankYouAmount: true,
      status: true,
      prohibitedVersion: true,
      prohibitedAckAt: true,
      createdAt: true,
      category: { select: { slug: true } },
    },
  });

  const helps = await prisma.help.findMany({
    where: { helperId: userId },
    select: {
      id: true,
      country: true,
      shipsTo: true,
      description: true,
      status: true,
      prohibitedVersion: true,
      prohibitedAckAt: true,
      createdAt: true,
      categories: { select: { slug: true } },
    },
  });

  /** The other side of a deal or a conversation, as a stranger sees them. */
  const otherPerson = {
    select: { profile: { select: { displayName: true } } },
  } as const;

  const proposals = await prisma.proposal.findMany({
    where: { OR: [{ helperId: userId }, { need: { requesterId: userId } }] },
    select: {
      id: true,
      initiatedBy: true,
      message: true,
      status: true,
      respondedAt: true,
      createdAt: true,
      need: { select: { id: true, title: true } },
      // Only a display name of whoever else is in it.
      helper: otherPerson,
    },
  });

  const deals = await prisma.deal.findMany({
    where: { OR: [{ requesterId: userId }, { helperId: userId }] },
    select: {
      id: true,
      status: true,
      currency: true,
      productAmount: true,
      shippingEstimate: true,
      shippingActual: true,
      thankYouAmount: true,
      trackingNumber: true,
      createdAt: true,
      need: { select: { id: true, title: true } },
      requester: otherPerson,
      helper: otherPerson,
      events: {
        select: {
          fromStatus: true,
          toStatus: true,
          note: true,
          createdAt: true,
        },
        orderBy: { createdAt: "asc" },
      },
      quotes: {
        select: {
          currency: true,
          productAmount: true,
          shippingEstimate: true,
          acceptedAt: true,
          createdAt: true,
        },
      },
    },
  });

  /**
   * Conversations this person is in, and both sides' words.
   *
   * A message sent TO somebody is in their possession the way a received
   * email is, so exporting it discloses nothing new — and without it the
   * export is useless as a record of what was agreed, which is the thing
   * people ask for an export for (decision 0023).
   *
   * What is NOT here: any conversation this person was not part of. The
   * `where` is the whole permission check, and it is the same one
   * `services/conversations.ts` applies to reading.
   */
  const conversations = await prisma.conversation.findMany({
    where: {
      proposal: {
        OR: [{ helperId: userId }, { need: { requesterId: userId } }],
      },
    },
    select: {
      id: true,
      createdAt: true,
      proposal: { select: { id: true, need: { select: { title: true } } } },
      messages: {
        select: {
          body: true,
          createdAt: true,
          removedAt: true,
          senderId: true,
          sender: otherPerson,
        },
        orderBy: { createdAt: "asc" },
      },
    },
  });

  const reviewsWritten = await prisma.review.findMany({
    where: { authorId: userId },
    select: {
      rating: true,
      comment: true,
      removedAt: true,
      createdAt: true,
      deal: { select: { id: true } },
      target: otherPerson,
    },
  });

  const reviewsReceived = await prisma.review.findMany({
    where: { targetId: userId },
    select: {
      rating: true,
      comment: true,
      removedAt: true,
      createdAt: true,
      deal: { select: { id: true } },
      author: otherPerson,
    },
  });

  const files = await prisma.file.findMany({
    where: { ownerId: userId },
    // Metadata only: what was uploaded, when, and how big. The bytes are not
    // here (see `notIncluded`).
    select: {
      id: true,
      purpose: true,
      mimeType: true,
      sizeBytes: true,
      needId: true,
      dealId: true,
      createdAt: true,
    },
  });

  const moderation = await prisma.adminAction.findMany({
    where: { targetUserId: userId },
    // The action and its reason, never which moderator: they are staff acting
    // in a role, and their name is not this person's data to collect.
    select: {
      type: true,
      reason: true,
      contentType: true,
      contentId: true,
      expiresAt: true,
      createdAt: true,
    },
  });

  const reportsFiled = await prisma.report.findMany({
    where: { reporterId: userId },
    select: {
      targetType: true,
      targetId: true,
      reason: true,
      details: true,
      status: true,
      createdAt: true,
    },
  });

  const notifications = await prisma.notification.findMany({
    where: { userId },
    select: {
      kind: true,
      sentAt: true,
      skippedAt: true,
      createdAt: true,
    },
  });

  const sessions = await prisma.session.findMany({
    where: { userId },
    // No `tokenHash`: a hash of a live session token is still a credential's
    // fingerprint. The address and the dates are this person's own data.
    select: { ipAddress: true, createdAt: true, expiresAt: true },
  });

  return {
    exportedAt: new Date(),
    account: user,
    profile: user.profile,
    needs,
    helps,
    proposals,
    deals,
    conversations,
    reviewsWritten,
    reviewsReceived,
    files,
    moderation,
    reportsFiled,
    notifications,
    sessions,

    /**
     * What is deliberately missing, and why.
     *
     * Criterion three of the issue, and the part a person would actually
     * read: an export that quietly drops something is worse than one that
     * says what it left out, because the second can be argued with.
     */
    notIncluded: {
      fileBytes:
        "Photographs and receipts are listed above by name, type and size, but the images themselves are not in this file. They came from your own device and are still there; the metadata is what Farhand holds about them.",
      otherPeoplesDetails:
        "Where somebody else appears — the other side of a deal, the author of a review — you have their public display name and, in a conversation you were part of, the words they sent you. Their email address, their other dealings and the private parts of their profile are their data, not yours.",
      otherPeoplesConversations:
        "Only conversations you were part of are here. A proposal somebody else made on somebody else's need is not.",
      credentials:
        "No password hash, and no session or token hashes. A hash of a live credential is still a credential's fingerprint, and this file is one you may send to somebody.",
      moderatorIdentities:
        "A decision taken about your account is here with its reason, but not which moderator took it: they were acting in a role, and their name is not your data to collect.",
      systemLogs:
        "Request logs and error reports are kept for a short time for debugging and are not part of this export. They contain no message bodies.",
    },
  };
}
