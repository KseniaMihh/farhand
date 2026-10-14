import {
  type AccountStatus,
  type AdminAction,
  type AdminActionType,
  Prisma,
  type Report,
  type ReportTarget,
  type Role,
  type User,
} from "@prisma/client";
import { ROLE_RANK } from "../middleware/auth.js";
import { prisma } from "../db.js";
import { HttpError } from "../errors.js";
import { logger } from "../logger.js";
import { withPhotos } from "./need-photos.js";
import { reviewAsEvidence } from "./reviews.js";
import {
  afterCursor,
  type CursorPosition,
  NEWEST_FIRST,
  type Page,
  toPage,
} from "./shared.js";

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
 * Take a need, an offer, a message or a review down.
 *
 * TODO(#125): the REVIEW branch. `Review.removedAt` is the same column and the
 * same reason as `Message.removedAt` — hidden, kept as evidence — but what
 * "hidden" means is NOT the same, and the difference is deliberate:
 *
 *   a message  keeps its place in the thread, body null. A hole that says
 *              "removed" is honest; one that closes up makes the conversation
 *              read as though nothing was sent (docs/06-api-contract.md)
 *   a review   disappears from everywhere but a moderator's view. A list has
 *              no narrative to break, and a tombstone on somebody's profile
 *              is itself a mark that a moderator's action should not leave
 *
 * The person the action is recorded against is the review's AUTHOR, as it is
 * the sender for a message: a takedown is about who wrote the thing.
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
    } else if (contentType === "REVIEW") {
      const review = await tx.review.findUnique({ where: { id: contentId } });
      if (!review) throw HttpError.notFound("Review not found");
      if (review.removedAt) {
        throw HttpError.conflict("This review has already been removed");
      }
      targetUserId = review.authorId;
      await tx.review.update({
        where: { id: contentId },
        data: { removedAt: new Date() },
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
      case "NEED": {
        const need = await prisma.need.findUnique({
          where: { id: report.targetId },
        });
        // With its photos (#81). A report about a prohibited item is usually a
        // report about the picture, and this is the only place a moderator is
        // given the ids — the file rule lets them follow the paths
        // (src/services/files.ts), including after the need has been taken
        // down, which is when the evidence matters most.
        return need === null ? null : await withPhotos(need);
      }
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

      case "REVIEW": {
        // What a moderator needs to judge it: the words, the rating, the deal
        // it came from, and both people. A permission to remove something
        // nobody can show you is as useless as #81's permission to open a
        // photo whose id nothing handed out.
        const review = await prisma.review.findUnique({
          where: { id: report.targetId },
          select: {
            id: true,
            rating: true,
            comment: true,
            createdAt: true,
            removedAt: true,
            dealId: true,
            authorId: true,
            author: { select: { profile: { select: { displayName: true } } } },
            target: { select: { id: true, profile: true } },
          },
        });

        // `reviewAsEvidence`, not the view everybody else gets: that one hides
        // the words of a removed review, which would make the evidence
        // unreadable by the only people allowed to read it (#125).
        return review === null
          ? null
          : { ...reviewAsEvidence(review), target: review.target };
      }
    }
  })();

  // A target that has since vanished is not an error: null lets the
  // moderator resolve the report anyway.
  return { report, target: target ?? null };
}

/* ────────────────────── finding a person (#67) ────────────────────── */

/**
 * What a moderator may narrow the user list by.
 *
 * `email` is an exact match and `q` is a partial one, and that asymmetry is the
 * whole safety argument (docs/06-api-contract.md, `GET /admin/users`). An email
 * address is something you look somebody up *by* — you have it already, from a
 * report or a complaint. Partial email matching would be a different tool:
 * `@gmail.com` returning every Gmail user in the database, one page at a time,
 * which is the "export the user table" the issue asks us not to build
 * (docs/07-trust-and-safety.md lists scraping personal data as a risk).
 */
export interface UserSearchFilters {
  /** Exact, already trimmed and lowercased by the route. */
  email?: string | undefined;
  /** Part of a display name, matched without case. */
  q?: string | undefined;
  status?: AccountStatus | undefined;
}

/**
 * One row of the moderator's user list.
 *
 * The email IS here, unlike everywhere else in the API
 * (docs/07-trust-and-safety.md: "no email addresses anywhere"). This is the one
 * exception and it is the reason the endpoint exists: a moderator holding a
 * complaint about `anna@example.com` has to be able to reach the account. The
 * password hash is not here, and never is.
 */
export interface UserSummary {
  id: string;
  email: string;
  displayName: string | null;
  countryCode: string | null;
  role: Role;
  status: AccountStatus;
  suspendedUntil: Date | null;
  emailVerified: boolean;
  createdAt: Date;
}

/**
 * Finds accounts, for a moderator who already knows roughly who they want.
 *
 * Deleted and banned accounts are included, and that is deliberate rather than
 * an oversight to tighten later. They are invisible everywhere else in the API
 * — `GET /users/:id` answers 404 for both (#65) — but this is the tool for
 * looking into what happened, and a moderator who cannot find a banned account
 * cannot check whether the ban was fair.
 *
 * Every call is written to the application log, the way a moderator opening a
 * conversation is (#27, src/services/conversations.ts). Reading is not a
 * decision, so it writes no `AdminAction` — see the rule at the top of this
 * file — but it is not nothing either. The count goes in the line as well as
 * the query: one lookup and somebody paging through the whole table look
 * identical otherwise.
 */
export async function searchUsers(
  actor: User,
  filters: UserSearchFilters,
  position: CursorPosition | undefined,
  limit: number,
): Promise<Page<UserSummary>> {
  const rows = await prisma.user.findMany({
    where: {
      ...(filters.email ? { email: filters.email } : {}),
      ...(filters.status ? { status: filters.status } : {}),
      ...(filters.q
        ? {
            profile: {
              displayName: { contains: filters.q, mode: "insensitive" },
            },
          }
        : {}),
      AND: [afterCursor(position)],
    },
    include: { profile: true },
    orderBy: NEWEST_FIRST,
    take: limit + 1,
  });

  const page = toPage(rows, limit);

  const summaries: UserSummary[] = page.items.map((user) => ({
    id: user.id,
    email: user.email,
    displayName: user.profile?.displayName ?? null,
    countryCode: user.profile?.countryCode ?? null,
    role: user.role,
    status: user.status,
    suspendedUntil: user.suspendedUntil,
    emailVerified: user.emailVerifiedAt !== null,
    createdAt: user.createdAt,
  }));

  logger.info(
    {
      moderatorId: actor.id,
      byEmail: filters.email !== undefined,
      query: filters,
      resultCount: summaries.length,
    },
    "moderator searched users",
  );

  return { items: summaries, nextCursor: page.nextCursor };
}
