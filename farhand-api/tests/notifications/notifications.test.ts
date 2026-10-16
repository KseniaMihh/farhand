import type { Notification } from "@prisma/client";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/app.js";
import { prisma } from "../../src/db.js";
import { mailer } from "../../src/mailer.js";
import { notify } from "../../src/services/notifications.js";
import { PASSWORD, signUpVerifiedAndLogIn } from "../helpers/auth.js";
import type { TestUser } from "../helpers/auth.js";
import { runQueuedJobs } from "../helpers/jobs.js";
import { createCategory } from "../helpers/needs.js";

/**
 * The notification mechanism — issue #86.
 *
 * These tests are the specification. They fail until the TODOs in
 * src/services/notifications.ts are filled in.
 *
 *   npm run test:watch -- notifications
 *
 * This file is the machinery: one event one email, the preference, who gets
 * nothing. WHICH events send anything is tests/notifications/events.test.ts,
 * and they are apart because they fail for different reasons — a wrong event
 * list is a product mistake, a second email for one event is a bug.
 *
 * Everything here goes through #85's queue, because that is how it runs:
 * `notify` writes a row and enqueues, and `runQueuedJobs()` stands in for the
 * two seconds before the worker picks it up.
 *
 * THE SUBJECTS ARE REAL ROWS, never invented ids, and that is not fussiness:
 * the email is composed when it is sent, from the rows as they are then, so a
 * notification whose subject has vanished is a case the handler has to have an
 * answer for. A test with `subjectId: "event-1"` would be testing that case
 * every time without saying so.
 */
const app = createApp();

let categoryId = "";
let kadri: TestUser;
let yuki: TestUser;

beforeEach(async () => {
  categoryId = (await createCategory()).id;
  kadri = await signUpVerifiedAndLogIn(app, "kadri@example.com", "Kadri");
  yuki = await signUpVerifiedAndLogIn(app, "yuki@example.com", "Yuki");
  // Registration queues verification email (#85). Clear it, or every count
  // in this file is one too many.
  await prisma.job.deleteMany({});
  await prisma.notification.deleteMany({});
});

/** Everything recorded for one person, oldest first. */
function recorded(userId: string): Promise<Notification[]> {
  return prisma.notification.findMany({
    where: { userId },
    orderBy: { createdAt: "asc" },
  });
}

/** The fake provider: what would have been emailed, to whom. */
function watchTheMail() {
  return vi.spyOn(mailer, "sendNotificationEmail").mockResolvedValue();
}

/** A real proposal on a need of Kadri's, as if Yuki had offered to help. */
async function aProposal(title = "Japanese sunscreen"): Promise<string> {
  const need = await prisma.need.create({
    data: {
      requesterId: kadri.id,
      categoryId,
      title,
      description: "The one not sold in Europe",
      buyCountry: "JP",
      deliverCountry: "EE",
      currency: "EUR",
      estimatedPrice: 2400,
      status: "OPEN",
    },
  });
  const proposal = await prisma.proposal.create({
    data: { needId: need.id, helperId: yuki.id, initiatedBy: "HELPER" },
  });

  return proposal.id;
}

/**
 * The subject of a notification: WHICH TABLE and which row, not just an id.
 *
 * One kind can be caused by two different things — "your turn" is usually a
 * status change, and once per deal it is a quote arriving, which is not a
 * status change at all — so the caller says which, rather than the handler
 * guessing by trying tables in turn.
 */
function proposal(id: string) {
  return { type: "proposal" as const, id };
}

/** A real moderator's decision about Kadri. */
async function anAdminAction(): Promise<string> {
  const mo = await signUpVerifiedAndLogIn(app, "mo@example.com", "Mo");
  await prisma.user.update({
    where: { id: mo.id },
    data: { role: "MODERATOR" },
  });
  const action = await prisma.adminAction.create({
    data: {
      adminId: mo.id,
      targetUserId: kadri.id,
      type: "SUSPEND",
      reason: "Shouting at a helper",
    },
  });
  await prisma.job.deleteMany({});

  return action.id;
}

describe("recording that somebody should be told", () => {
  it("writes one row and queues the telling, and sends nothing yet", async () => {
    const sent = watchTheMail();
    const proposalId = await aProposal();

    await notify(kadri.id, "proposal-received", proposal(proposalId));

    // The row exists and says nothing has happened to it yet.
    const [row] = await recorded(kadri.id);
    expect(row).toMatchObject({
      kind: "proposal-received",
      subjectId: proposalId,
      sentAt: null,
      skippedAt: null,
    });
    // One job waiting, and no email: the sending belongs to the worker (#85).
    expect(await prisma.job.count({ where: { kind: "notification" } })).toBe(1);
    expect(sent).not.toHaveBeenCalled();

    await runQueuedJobs();

    expect(sent).toHaveBeenCalledTimes(1);
    expect(sent.mock.calls[0]?.[0]).toBe("kadri@example.com");
    expect((await recorded(kadri.id))[0]?.sentAt).toBeInstanceOf(Date);
  });

  it("keys on what happened, so the same kind of news can arrive twice", async () => {
    watchTheMail();

    // Two people offering to help with two needs is two emails, not one
    // followed by a duplicate swallowed by the unique index. Keyed on the
    // event, the deal-keyed version of this index would have lost the second.
    await notify(
      kadri.id,
      "proposal-received",
      proposal(await aProposal("Sunscreen")),
    );
    await notify(
      kadri.id,
      "proposal-received",
      proposal(await aProposal("Matcha")),
    );

    expect(await recorded(kadri.id)).toHaveLength(2);
    await runQueuedJobs();
    expect(
      (await recorded(kadri.id)).filter((row) => row.sentAt !== null),
    ).toHaveLength(2);
  });

  it("dies with the transaction that caused it", async () => {
    const proposalId = await aProposal();

    await expect(
      prisma.$transaction(async (tx) => {
        await notify(kadri.id, "proposal-received", proposal(proposalId), tx);
        throw new Error("the deal did not happen after all");
      }),
    ).rejects.toThrow("after all");

    // A notification about something that was rolled back is a lie waiting to
    // be sent. #85's registration learned the same about its job.
    expect(await recorded(kadri.id)).toHaveLength(0);
    expect(await prisma.job.count()).toBe(0);
  });

  it("says so and sends nothing when the subject has vanished", async () => {
    const sent = watchTheMail();
    const proposalId = await aProposal();
    await notify(kadri.id, "proposal-received", proposal(proposalId));

    // Nothing in this project hard-deletes a proposal, so this is the
    // defensive case rather than a daily one. It is here because the handler
    // reads rows an hour after they were true, and "I cannot find what this
    // was about" must not become a job that fails five times and a report.
    await prisma.proposal.deleteMany({ where: { id: proposalId } });
    await runQueuedJobs();

    expect(sent).not.toHaveBeenCalled();
    expect((await recorded(kadri.id))[0]?.skippedAt).toBeInstanceOf(Date);
    expect(
      await prisma.job.count({ where: { kind: "notification", doneAt: null } }),
    ).toBe(0);
  });
});

describe("one event, one email", () => {
  it("makes one row when two callers race the same event", async () => {
    const sent = watchTheMail();
    const proposalId = await aProposal();

    await notify(kadri.id, "proposal-received", proposal(proposalId));
    await notify(kadri.id, "proposal-received", proposal(proposalId));

    // Held by the unique index rather than by a check-then-insert, which two
    // workers can both pass.
    expect(await recorded(kadri.id)).toHaveLength(1);
    // And the second caller queues no second job, or one row would send two
    // emails.
    expect(await prisma.job.count({ where: { kind: "notification" } })).toBe(1);

    await runQueuedJobs();
    expect(sent).toHaveBeenCalledTimes(1);
  });

  it("sends nothing the second time the job runs", async () => {
    const sent = watchTheMail();
    await notify(kadri.id, "proposal-received", proposal(await aProposal()));

    await runQueuedJobs();

    // The row, not the job, is the memory: #85's queue is at-least-once by
    // design — a crash after the provider accepted the message leaves the row
    // to be claimed again — so the handler has to recognise its own work.
    //
    // `runAfter` MATTERS HERE, and leaving it out is how this test first
    // passed against an implementation with the guard deleted: claiming a job
    // pushes `runAfter` a backoff into the future (#85's lease), so a revived
    // job that is not also made due again is a job the next drain steps over.
    // The test then proved that nothing happens when nothing runs.
    await prisma.job.updateMany({
      data: { doneAt: null, attempts: 0, runAfter: new Date() },
    });
    await runQueuedJobs();

    expect(sent).toHaveBeenCalledTimes(1);
  });

  it("is still owed when the provider fails, and not sent twice when it recovers", async () => {
    const sent = vi
      .spyOn(mailer, "sendNotificationEmail")
      .mockRejectedValue(new Error("502 from the provider"));
    await notify(kadri.id, "proposal-received", proposal(await aProposal()));

    await runQueuedJobs();

    // #85's retry, not a second notification: the row is untouched, waiting.
    expect((await recorded(kadri.id))[0]).toMatchObject({
      sentAt: null,
      skippedAt: null,
    });
    expect(
      await prisma.job.findFirstOrThrow({ where: { kind: "notification" } }),
    ).toMatchObject({ attempts: 1, doneAt: null, failedAt: null });

    sent.mockResolvedValue();
    await prisma.job.updateMany({ data: { runAfter: new Date() } });
    await runQueuedJobs();

    expect(sent).toHaveBeenCalledTimes(2);
    expect((await recorded(kadri.id))[0]?.sentAt).toBeInstanceOf(Date);
  });
});

describe("the preference", () => {
  it("records nothing and sends nothing when they have turned it off", async () => {
    const sent = watchTheMail();
    const proposalId = await aProposal();
    await prisma.user.update({
      where: { id: kadri.id },
      data: { emailNotifications: false },
    });

    await notify(kadri.id, "proposal-received", proposal(proposalId));

    // Read once at the event: an opted-out person costs one SELECT and no
    // row, rather than a row that exists only to be skipped.
    expect(await recorded(kadri.id)).toHaveLength(0);
    expect(await prisma.job.count()).toBe(0);
    await runQueuedJobs();
    expect(sent).not.toHaveBeenCalled();
  });

  it("is read again at the send, and a change in between is honoured", async () => {
    const sent = watchTheMail();
    await notify(kadri.id, "proposal-received", proposal(await aProposal()));

    // The gap between the event and the sending is exactly where somebody
    // goes and turns these off.
    await prisma.user.update({
      where: { id: kadri.id },
      data: { emailNotifications: false },
    });
    await runQueuedJobs();

    expect(sent).not.toHaveBeenCalled();
    // Not sent, and the row says so rather than sitting there looking owed.
    expect((await recorded(kadri.id))[0]).toMatchObject({
      sentAt: null,
      skippedAt: expect.any(Date) as Date,
    });
    // And the job is DONE: there is nothing to retry about a decision.
    expect(
      await prisma.job.count({ where: { kind: "notification", doneAt: null } }),
    ).toBe(0);
  });

  it("does not silence a moderator's decision", async () => {
    const sent = watchTheMail();
    const actionId = await anAdminAction();
    await prisma.user.update({
      where: { id: kadri.id },
      data: { emailNotifications: false },
    });

    await notify(kadri.id, "moderation-decision", {
      type: "admin-action",
      id: actionId,
    });
    await runQueuedJobs();

    // Being told your account was suspended is not marketing, and somebody
    // who cannot be told cannot appeal (decision 0020).
    expect(sent).toHaveBeenCalledTimes(1);
    expect((await recorded(kadri.id))[0]?.sentAt).toBeInstanceOf(Date);
  });
});

describe("who gets nothing at all", () => {
  it("emails no deleted account", async () => {
    const sent = watchTheMail();
    const proposalId = await aProposal();
    await request(app)
      .delete("/me")
      .set("Cookie", kadri.cookie)
      .set("Origin", "http://localhost:3000")
      .send({ password: PASSWORD });

    await notify(kadri.id, "proposal-received", proposal(proposalId));
    await runQueuedJobs();

    // #66: the row stays with status DELETED and an address nobody owns, at a
    // domain RFC 2606 reserves. Emailing it is at best pointless.
    expect(await recorded(kadri.id)).toHaveLength(0);
    expect(sent).not.toHaveBeenCalled();
  });

  it("emails no banned account — unless it is a moderator's decision", async () => {
    const sent = watchTheMail();
    const proposalId = await aProposal();
    const actionId = await anAdminAction();
    await prisma.user.update({
      where: { id: kadri.id },
      data: { status: "BANNED" },
    });

    await notify(kadri.id, "proposal-received", proposal(proposalId));
    await notify(kadri.id, "moderation-decision", {
      type: "admin-action",
      id: actionId,
    });
    await runQueuedJobs();

    // Nothing is anybody's turn on a banned account. The ban itself still has
    // to be tellable.
    expect(await recorded(kadri.id)).toHaveLength(1);
    expect((await recorded(kadri.id))[0]?.kind).toBe("moderation-decision");
    expect(sent).toHaveBeenCalledTimes(1);
  });

  it("stops a deletion that happens after the event", async () => {
    const sent = watchTheMail();
    await notify(kadri.id, "proposal-received", proposal(await aProposal()));

    await prisma.user.update({
      where: { id: kadri.id },
      data: { status: "DELETED" },
    });
    await runQueuedJobs();

    expect(sent).not.toHaveBeenCalled();
    expect((await recorded(kadri.id))[0]?.skippedAt).toBeInstanceOf(Date);
  });
});

describe("the email itself", () => {
  it("says what happened, how to stop them, and carries no link", async () => {
    const sent = watchTheMail();

    await notify(
      kadri.id,
      "proposal-received",
      proposal(await aProposal("Matcha")),
    );
    await runQueuedJobs();

    const [, subject, text] = sent.mock.calls[0] ?? [];
    // What it is about, in the subject, where a phone shows it.
    expect(subject).toMatch(/offer|help|proposal/i);
    // Composed from the rows as they are now, so it can say which need.
    expect(text).toContain("Matcha");
    // No link, for #119's reason: `APP_ORIGIN` is still the API's own address
    // because there is no frontend (#93), and a link to nowhere is worse than
    // no link.
    expect(text).not.toMatch(/https?:\/\//);
    // The opt-out is a setting in Farhand, not an unsubscribe link of our
    // own: one unsubscribe click at the provider blocks the address for
    // everything, verification included (decision 0015).
    expect(text).toMatch(/turn these emails off/i);
    expect(text).toMatch(/notification settings/i);
    expect(text).not.toMatch(/unsubscribe/i);
  });

  it("never says more about somebody else than the recipient may see", async () => {
    const sent = watchTheMail();

    // Composed from rows that belong to somebody else: a display name is
    // public (#65), an email address never is.
    await notify(kadri.id, "proposal-received", proposal(await aProposal()));
    await runQueuedJobs();

    expect(sent.mock.calls[0]?.[2] ?? "").not.toContain(yuki.email);
  });
});
