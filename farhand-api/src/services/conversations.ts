import type { Conversation, Message, User } from "@prisma/client";
import { prisma } from "../db.js";
import { HttpError } from "../errors.js";
import {
  afterCursor,
  afterCursorOn,
  type CursorPosition,
  NEWEST_FIRST,
  newestFirstOn,
  type Page,
  toPageOldestFirst,
  toPageWith,
} from "./shared.js";

/**
 * Conversations: one per proposal, so the two of them can ask questions before
 * agreeing to anything (docs/05-data-model.md).
 *
 * The thread belongs to the proposal, not to the deal: "what size?" and "does
 * it ship to Estonia?" are exactly the questions people need answered *before*
 * accepting. A proposal that is declined keeps its thread, because the
 * conversation is evidence of what was said.
 *
 * WHO IS IN IT. Two people: the need's requester and the proposal's helper.
 * Nobody else may read a word of it — except moderators, who can read but not
 * write, because judging a report means reading what was said
 * (docs/02-roles-and-permissions.md, docs/07-trust-and-safety.md).
 *
 * WHEN IT EXISTS. Not until somebody writes. An empty thread is noise in an
 * inbox, so the first message creates the conversation, and that is why
 * sending is addressed by the proposal rather than by a conversation id that
 * does not exist yet.
 *
 * UNREAD. Two timestamps on the conversation, not a flag per message: anything
 * newer than your own `...LastReadAt` is unread. One small write when you read
 * a thread, instead of one per message.
 */

/** Both people in a thread, and which of the two the caller is. */
export interface Participation {
  conversation: Conversation;
  requesterId: string;
  helperId: string;
  /** Which read-timestamp belongs to the caller, or null for a moderator. */
  side: "requester" | "helper" | null;
}

/** A message as a reader sees it: a removed one keeps its place, not its words. */
export type VisibleMessage = Omit<Message, "body"> & { body: string | null };

/** A thread as the inbox shows it: who it is with, and what is unread. */
export type InboxEntry = Conversation & {
  proposal: {
    id: string;
    helperId: string;
    need: { id: string; title: string; requesterId: string };
  };
  unreadCount: number;
};

/** The proposal's two people, and enough of the need to show a title. */
const withParticipants = {
  proposal: {
    select: {
      id: true,
      helperId: true,
      need: { select: { id: true, title: true, requesterId: true } },
    },
  },
} as const;

/**
 * Someone writes. The first message opens the thread.
 */
export async function sendMessage(
  actor: User,
  proposalId: string,
  body: string,
): Promise<Message> {
  const proposal = await prisma.proposal.findUnique({
    where: { id: proposalId },
    include: { need: { select: { requesterId: true } } },
  });

  if (!proposal) {
    throw HttpError.notFound("Proposal not found");
  }

  const isParticipant =
    actor.id === proposal.need.requesterId || actor.id === proposal.helperId;
  if (!isParticipant) {
    throw HttpError.forbidden("You are not part of this conversation");
  }

  // Outside the transaction: a failed statement poisons the whole
  // transaction in Postgres, so the race on the unique proposalId constraint
  // has to be settled by an upsert on its own, before the transaction opens.
  const conversation = await prisma.conversation.upsert({
    where: { proposalId },
    update: {},
    create: { proposalId },
  });

  return prisma.$transaction(async (tx) => {
    const message = await tx.message.create({
      data: {
        conversationId: conversation.id,
        senderId: actor.id,
        body,
      },
    });

    await tx.conversation.update({
      where: { id: conversation.id },
      data: { lastMessageAt: message.createdAt },
    });

    return message;
  });
}

/**
 * Reading a thread, newest page first, oldest message first within it.
 */
export async function listMessages(
  actor: User,
  conversationId: string,
  position: CursorPosition | undefined,
  limit: number,
): Promise<Page<VisibleMessage>> {
  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    include: withParticipants,
  });

  const isParticipant =
    conversation &&
    (actor.id === conversation.proposal.need.requesterId ||
      actor.id === conversation.proposal.helperId);

  if (!conversation || (!isParticipant && !isModerator(actor))) {
    throw HttpError.notFound("Conversation not found");
  }

  const rows = await prisma.message.findMany({
    where: {
      conversationId,
      AND: [afterCursor(position)],
    },
    orderBy: NEWEST_FIRST,
    take: limit + 1,
  });

  const page = toPageOldestFirst(rows, limit);

  return {
    ...page,
    items: page.items.map((message) => ({
      ...message,
      body: message.removedAt ? null : message.body,
    })),
  };
}

/**
 * The inbox: every thread the caller is in, most recently spoken in first.
 */
export async function listInbox(
  actor: User,
  position: CursorPosition | undefined,
  limit: number,
): Promise<Page<InboxEntry>> {
  const rows = await prisma.conversation.findMany({
    where: {
      // Threads nobody has spoken in are not inbox entries, and a NULL
      // lastMessageAt would sort FIRST in a descending order — an empty thread
      // at the top of the inbox. That is not hypothetical: a send whose
      // message fails after the upsert leaves exactly such a row behind, and
      // this is what keeps it out of sight.
      lastMessageAt: { not: null },
      AND: [
        {
          OR: [
            { proposal: { helperId: actor.id } },
            { proposal: { need: { requesterId: actor.id } } },
          ],
        },
        afterCursorOn("lastMessageAt", position),
      ],
    },
    include: withParticipants,
    orderBy: newestFirstOn("lastMessageAt"),
    take: limit + 1,
  });

  // The cursor carries the column the list is sorted by, not the row's own
  // createdAt: the two orders are nothing alike once an old thread wakes up.
  // The fallback is unreachable while the filter above stands, and if it ever
  // goes, the inbox sorts by when threads began instead of crashing.
  const page = toPageWith(rows, limit, (row) => ({
    createdAt: row.lastMessageAt ?? row.createdAt,
    id: row.id,
  }));

  const items = await Promise.all(
    page.items.map(async (conversation) => {
      const isHelper = conversation.proposal.helperId === actor.id;
      const lastReadAt = isHelper
        ? conversation.helperLastReadAt
        : conversation.requesterLastReadAt;

      // One count per row, deliberately: a page is at most 50 rows, and the
      // cut-off — each caller's own lastReadAt — differs per row, so a single
      // groupBy cannot express it. Clarity over a cleverer query here.
      const unreadCount = await prisma.message.count({
        where: {
          conversationId: conversation.id,
          senderId: { not: actor.id },
          ...(lastReadAt ? { createdAt: { gt: lastReadAt } } : {}),
        },
      });

      return { ...conversation, unreadCount };
    }),
  );

  return { items, nextCursor: page.nextCursor };
}

/**
 * "I have read this."
 */
export async function markRead(
  actor: User,
  conversationId: string,
): Promise<Conversation> {
  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    include: withParticipants,
  });

  if (!conversation) {
    throw HttpError.notFound("Conversation not found");
  }

  const isRequester = actor.id === conversation.proposal.need.requesterId;
  const isHelper = actor.id === conversation.proposal.helperId;

  if (!isRequester && !isHelper) {
    if (isModerator(actor)) {
      throw HttpError.forbidden(
        "Moderators can read a thread but do not mark it read",
      );
    }
    throw HttpError.notFound("Conversation not found");
  }

  return prisma.conversation.update({
    where: { id: conversationId },
    data: isRequester
      ? { requesterLastReadAt: new Date() }
      : { helperLastReadAt: new Date() },
  });
}

/**
 * Whether the caller is allowed to read other people's threads.
 *
 * Reading a report means reading what was said, so a moderator sees a thread
 * they are not in — and writes nothing to it, and does not mark it read
 * (docs/02-roles-and-permissions.md).
 */
function isModerator(actor: User): boolean {
  return actor.role === "MODERATOR" || actor.role === "ADMIN";
}
