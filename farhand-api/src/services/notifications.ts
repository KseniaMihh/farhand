import type { DealStatus, Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { logger } from "../logger.js";
import { mailer } from "../mailer.js";
import { enqueue } from "./jobs.js";

/**
 * Emails somebody did not ask for individually (#86).
 *
 * Verification and reset email are a different thing: those answer a request
 * the person just made. These interrupt somebody, so the hard part is not the
 * sending — #85 built that — but deciding what is worth an interruption, and
 * making sure one event cannot send two emails.
 *
 * THE RULE THE WHOLE LIST FOLLOWS:
 *
 *   Email when the recipient must DO something, or has lost the chance to.
 *   Never as an activity feed.
 *
 * what emails: see docs/10-decisions/0020-what-is-worth-an-email.md
 *
 * Two halves, and they are deliberately far apart in time:
 *
 *   notify()              inside the transaction that caused the event:
 *                         one row, one queued job, no email
 *   sendNotification()    the worker, seconds later: compose from the rows as
 *                         they are NOW, send, and record that it went
 *
 * The gap is the point. A request that emails is a request that waits for
 * somebody else's server, and a request that decides who to email is a
 * request whose timing says who exists (#85's reasoning, and the leak it
 * closed in `POST /auth/forgot-password`).
 */

/** What can be sent. */
export type NotificationKind =
  /** Somebody offered to help with your need (#19). */
  | "proposal-received"
  /** Your offer was accepted and there is now a deal (#20). */
  | "proposal-accepted"
  /** The deal moved, or a quote arrived, and the next move is yours. */
  | "deal-your-turn"
  /** The other side walked away, or a moderator ended it. */
  | "deal-cancelled"
  /** A dispute was raised, or resolved by a moderator. */
  | "deal-disputed"
  /** The deal completed, so reviews are open for 14 days (#83). */
  | "deal-completed"
  /** A moderator acted on your account or your content (#26, #27). */
  | "moderation-decision";

/**
 * What the notification is ABOUT: which table, and which row.
 *
 * Not just an id, because one kind can be caused by two different things —
 * "your turn" is usually a status change, and once per deal it is a quote
 * arriving, which is not a status change at all (docs/04-deal-lifecycle.md,
 * "Quoting, separately from status"). The caller knows; the handler should
 * not have to guess by trying tables in turn.
 */
export type NotificationSubject =
  | { type: "proposal"; id: string }
  | { type: "deal-event"; id: string }
  | { type: "quote"; id: string }
  | { type: "admin-action"; id: string };

/**
 * The kinds a person cannot switch off.
 *
 * Being told that your account was suspended is not marketing, and somebody
 * who cannot be told cannot appeal. Everything else obeys the preference.
 */
const UNSTOPPABLE: NotificationKind[] = ["moderation-decision"];

/**
 * Records that somebody should be told, and queues the telling.
 *
 * Pass the transaction that caused the event. A notification about something
 * that was rolled back is a lie waiting to be sent, and #85's registration
 * learned the same lesson about its job.
 *
 * Returns nothing on purpose: a caller that could tell whether an email was
 * queued would start to depend on it, and the answer is none of a deal's
 * business.
 */
export async function notify(
  userId: string,
  kind: NotificationKind,
  subject: NotificationSubject,
  client: Prisma.TransactionClient = prisma,
): Promise<void> {
  const user = await client.user.findUnique({
    where: { id: userId },
    select: { status: true, emailNotifications: true },
  });

  if (!user || !wants(user, kind)) return;

  // ONE EVENT, ONE EMAIL — and the database decides it. `skipDuplicates` is
  // `ON CONFLICT DO NOTHING` against the unique index on
  // (userId, kind, subjectId), which two callers racing the same event can
  // both reach; a check-then-insert is something they can both pass.
  //
  // `createMany` rather than `create` for the same reason it has to be: a
  // `create` that hits the index throws, and a failed statement inside a
  // PostgreSQL transaction poisons the whole transaction — so catching the
  // error in JavaScript would not save the deal that is being written around
  // it.
  const written = await client.notification.createMany({
    data: {
      userId,
      kind,
      subjectId: subject.id,
      subjectType: subject.type,
    },
    skipDuplicates: true,
  });

  // Somebody already recorded this one, and queued its job. Leave it alone:
  // one row must not produce two emails.
  if (written.count === 0) return;

  // Read back for the id, which `createMany` does not return. The unique
  // index is also the way to find it again.
  const row = await client.notification.findUniqueOrThrow({
    where: { userId_kind_subjectId: { userId, kind, subjectId: subject.id } },
    select: { id: true },
  });

  await enqueue("notification", { notificationId: row.id }, client);
}

/**
 * Who hears about a deal landing somewhere, and what they are told.
 *
 * The side effects of a transition are NOT in services/transitions.ts, which
 * says so itself: "an engine that also performed them would be two things at
 * once". So this is the other table, and the document is the authority for
 * both — the "Side effect" column of docs/04-deal-lifecycle.md.
 *
 * what emails: see docs/10-decisions/0020-what-is-worth-an-email.md
 *
 * Three shapes, and the third is the one worth reading twice:
 *
 *   a side walked away      the OTHER side is owed nothing now, and has to
 *                           be told so
 *   completed               BOTH, including whoever pressed it: what is
 *                           announced is not the press, it is the fourteen
 *                           days of review window it opened (#83)
 *   anything else           only the person whose MOVE it now is, and only
 *                           when that is not the person who just acted —
 *                           half the table is silent for that reason
 */
export async function tellTheOthers(
  client: Prisma.TransactionClient,
  deal: { requesterId: string; helperId: string },
  eventId: string,
  to: DealStatus,
  actedBy: "requester" | "helper" | "moderator" | "system",
): Promise<void> {
  const subject = { type: "deal-event", id: eventId } as const;
  const sides = { requester: deal.requesterId, helper: deal.helperId };

  // Nobody in the deal did this — a moderator resolved a dispute, or the
  // sweep completed it (#101) — so there is nobody to leave out.
  if (actedBy === "moderator" || actedBy === "system") {
    const kind = endingKind(to) ?? "deal-disputed";

    await notify(sides.requester, kind, subject, client);
    await notify(sides.helper, kind, subject, client);
    return;
  }

  const other = actedBy === "requester" ? "helper" : "requester";

  if (to === "CANCELLED" || to === "DISPUTED") {
    await notify(
      sides[other],
      endingKind(to) ?? "deal-disputed",
      subject,
      client,
    );
    return;
  }

  if (to === "COMPLETED") {
    await notify(sides.requester, "deal-completed", subject, client);
    await notify(sides.helper, "deal-completed", subject, client);
    return;
  }

  // Whose move is it now? If it is the person who just moved it, nothing is
  // sent: an email about the button you have just pressed is noise.
  const next = NEXT_TO_ACT[to];
  if (next && next !== actedBy) {
    await notify(sides[next], "deal-your-turn", subject, client);
  }
}

/** The kind that matches a deal's ending, if it is one. */
function endingKind(to: DealStatus): NotificationKind | null {
  if (to === "CANCELLED") return "deal-cancelled";
  if (to === "COMPLETED") return "deal-completed";
  if (to === "DISPUTED") return "deal-disputed";
  return null;
}

/**
 * Whose move it is once a deal is in each status.
 *
 * transition table: see docs/04-deal-lifecycle.md — this is its "Who" column
 * read from the other end: not "who may move it from here" but "who we are
 * now waiting for". `MATCHED` is absent because the person it waits for was
 * told by `proposal-accepted` a moment earlier, and two emails about one
 * event is the thing this issue exists to prevent.
 */
const NEXT_TO_ACT: Partial<Record<DealStatus, "requester" | "helper">> = {
  QUOTE_AGREED: "requester",
  PRODUCT_PAID: "helper",
  PURCHASED: "helper",
  SHIPPED: "requester",
  DELIVERED: "requester",
};

/** Whether this person wants this kind of email. */
function wants(
  user: { status: string; emailNotifications: boolean },
  kind: NotificationKind,
): boolean {
  // Nothing is anybody's turn on an account that is gone or banned. #66 keeps
  // the row with an address nobody owns, at a domain RFC 2606 reserves, so
  // emailing it is at best pointless.
  if (user.status === "DELETED") return false;
  if (user.status === "BANNED") return UNSTOPPABLE.includes(kind);

  return user.emailNotifications || UNSTOPPABLE.includes(kind);
}

/**
 * Sends one recorded notification, or records why it did not.
 *
 * Registered as a `JobKind` handler in services/jobs.ts, so #85's retries,
 * backoff and reporting come for free.
 */
export async function sendNotification(notificationId: string): Promise<void> {
  const row = await prisma.notification.findUnique({
    where: { id: notificationId },
    include: {
      user: {
        select: { email: true, status: true, emailNotifications: true },
      },
    },
  });

  // A row that is not there any more is not a failure. Nothing deletes one
  // today, so this is the defensive case.
  if (!row) return;

  // ALREADY DEALT WITH, and this is "one event sends one email even if the
  // job runs twice": #85's queue is at-least-once by construction — a crash
  // after the provider accepted the message leaves the row to be claimed
  // again — so the Notification row is the memory, not the job.
  if (row.sentAt || row.skippedAt) return;

  const kind = row.kind as NotificationKind;

  // Asked a second time, because the gap between the event and the sending is
  // exactly where somebody goes and turns these off, or deletes their account.
  if (!wants(row.user, kind)) {
    await markSkipped(row.id, "the person no longer wants it");
    return;
  }

  const message = await compose(kind, row.subjectType, row.subjectId);

  // The thing it was about has gone. Nothing to say, and nothing to retry:
  // a job that fails five times and reports itself would be noise about a
  // deal that no longer exists.
  if (!message) {
    await markSkipped(row.id, "the subject has gone");
    return;
  }

  await mailer.sendNotificationEmail(
    row.user.email,
    message.subject,
    body(message.lines),
  );

  // After the send, never before: marking first and then failing would lose
  // the email for good, which is the one outcome the queue exists to prevent.
  await prisma.notification.update({
    where: { id: row.id },
    data: { sentAt: new Date() },
  });
}

async function markSkipped(id: string, why: string): Promise<void> {
  await prisma.notification.update({
    where: { id },
    data: { skippedAt: new Date() },
  });

  // The row says it was skipped; the log says why. A column for the reason
  // would be a column with four possible values and no reader (#103).
  logger.info({ notificationId: id, why }, "Notification not sent");
}

/** The subject line and the words, or null when the subject has gone. */
interface Message {
  subject: string;
  lines: string[];
}

/**
 * Writes the email, from the rows as they are NOW.
 *
 * Composed at sending time rather than at event time, which is why the
 * payload carries ids: an email saying "waiting for your payment" about a
 * deal that was cancelled an hour ago is worse than a late email.
 *
 * NO LINKS, for #119's reason — `APP_ORIGIN` is still the API's own address
 * because there is no frontend (#93), and a link to nowhere is worse than no
 * link. So every one of these has to name the need it is about: somebody with
 * three deals open cannot click to find out which this is.
 */
async function compose(
  kind: NotificationKind,
  subjectType: string,
  subjectId: string,
): Promise<Message | null> {
  if (subjectType === "proposal") {
    const proposal = await prisma.proposal.findUnique({
      where: { id: subjectId },
      include: {
        need: { select: { title: true } },
        helper: { select: { profile: { select: { displayName: true } } } },
      },
    });
    if (!proposal) return null;

    const who = proposal.helper.profile?.displayName ?? "Somebody";

    if (kind === "proposal-accepted") {
      return {
        subject: `Your offer was accepted: ${proposal.need.title}`,
        lines: [
          `Your offer to help with "${proposal.need.title}" was accepted, and there is now a deal.`,
          "",
          "What happens next: send a quote for the product and the postage, so the two of you can agree the amounts.",
        ],
      };
    }

    return {
      subject: `${who} offered to help: ${proposal.need.title}`,
      lines: [
        `${who} has offered to help with "${proposal.need.title}".`,
        "",
        "What happens next: look at the offer and accept it, or leave it. Nothing is agreed until you accept.",
      ],
    };
  }

  if (subjectType === "quote") {
    const quote = await prisma.quote.findUnique({
      where: { id: subjectId },
      include: { deal: { include: { need: { select: { title: true } } } } },
    });
    if (!quote) return null;

    return {
      subject: `A quote arrived: ${quote.deal.need.title}`,
      lines: [
        `There is a quote for "${quote.deal.need.title}".`,
        "",
        "What happens next: agree the amounts, and then pay for the product.",
      ],
    };
  }

  if (subjectType === "deal-event") {
    const event = await prisma.dealEvent.findUnique({
      where: { id: subjectId },
      include: { deal: { include: { need: { select: { title: true } } } } },
    });
    if (!event) return null;

    const title = event.deal.need.title;

    return dealMessage(kind, event.toStatus, title);
  }

  if (subjectType === "admin-action") {
    const action = await prisma.adminAction.findUnique({
      where: { id: subjectId },
      select: { type: true, reason: true, expiresAt: true },
    });
    if (!action) return null;

    return {
      subject: "A decision about your Farhand account",
      lines: [
        `A moderator has taken an action on your account: ${action.type}.`,
        "",
        `The reason given: ${action.reason}`,
        ...(action.expiresAt
          ? ["", `It ends on ${action.expiresAt.toISOString().slice(0, 10)}.`]
          : []),
        "",
        "If you think this is wrong, reply to this message and a moderator will look again.",
      ],
    };
  }

  return null;
}

/** The deal emails, keyed by what the deal became. */
function dealMessage(
  kind: NotificationKind,
  status: DealStatus,
  title: string,
): Message {
  if (kind === "deal-completed") {
    return {
      subject: `Completed, and you can leave a review: ${title}`,
      lines: [
        `The deal for "${title}" is complete.`,
        "",
        "What happens next: you have fourteen days to leave a review. Neither review is shown until both are in, or the fourteen days are up.",
      ],
    };
  }

  if (kind === "deal-cancelled") {
    return {
      subject: `Cancelled: ${title}`,
      lines: [
        `The deal for "${title}" has been cancelled, so nothing more is owed by either side.`,
      ],
    };
  }

  if (kind === "deal-disputed") {
    return {
      subject: `A dispute on the deal: ${title}`,
      lines: [
        `The deal for "${title}" is in dispute, and is frozen until a moderator looks at it.`,
        "",
        "What happens next: a moderator reads both sides. Neither of you can move the deal while it is frozen.",
      ],
    };
  }

  // "Your turn", which is the only one that depends on where the deal landed.
  return {
    subject: `Your turn: ${title}`,
    lines: [
      `Something has moved on the deal for "${title}".`,
      "",
      `What happens next: ${NEXT_MOVE[status] ?? "look at the deal."}`,
    ],
  };
}

/**
 * Whose move it is, in words, for each status a deal can land in.
 *
 * transition table: see docs/04-deal-lifecycle.md
 */
const NEXT_MOVE: Partial<Record<DealStatus, string>> = {
  QUOTE_AGREED: "pay for the product.",
  PRODUCT_PAID: "buy the thing, and keep the receipt if there is one.",
  PURCHASED: "post the parcel, with its tracking number and the real postage.",
  // The promise docs/04-deal-lifecycle.md has carried since #22: "Requester
  // notified to settle the difference".
  SHIPPED:
    "settle the difference between the estimated postage and what it really cost, and confirm when it arrives.",
  DELIVERED: "confirm that the deal is finished.",
};

/** The words, plus the line that every notification ends with. */
function body(lines: string[]): string {
  return [
    ...lines,
    "",
    "—",
    // NOT an unsubscribe link, deliberately: one unsubscribe click at the
    // provider blocks the address for everything we send, verification and
    // password resets included (decision 0015). The only safe place for "no
    // thank you" is inside Farhand.
    "You can turn these emails off in your Farhand notification settings. Emails about a moderator's decision are always sent.",
  ].join("\n");
}

/** Whether this person wants notification email at all. */
export async function setEmailNotifications(
  userId: string,
  enabled: boolean,
): Promise<boolean> {
  const user = await prisma.user.update({
    where: { id: userId },
    data: { emailNotifications: enabled },
    select: { emailNotifications: true },
  });

  return user.emailNotifications;
}
