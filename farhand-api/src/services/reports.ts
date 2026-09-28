import { Prisma } from "@prisma/client";
import type {
  Report,
  ReportReason,
  ReportStatus,
  ReportTarget,
  User,
} from "@prisma/client";
import { prisma } from "../db.js";
import { HttpError } from "../errors.js";
import {
  afterCursorOldest,
  type CursorPosition,
  OLDEST_FIRST,
  type Page,
  toPage,
} from "./shared.js";

/**
 * Reports: how anybody says "look at this".
 *
 * The flow is in docs/07-trust-and-safety.md: a user reports content or an
 * account with a reason, it enters the moderator queue oldest first, and a
 * moderator reviews the target and resolves it. This issue is the first two
 * steps; resolving is #27.
 *
 * THE TARGET IS POLYMORPHIC. `targetType` and `targetId` name a user, a need,
 * a help or a message, and there is no foreign key — a column cannot point at
 * four tables at once. The database will therefore accept a report about a
 * need that does not exist, about a message id someone invented, or about the
 * string "banana". Nothing stops that but this file, which is what the issue
 * means by "validated in the service layer".
 *
 * VALIDATION IS ALSO ABOUT VISIBILITY, not only existence. If reporting a
 * message you cannot read answered "no such message" for invented ids and
 * "thank you" for real ones, the endpoint would be a way to ask whether any
 * given id exists. So a target you may not see is treated exactly like a
 * target that is not there.
 */

/** What a report says. `details` is optional; the reason is not. */
export interface ReportInput {
  targetType: ReportTarget;
  targetId: string;
  reason: ReportReason;
  details: string | null;
}

/** What the queue can be narrowed by (docs/06-api-contract.md). */
export interface QueueFilters {
  status?: ReportStatus | undefined;
  targetType?: ReportTarget | undefined;
  reason?: ReportReason | undefined;
}

/**
 * Somebody reports something.
 */
export async function submitReport(
  actor: User,
  input: ReportInput,
): Promise<Report> {
  await assertTargetIsReportable(actor, input.targetType, input.targetId);

  // The partial unique index decides duplicates, not a look-first read: two
  // taps arriving together would both read "nothing yet".
  try {
    return await prisma.report.create({
      data: {
        reporterId: actor.id,
        targetType: input.targetType,
        targetId: input.targetId,
        reason: input.reason,
        details: input.details,
      },
    });
  } catch (error) {
    if (isDuplicate(error)) {
      throw HttpError.conflict("You have already reported this");
    }
    throw error;
  }
}

/**
 * The moderator queue: what is waiting, oldest first.
 */
export async function listReportQueue(
  filters: QueueFilters,
  position: CursorPosition | undefined,
  limit: number,
): Promise<Page<Report>> {
  const rows = await prisma.report.findMany({
    where: {
      // The queue is work to be done, so it defaults to what is unresolved.
      status: filters.status ?? "OPEN",
      ...(filters.targetType ? { targetType: filters.targetType } : {}),
      ...(filters.reason ? { reason: filters.reason } : {}),
      AND: [afterCursorOldest(position)],
    },
    orderBy: OLDEST_FIRST,
    take: limit + 1,
  });

  return toPage(rows, limit);
}

/**
 * Is this a thing this person may report?
 */
async function assertTargetIsReportable(
  actor: User,
  targetType: ReportTarget,
  targetId: string,
): Promise<void> {
  switch (targetType) {
    case "USER": {
      const user = await prisma.user.findUnique({ where: { id: targetId } });
      if (!user) throw HttpError.notFound("Target not found");
      if (user.id === actor.id) {
        throw HttpError.forbidden("You cannot report yourself");
      }
      return;
    }

    case "NEED": {
      const need = await prisma.need.findUnique({ where: { id: targetId } });
      if (!need) throw HttpError.notFound("Target not found");
      if (need.requesterId === actor.id) {
        throw HttpError.forbidden("You cannot report your own need");
      }
      // Drafts, closed and expired needs are nobody else's business, so an
      // invisible target answers exactly like a missing one.
      if (need.status !== "OPEN" && need.status !== "MATCHED") {
        throw HttpError.notFound("Target not found");
      }
      return;
    }

    case "HELP": {
      const help = await prisma.help.findUnique({ where: { id: targetId } });
      if (!help) throw HttpError.notFound("Target not found");
      if (help.helperId === actor.id) {
        throw HttpError.forbidden("You cannot report your own offer");
      }
      if (help.status !== "ACTIVE") {
        throw HttpError.notFound("Target not found");
      }
      return;
    }

    case "MESSAGE": {
      const message = await prisma.message.findUnique({
        where: { id: targetId },
        include: {
          conversation: {
            include: {
              proposal: {
                select: {
                  helperId: true,
                  need: { select: { requesterId: true } },
                },
              },
            },
          },
        },
      });
      if (!message) throw HttpError.notFound("Target not found");

      // Only the two people in the conversation may see a message, so only
      // they may report one. A moderator's read access does not extend here.
      const { proposal } = message.conversation;
      const isParticipant =
        actor.id === proposal.helperId ||
        actor.id === proposal.need.requesterId;
      if (!isParticipant) throw HttpError.notFound("Target not found");

      if (message.senderId === actor.id) {
        throw HttpError.forbidden("You cannot report your own message");
      }
      return;
    }

    default: {
      // If a fifth target type is added to the schema, TypeScript fails here.
      const unreachable: never = targetType;
      throw new Error(`Unhandled report target: ${String(unreachable)}`);
    }
  }
}

/** Prisma's unique violation — here, the same complaint twice. */
function isDuplicate(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002"
  );
}
