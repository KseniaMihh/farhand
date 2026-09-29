import {
  type AdminAction,
  type AdminActionType,
  Prisma,
  type Report,
  type ReportTarget,
  type User,
} from "@prisma/client";
import { ROLE_RANK } from "../middleware/auth.js";
import { prisma } from "../db.js";
import { HttpError } from "../errors.js";

/**
 * Moderation: the few things a moderator may do, and the record of them.
 *
 * Every function here writes an `AdminAction`, and none of them takes an
 * action without a reason. That is the whole design:
 * docs/02-roles-and-permissions.md says "any moderation action: MODERATOR or
 * ADMIN only, and always recorded", and a rule that is only sometimes recorded
 * is not a rule anybody can check later.
 *
 * WHAT THE LOG IS FOR. `User.status` is the present tense — this account is
 * suspended. `AdminAction` is the past tense — who suspended it, when, why,
 * and whether it had happened before (docs/05-data-model.md). A moderator
 * looking at a repeat offender needs the second, and so does anybody asking
 * whether a moderator has been fair.
 *
 * WHAT IS NOT HERE. Reading is not a decision, so a moderator opening a
 * conversation does not write an AdminAction — it goes to the application log
 * instead (see src/services/conversations.ts). The rule about when they may
 * open one at all is also there, because that is where the reading happens.
 */

/** Acting on an account: the four things that can happen to a person. */
export interface UserActionInput {
  type: Extract<AdminActionType, "WARN" | "SUSPEND" | "BAN" | "REACTIVATE">;
  reason: string;
  /** Only for SUSPEND. Absent means "until somebody lifts it". */
  until?: Date | undefined;
}

/** How a report ends. */
export interface ResolutionInput {
  outcome: "RESOLVED" | "DISMISSED";
  resolutionNote: string;
}

/** A report with the thing it is about, so a moderator can judge it. */
export interface ReportWithTarget {
  report: Report;
  target: unknown;
}

/**
 * Warn, suspend, ban or reactivate an account.
 */
export async function actOnUser(
  actor: User,
  targetUserId: string,
  input: UserActionInput,
): Promise<AdminAction> {
  const target = await prisma.user.findUnique({ where: { id: targetUserId } });
  if (!target) {
    throw HttpError.notFound("User not found");
  }

  // Nobody moderates upwards, and nobody moderates themselves.
  if (
    target.id === actor.id ||
    ROLE_RANK[target.role] >= ROLE_RANK[actor.role]
  ) {
    throw HttpError.forbidden("You may not take this action on this user");
  }

  if (target.status === "DELETED") {
    throw HttpError.conflict("This account no longer exists");
  }

  const userUpdate: Prisma.UserUpdateInput | null = (() => {
    switch (input.type) {
      case "WARN":
        // The record IS the warning. No change to the account.
        return null;
      case "SUSPEND":
        return { status: "SUSPENDED", suspendedUntil: input.until ?? null };
      case "BAN":
        return { status: "BANNED", suspendedUntil: null };
      case "REACTIVATE":
        // The undo for both a suspension and a ban.
        return { status: "ACTIVE", suspendedUntil: null };
    }
  })();

  return prisma.$transaction(async (tx) => {
    if (userUpdate) {
      await tx.user.update({ where: { id: target.id }, data: userUpdate });
    }

    return tx.adminAction.create({
      data: {
        adminId: actor.id,
        targetUserId: target.id,
        type: input.type,
        reason: input.reason,
        expiresAt: input.type === "SUSPEND" ? (input.until ?? null) : null,
      },
    });
  });
}

/**
 * Take a need, an offer or a message down.
 */
export async function removeContent(
  actor: User,
  contentType: ReportTarget,
  contentId: string,
  reason: string,
): Promise<AdminAction> {
  if (contentType === "USER") {
    throw HttpError.validationFailed("A user is banned, not removed");
  }

  return prisma.$transaction(async (tx) => {
    let targetUserId: string;

    if (contentType === "NEED") {
      const need = await tx.need.findUnique({ where: { id: contentId } });
      if (!need) throw HttpError.notFound("Need not found");
      if (need.status === "REMOVED") {
        throw HttpError.conflict("This need has already been removed");
      }
      targetUserId = need.requesterId;
      await tx.need.update({
        where: { id: contentId },
        data: { status: "REMOVED" },
      });
    } else if (contentType === "HELP") {
      const help = await tx.help.findUnique({ where: { id: contentId } });
      if (!help) throw HttpError.notFound("Help not found");
      if (help.status === "REMOVED") {
        throw HttpError.conflict("This offer has already been removed");
      }
      targetUserId = help.helperId;
      await tx.help.update({
        where: { id: contentId },
        data: { status: "REMOVED" },
      });
    } else {
      // MESSAGE
      const message = await tx.message.findUnique({ where: { id: contentId } });
      if (!message) throw HttpError.notFound("Message not found");
      if (!message.senderId) {
        throw HttpError.conflict("A system message cannot be removed");
      }
      if (message.removedAt) {
        throw HttpError.conflict("This message has already been removed");
      }
      targetUserId = message.senderId;
      await tx.message.update({
        where: { id: contentId },
        data: { removedAt: new Date() },
      });
    }

    return tx.adminAction.create({
      data: {
        adminId: actor.id,
        targetUserId,
        type: "REMOVE_CONTENT",
        reason,
        contentType,
        contentId,
      },
    });
  });
}

/**
 * Close a report: it was dealt with, or there was nothing in it.
 */
export async function resolveReport(
  actor: User,
  reportId: string,
  input: ResolutionInput,
): Promise<Report> {
  const report = await prisma.report.findUnique({ where: { id: reportId } });
  if (!report) {
    throw HttpError.notFound("Report not found");
  }
  if (report.status !== "OPEN") {
    throw HttpError.conflict("This report has already been dealt with");
  }

  return prisma.report.update({
    where: { id: reportId },
    data: {
      status: input.outcome,
      resolvedById: actor.id,
      resolvedAt: new Date(),
      resolutionNote: input.resolutionNote,
    },
  });
}

/**
 * One report, with the thing it is about.
 */
export async function getReportWithTarget(
  actor: User,
  reportId: string,
): Promise<ReportWithTarget> {
  const report = await prisma.report.findUnique({ where: { id: reportId } });
  if (!report) {
    throw HttpError.notFound("Report not found");
  }

  const target = await (async (): Promise<unknown> => {
    switch (report.targetType) {
      case "USER":
        return prisma.user.findUnique({
          where: { id: report.targetId },
          include: { profile: true },
        });
      case "NEED":
        return prisma.need.findUnique({ where: { id: report.targetId } });
      case "HELP":
        return prisma.help.findUnique({ where: { id: report.targetId } });
      case "MESSAGE":
        return prisma.message.findUnique({
          where: { id: report.targetId },
          include: {
            conversation: {
              include: { proposal: { include: { need: true } } },
            },
          },
        });
    }
  })();

  // A target that has since vanished is not an error: null lets the
  // moderator resolve the report anyway.
  return { report, target: target ?? null };
}
