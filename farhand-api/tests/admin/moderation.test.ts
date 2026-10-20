import type { Need } from "@prisma/client";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/app.js";
import { prisma } from "../../src/db.js";
import { logger } from "../../src/logger.js";
import { PASSWORD, signUpVerifiedAndLogIn } from "../helpers/auth.js";
import type { TestUser } from "../helpers/auth.js";
import { fileFixture } from "../helpers/files.js";
import { keysWithin } from "../helpers/http.js";
import { createCategory } from "../helpers/needs.js";
import { breakInsideTransaction } from "../helpers/transactions.js";

/**
 * Moderation actions and the audit log — issue #27.
 *
 * These tests are the specification. They fail until the TODOs in
 * src/services/moderation.ts and src/services/conversations.ts are filled in.
 *
 *   npm run test:watch -- moderation
 *
 * Mo is a moderator, Kadri and Yuki are the two people in a deal and a
 * conversation, and Marek is a bystander who reports things.
 */
const app = createApp();

let categoryId = "";
let mo: TestUser;
let kadri: TestUser;
let yuki: TestUser;
let marek: TestUser;

beforeEach(async () => {
  categoryId = (await createCategory()).id;
  kadri = await signUpVerifiedAndLogIn(app, "kadri@example.com", "Kadri");
  yuki = await signUpVerifiedAndLogIn(app, "yuki@example.com", "Yuki");
  marek = await signUpVerifiedAndLogIn(app, "marek@example.com", "Marek");
  mo = await signUpVerifiedAndLogIn(app, "mo@example.com", "Mo");
  await prisma.user.update({
    where: { id: mo.id },
    data: { role: "MODERATOR" },
  });
});

async function makeNeed(overrides: Partial<Need> = {}) {
  return prisma.need.create({
    data: {
      requesterId: kadri.id,
      categoryId,
      title: "Japanese sunscreen",
      description: "The one not sold in Europe",
      buyCountry: "JP",
      deliverCountry: "EE",
      currency: "EUR",
      estimatedPrice: 2400,
      status: "OPEN",
      ...overrides,
    },
  });
}

async function makeHelp() {
  return prisma.help.create({
    data: {
      helperId: yuki.id,
      country: "JP",
      shipsTo: ["EE"],
      description: "I post to the Baltics every other week.",
      status: "ACTIVE",
      categories: { connect: [{ id: categoryId }] },
    },
  });
}

/** Kadri's need, Yuki's proposal, a thread between them, and their deal. */
async function conversation() {
  const need = await makeNeed();
  await request(app)
    .post(`/needs/${need.id}/proposals`)
    .set("Cookie", yuki.cookie)
    .send({});
  const proposal = await prisma.proposal.findFirstOrThrow({
    where: { needId: need.id },
  });
  await request(app)
    .post(`/proposals/${proposal.id}/messages`)
    .set("Cookie", yuki.cookie)
    .send({ body: "Is this the right one?" });
  const message = await prisma.message.findFirstOrThrow();
  const thread = await prisma.conversation.findFirstOrThrow();

  return { need, proposal, message, thread };
}

function act(user: TestUser, targetId: string, body: object) {
  return request(app)
    .post(`/admin/users/${targetId}/actions`)
    .set("Cookie", user.cookie)
    .send(body);
}

function remove(user: TestUser, type: string, id: string, reason = "Spam") {
  return request(app)
    .post(`/admin/content/${type}/${id}/remove`)
    .set("Cookie", user.cookie)
    .send({ reason });
}

function readThread(user: TestUser, threadId: string) {
  return request(app)
    .get(`/conversations/${threadId}/messages`)
    .set("Cookie", user.cookie);
}

interface ActionBody {
  action: {
    id: string;
    adminId: string;
    targetUserId: string;
    type: string;
    reason: string;
    contentType: string | null;
    contentId: string | null;
    expiresAt: string | null;
  };
}

describe("POST /admin/users/:id/actions", () => {
  it("warns without changing anything but the record", async () => {
    const response = await act(mo, yuki.id, {
      type: "WARN",
      reason: "Please stop asking people to pay outside the platform",
    });
    const body = response.body as ActionBody;

    expect(response.status).toBe(201);
    expect(body.action.type).toBe("WARN");
    expect(body.action.adminId).toBe(mo.id);
    expect(body.action.targetUserId).toBe(yuki.id);
    expect(body.action.reason).toBe(
      "Please stop asking people to pay outside the platform",
    );
    // A warning IS the record. Nothing about the account changes.
    const after = await prisma.user.findUniqueOrThrow({
      where: { id: yuki.id },
    });
    expect(after.status).toBe("ACTIVE");
  });

  it("suspends, and the suspension actually stops them acting", async () => {
    const until = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    const response = await act(mo, yuki.id, {
      type: "SUSPEND",
      reason: "Abusive messages",
      until: until.toISOString(),
    });

    expect(response.status).toBe(201);
    const after = await prisma.user.findUniqueOrThrow({
      where: { id: yuki.id },
    });
    expect(after.status).toBe("SUSPENDED");
    expect(after.suspendedUntil?.toISOString()).toBe(until.toISOString());
    expect((response.body as ActionBody).action.expiresAt).toBe(
      until.toISOString(),
    );

    // The third criterion, end to end: reading is fine, doing is not.
    expect((await request(app).get("/needs")).status).toBe(200);
    const posting = await request(app)
      .post("/helps")
      .set("Cookie", yuki.cookie)
      .send({
        country: "JP",
        description: "Still here",
        categoryIds: [categoryId],
      });
    expect(posting.status).toBe(403);
  });

  it("suspends with no end date at all", async () => {
    await act(mo, yuki.id, { type: "SUSPEND", reason: "Under review" });

    const after = await prisma.user.findUniqueOrThrow({
      where: { id: yuki.id },
    });
    // Null means "until somebody lifts it", and requireActive already reads it
    // that way (#41).
    expect(after.status).toBe("SUSPENDED");
    expect(after.suspendedUntil).toBeNull();
  });

  it("bans, and a banned account cannot sign in again", async () => {
    await act(mo, yuki.id, { type: "BAN", reason: "Scam attempts" });

    const after = await prisma.user.findUniqueOrThrow({
      where: { id: yuki.id },
    });
    expect(after.status).toBe("BANNED");
    const login = await request(app)
      .post("/auth/login")
      .send({ email: "yuki@example.com", password: PASSWORD });
    expect(login.status).toBe(403);
  });

  it("reactivates a suspended account and a banned one", async () => {
    await act(mo, yuki.id, {
      type: "SUSPEND",
      reason: "Under review",
      until: new Date(Date.now() + 86_400_000).toISOString(),
    });
    await act(mo, marek.id, { type: "BAN", reason: "Scam attempts" });

    const unsuspend = await act(mo, yuki.id, {
      type: "REACTIVATE",
      reason: "Explained herself",
    });
    const unban = await act(mo, marek.id, {
      type: "REACTIVATE",
      reason: "Wrong account",
    });

    // Pinned, or an endpoint that did nothing at all would pass the rest of
    // this test: both accounts started active.
    expect(unsuspend.status).toBe(201);
    expect(unban.status).toBe(201);

    const unsuspended = await prisma.user.findUniqueOrThrow({
      where: { id: yuki.id },
    });
    const unbanned = await prisma.user.findUniqueOrThrow({
      where: { id: marek.id },
    });
    expect(unsuspended.status).toBe("ACTIVE");
    // Cleared, or requireActive would keep refusing them after a later
    // suspension is lifted.
    expect(unsuspended.suspendedUntil).toBeNull();
    expect(unbanned.status).toBe("ACTIVE");
  });

  it("keeps every action, so a pattern is visible", async () => {
    await act(mo, yuki.id, { type: "WARN", reason: "First time" });
    await act(mo, yuki.id, { type: "WARN", reason: "Second time" });
    await act(mo, yuki.id, { type: "SUSPEND", reason: "Third time" });

    const history = await prisma.adminAction.findMany({
      where: { targetUserId: yuki.id },
      orderBy: { createdAt: "asc" },
    });
    // The status says "suspended". Only the log says "after two warnings".
    expect(history.map((row) => row.type)).toEqual(["WARN", "WARN", "SUSPEND"]);
  });

  it("will not act without a reason", async () => {
    expect((await act(mo, yuki.id, { type: "WARN" })).status).toBe(422);
    expect(
      (await act(mo, yuki.id, { type: "WARN", reason: "   " })).status,
    ).toBe(422);
    expect(await prisma.adminAction.count()).toBe(0);
  });

  it("refuses an end date on anything but a suspension", async () => {
    const response = await act(mo, yuki.id, {
      type: "BAN",
      reason: "Scam",
      until: new Date(Date.now() + 86_400_000).toISOString(),
    });

    // A ban that quietly expires is not a ban, and a caller who sends this
    // believes something untrue about what will happen.
    expect(response.status).toBe(422);
  });

  it("does not let moderators moderate each other, or themselves", async () => {
    const otherMod = await signUpVerifiedAndLogIn(
      app,
      "other@example.com",
      "Other",
    );
    await prisma.user.update({
      where: { id: otherMod.id },
      data: { role: "ADMIN" },
    });

    const sideways = await act(mo, otherMod.id, {
      type: "BAN",
      reason: "Disagreement",
    });
    const inward = await act(mo, mo.id, { type: "WARN", reason: "Oops" });

    expect(sideways.status).toBe(403);
    expect(inward.status).toBe(403);
  });

  it("refuses an account that is already gone", async () => {
    await prisma.user.update({
      where: { id: marek.id },
      data: { status: "DELETED", deletedAt: new Date() },
    });

    const response = await act(mo, marek.id, {
      type: "BAN",
      reason: "Too late",
    });

    expect(response.status).toBe(409);
  });

  it("answers 404 for somebody who does not exist", async () => {
    expect(
      (await act(mo, "no-such-user", { type: "WARN", reason: "x" })).status,
    ).toBe(404);
  });

  it("is closed to everybody but moderators", async () => {
    expect(
      (await act(marek, yuki.id, { type: "WARN", reason: "x" })).status,
    ).toBe(403);
    expect(
      (
        await request(app)
          .post(`/admin/users/${yuki.id}/actions`)
          .send({ type: "WARN", reason: "x" })
      ).status,
    ).toBe(401);
  });

  it("writes the action and the status change together, or neither", async () => {
    const broken = breakInsideTransaction("adminAction" as never);

    const response = await act(mo, yuki.id, {
      type: "BAN",
      reason: "Scam attempts",
    });
    vi.restoreAllMocks();

    expect(response.status).toBe(500);
    expect(broken.attempts).toBe(1);
    // A ban nobody can account for is worse than no ban at all.
    const after = await prisma.user.findUniqueOrThrow({
      where: { id: yuki.id },
    });
    expect(after.status).toBe("ACTIVE");
    expect(await prisma.adminAction.count()).toBe(0);
  });
});

describe("POST /admin/content/:type/:id/remove", () => {
  it("takes a need down and records which one", async () => {
    const need = await makeNeed();

    const response = await remove(mo, "NEED", need.id, "Prohibited item");
    const body = response.body as ActionBody;

    expect(response.status).toBe(201);
    expect(body.action.type).toBe("REMOVE_CONTENT");
    // Both halves: whose account it was about, and what was actually removed.
    expect(body.action.targetUserId).toBe(kadri.id);
    expect(body.action.contentType).toBe("NEED");
    expect(body.action.contentId).toBe(need.id);
    expect(
      (await prisma.need.findUniqueOrThrow({ where: { id: need.id } })).status,
    ).toBe("REMOVED");
  });

  it("takes an offer down", async () => {
    const help = await makeHelp();

    const response = await remove(mo, "HELP", help.id);

    expect(response.status).toBe(201);
    expect((response.body as ActionBody).action.targetUserId).toBe(yuki.id);
    expect(
      (await prisma.help.findUniqueOrThrow({ where: { id: help.id } })).status,
    ).toBe("REMOVED");
  });

  it("hides a message without destroying it", async () => {
    const { message, thread } = await conversation();

    const response = await remove(mo, "MESSAGE", message.id, "Harassment");

    expect(response.status).toBe(201);
    expect((response.body as ActionBody).action.targetUserId).toBe(yuki.id);
    const stored = await prisma.message.findUniqueOrThrow({
      where: { id: message.id },
    });
    // The row stays as evidence; the words stop being readable (#21).
    expect(stored.removedAt).not.toBeNull();
    expect(stored.body).toBe("Is this the right one?");
    const read = await readThread(kadri, thread.id);
    expect(
      (read.body as { items: { body: string | null }[] }).items[0]?.body,
    ).toBeNull();
  });

  it("refuses to remove a user, because that is what banning is for", async () => {
    const response = await remove(mo, "USER", yuki.id);

    expect(response.status).toBe(422);
  });

  it("refuses to remove the same thing twice", async () => {
    const need = await makeNeed();
    await remove(mo, "NEED", need.id);

    const again = await remove(mo, "NEED", need.id);

    // Already gone. A second entry in the log would suggest it came back.
    expect(again.status).toBe(409);
    expect(await prisma.adminAction.count()).toBe(1);
  });

  it("answers 404 for content that does not exist", async () => {
    expect((await remove(mo, "NEED", "banana")).status).toBe(404);
    expect((await remove(mo, "MESSAGE", "banana")).status).toBe(404);
  });

  it("is closed to everybody but moderators", async () => {
    const need = await makeNeed();

    expect((await remove(marek, "NEED", need.id)).status).toBe(403);
  });
});

describe("POST /admin/reports/:id/resolve", () => {
  async function openReport() {
    const need = await makeNeed();
    await request(app)
      .post("/reports")
      .set("Cookie", marek.cookie)
      .send({ targetType: "NEED", targetId: need.id, reason: "SPAM" });

    return {
      need,
      report: await prisma.report.findFirstOrThrow(),
    };
  }

  function resolve(user: TestUser, reportId: string, body: object) {
    return request(app)
      .post(`/admin/reports/${reportId}/resolve`)
      .set("Cookie", user.cookie)
      .send(body);
  }

  it("closes it, and says who closed it and why", async () => {
    const { report } = await openReport();

    const response = await resolve(mo, report.id, {
      outcome: "RESOLVED",
      resolutionNote: "Listing removed",
    });

    expect(response.status).toBe(200);
    const after = await prisma.report.findUniqueOrThrow({
      where: { id: report.id },
    });
    expect(after.status).toBe("RESOLVED");
    expect(after.resolvedById).toBe(mo.id);
    expect(after.resolvedAt).not.toBeNull();
    expect(after.resolutionNote).toBe("Listing removed");
  });

  it("dismisses one that had nothing in it", async () => {
    const { report } = await openReport();

    await resolve(mo, report.id, {
      outcome: "DISMISSED",
      resolutionNote: "Nothing wrong with this listing",
    });

    const after = await prisma.report.findUniqueOrThrow({
      where: { id: report.id },
    });
    expect(after.status).toBe("DISMISSED");
  });

  it("writes no AdminAction, because resolving is not an action", async () => {
    const { report } = await openReport();

    const response = await resolve(mo, report.id, {
      outcome: "DISMISSED",
      resolutionNote: "Nothing wrong",
    });

    expect(response.status).toBe(200);
    // The log is about what was done to an ACCOUNT. If the moderator also
    // removed something, that call wrote its own entry.
    expect(await prisma.adminAction.count()).toBe(0);
  });

  it("insists on a note", async () => {
    const { report } = await openReport();

    const response = await resolve(mo, report.id, { outcome: "RESOLVED" });

    expect(response.status).toBe(422);
  });

  it("refuses one that is already closed", async () => {
    const { report } = await openReport();
    await resolve(mo, report.id, {
      outcome: "RESOLVED",
      resolutionNote: "Done",
    });

    const again = await resolve(mo, report.id, {
      outcome: "DISMISSED",
      resolutionNote: "Changed my mind",
    });

    expect(again.status).toBe(409);
  });

  it("lets the reporter report it again if it happens again", async () => {
    const { need, report } = await openReport();
    await resolve(mo, report.id, {
      outcome: "RESOLVED",
      resolutionNote: "Warned them",
    });

    const second = await request(app)
      .post("/reports")
      .set("Cookie", marek.cookie)
      .send({ targetType: "NEED", targetId: need.id, reason: "SPAM" });

    // This is what "one OPEN report per person per target" was for (#26).
    expect(second.status).toBe(201);
  });

  it("is closed to everybody but moderators", async () => {
    const { report } = await openReport();

    const response = await resolve(marek, report.id, {
      outcome: "RESOLVED",
      resolutionNote: "I decide now",
    });

    expect(response.status).toBe(403);
  });
});

describe("GET /admin/reports/:id — seeing what was reported", () => {
  /**
   * Who reports matters: #26 only lets one of the two people in a conversation
   * report a message in it, so a bystander cannot stand in for Kadri here.
   */
  async function reportOn(
    targetType: string,
    targetId: string,
    reporter: TestUser = marek,
  ) {
    const response = await request(app)
      .post("/reports")
      .set("Cookie", reporter.cookie)
      .send({ targetType, targetId, reason: "PROHIBITED_ITEM" });
    expect(response.status).toBe(201);

    return prisma.report.findFirstOrThrow({ orderBy: { createdAt: "desc" } });
  }

  it("shows the need a report is about", async () => {
    const need = await makeNeed();
    const report = await reportOn("NEED", need.id);

    const response = await request(app)
      .get(`/admin/reports/${report.id}`)
      .set("Cookie", mo.cookie);
    const body = response.body as {
      report: { id: string };
      target: { id: string; title: string } | null;
    };

    // #26's queue held an id and a type and nothing else, so a moderator could
    // see that something was reported but not what.
    expect(response.status).toBe(200);
    expect(body.report.id).toBe(report.id);
    expect(body.target?.title).toBe("Japanese sunscreen");
  });

  /**
   * The gap #81 found, which is two gaps.
   *
   * `ReportReason` has had PROHIBITED_ITEM since #26, and the thing such a
   * report is usually about is the PICTURE. But the rule for a need's photo
   * (src/services/files.ts) named only the owner and the public, so the moment
   * a moderator acted — REMOVED is not OPEN or MATCHED — the evidence they
   * acted on became invisible, to them most of all. And the report view had no
   * photos in it at all, so even before that they had no id to ask for.
   *
   * Both halves are needed. A rule that admits a moderator to an address
   * nothing gives them is dead code; a path they are not allowed to follow is
   * a 404.
   */
  it("shows a reported need's photos, and lets a moderator open them", async () => {
    const need = await makeNeed();
    const photo = await fileFixture({
      ownerId: kadri.id,
      purpose: "NEED_PHOTO",
      needId: need.id,
    });
    const report = await reportOn("NEED", need.id);

    const seen = await request(app)
      .get(`/admin/reports/${report.id}`)
      .set("Cookie", mo.cookie);
    expect(seen.status).toBe(200);
    expect(
      (seen.body as { target: { photos: { id: string; url: string }[] } })
        .target.photos,
    ).toEqual([{ id: photo.id, url: `/files/${photo.id}` }]);

    // Before taking it down, and after: the second is the one that used to
    // fail, and it is the one that matters, because a resolved report is
    // reviewed by somebody else later.
    expect(
      (await request(app).get(`/files/${photo.id}`).set("Cookie", mo.cookie))
        .status,
    ).toBe(302);

    expect((await remove(mo, "NEED", need.id, "Prohibited item")).status).toBe(
      201,
    );

    expect(
      (await request(app).get(`/files/${photo.id}`).set("Cookie", mo.cookie))
        .status,
    ).toBe(302);
    // And it is still hidden from everybody else, which is the half that must
    // not have been widened to achieve the half above.
    expect(
      (await request(app).get(`/files/${photo.id}`).set("Cookie", marek.cookie))
        .status,
    ).toBe(404);
  });

  it("shows a reported message, an offer and a person", async () => {
    const { message } = await conversation();
    const help = await makeHelp();

    const onMessage = await reportOn("MESSAGE", message.id, kadri);
    const onHelp = await reportOn("HELP", help.id);
    const onUser = await reportOn("USER", yuki.id);

    for (const report of [onMessage, onHelp, onUser]) {
      const response = await request(app)
        .get(`/admin/reports/${report.id}`)
        .set("Cookie", mo.cookie);
      expect(response.status).toBe(200);
      expect((response.body as { target: unknown }).target).not.toBeNull();
    }
  });

  it("copes with a target that has since been deleted", async () => {
    const need = await makeNeed();
    const report = await reportOn("NEED", need.id);
    await prisma.need.delete({ where: { id: need.id } });

    const response = await request(app)
      .get(`/admin/reports/${report.id}`)
      .set("Cookie", mo.cookie);

    // The report still has to be resolvable, or the queue jams on a row
    // nobody can close.
    expect(response.status).toBe(200);
    expect((response.body as { target: unknown }).target).toBeNull();
  });

  it("is closed to everybody but moderators", async () => {
    const need = await makeNeed();
    const report = await reportOn("NEED", need.id);

    const response = await request(app)
      .get(`/admin/reports/${report.id}`)
      .set("Cookie", marek.cookie);

    expect(response.status).toBe(403);
  });

  /* ───────────── what a report shows of a person (#95) ───────────── */

  /**
   * The bug this issue is named for. `getReportWithTarget` loaded the whole
   * `User` row and the route answered `res.json(found)` with no serialiser in
   * between, so a report about a person handed the moderator that person's
   * `passwordHash` — and their email address, beside the one endpoint
   * docs/06-api-contract.md calls the only one that returns one.
   *
   * Nothing caught it, and the near miss is worth recording: the identical
   * assertion already existed in tests/admin/user-search.test.ts, for the
   * search. The test above, "shows a reported message, an offer and a person",
   * asked only that the target was not null — which the whole row satisfied
   * perfectly.
   */
  it("never hands over a reported person's password hash", async () => {
    const report = await reportOn("USER", yuki.id);

    const response = await request(app)
      .get(`/admin/reports/${report.id}`)
      .set("Cookie", mo.cookie);

    expect(response.status).toBe(200);

    // The whole reply, not just `target`: a hash anywhere in this response is
    // the bug, wherever a later change might put it.
    const sent = JSON.stringify(response.body);
    expect(sent).not.toContain("passwordHash");

    // And the value, not only the column name — a renamed column would walk
    // straight past the line above.
    const row = await prisma.user.findUniqueOrThrow({
      where: { id: yuki.id },
      select: { passwordHash: true },
    });
    expect(sent).not.toContain(row.passwordHash);
  });

  /**
   * The second half of the same leak, and a decision rather than an oversight:
   * `GET /admin/users` stays the only endpoint in the API that returns an
   * email address, because it is the one that records who looked
   * (docs/06-api-contract.md). A report carrying one would be an unlogged
   * second door beside it.
   */
  it("never hands over a reported person's email address", async () => {
    const report = await reportOn("USER", yuki.id);

    const response = await request(app)
      .get(`/admin/reports/${report.id}`)
      .set("Cookie", mo.cookie);

    expect(JSON.stringify(response.body)).not.toContain(yuki.email);
  });

  /**
   * Named fields, and the exact set of them. The point is not the list — it is
   * that adding to it has to be a decision somebody takes on purpose, which is
   * exactly what spreading the row took away.
   */
  it("shows a reported person as the search's shape, without the email", async () => {
    const report = await reportOn("USER", yuki.id);

    const response = await request(app)
      .get(`/admin/reports/${report.id}`)
      .set("Cookie", mo.cookie);
    const target = (response.body as { target: object }).target;

    expect(Object.keys(target).sort()).toEqual([
      "bio",
      "countryCode",
      "createdAt",
      "displayName",
      "emailVerified",
      "id",
      "role",
      "status",
      "suspendedUntil",
    ]);
    expect(target).toMatchObject({
      id: yuki.id,
      displayName: "Yuki",
      bio: null,
      countryCode: "EE",
      role: "USER",
      status: "ACTIVE",
      suspendedUntil: null,
      emailVerified: true,
    });
  });

  /**
   * What a moderator actually needs it for. #81's lesson, in the one place it
   * was never tested: the evidence has to outlive the decision, because a
   * resolved report is reviewed by somebody else later — and `GET /users/:id`
   * answers `404` for a banned account (#65), so this view is the only one
   * left that can show who the report was about.
   */
  it("still shows a person after they have been banned", async () => {
    const report = await reportOn("USER", yuki.id);
    const banned = await act(mo, yuki.id, { type: "BAN", reason: "Scam" });
    expect(banned.status).toBe(201);

    const response = await request(app)
      .get(`/admin/reports/${report.id}`)
      .set("Cookie", mo.cookie);
    const target = (response.body as { target: { status: string } }).target;

    expect(response.status).toBe(200);
    expect(target.status).toBe("BANNED");
  });

  it("shows a person whose profile has gone", async () => {
    const report = await reportOn("USER", yuki.id);
    await prisma.profile.delete({ where: { userId: yuki.id } });

    const response = await request(app)
      .get(`/admin/reports/${report.id}`)
      .set("Cookie", mo.cookie);

    // Half a person, not a 500: a report about an account that has since been
    // taken apart still has to be closable, which is the same reason a missing
    // target is `null` rather than an error.
    expect(response.status).toBe(200);
    expect((response.body as { target: object }).target).toMatchObject({
      id: yuki.id,
      displayName: null,
      countryCode: null,
    });
  });

  it("copes with a person whose account row has gone", async () => {
    const report = await reportOn("USER", yuki.id);
    await prisma.user.delete({ where: { id: yuki.id } });

    const response = await request(app)
      .get(`/admin/reports/${report.id}`)
      .set("Cookie", mo.cookie);

    // `Report.targetId` is a plain column with no foreign key behind it (#26),
    // so a report can outlive the thing it points at. The same `null` as a
    // deleted need, for the same reason: the queue must not jam on a row
    // nobody can close.
    expect(response.status).toBe(200);
    expect((response.body as { target: unknown }).target).toBeNull();
  });

  /**
   * The other three targets are still whole rows, and that is a choice rather
   * than the rest of the bug: a moderator judging a need wants everything
   * about it, and `Need`, `Help` and `Message` hold no secrets today. The risk
   * is tomorrow's column.
   *
   * So the shapes are pinned — every key at every depth of the reply. A column
   * added to any of these tables fails this test instead of quietly arriving
   * in a moderator's response, and whoever adds it decides then whether it
   * belongs here. That is the tripwire #95 did not have.
   */
  it("pins every key a need, an offer and a message target contains", async () => {
    const { message } = await conversation();
    const need = await makeNeed();
    const help = await makeHelp();

    async function keysOf(
      targetType: string,
      targetId: string,
      reporter?: TestUser,
    ) {
      const report = await reportOn(targetType, targetId, reporter);
      const response = await request(app)
        .get(`/admin/reports/${report.id}`)
        .set("Cookie", mo.cookie);
      expect(response.status).toBe(200);

      return keysWithin((response.body as { target: unknown }).target);
    }

    expect(await keysOf("NEED", need.id)).toEqual([
      "buyCountry",
      "categoryId",
      "createdAt",
      "currency",
      "deliverCountry",
      "description",
      "estimatedPrice",
      "expiresAt",
      "id",
      "photos",
      "productUrl",
      "prohibitedAckAt",
      "prohibitedVersion",
      "requesterId",
      "status",
      "storeName",
      "thankYouAmount",
      "title",
      "updatedAt",
    ]);

    expect(await keysOf("HELP", help.id)).toEqual([
      "country",
      "createdAt",
      "description",
      "helperId",
      "id",
      "prohibitedAckAt",
      "prohibitedVersion",
      "shipsTo",
      "status",
      "updatedAt",
    ]);

    // A message brings its conversation, its proposal and the need behind it,
    // so a line can be read in context. Three more rows, three more tables
    // that can gain a column.
    expect(await keysOf("MESSAGE", message.id, kadri)).toEqual([
      "body",
      "buyCountry",
      "categoryId",
      "conversation",
      "conversationId",
      "createdAt",
      "currency",
      "deliverCountry",
      "description",
      "estimatedPrice",
      "expiresAt",
      "helpId",
      "helperId",
      "helperLastReadAt",
      "id",
      "initiatedBy",
      "lastMessageAt",
      "message",
      "need",
      "needId",
      "productUrl",
      "prohibitedAckAt",
      "prohibitedVersion",
      "proposal",
      "proposalId",
      "removedAt",
      "requesterId",
      "requesterLastReadAt",
      "respondedAt",
      "senderId",
      "status",
      "storeName",
      "thankYouAmount",
      "title",
      "updatedAt",
    ]);
  });
});

describe("a moderator needs a reason to read a conversation", () => {
  async function reportAMessage(messageId: string) {
    await request(app).post("/reports").set("Cookie", kadri.cookie).send({
      targetType: "MESSAGE",
      targetId: messageId,
      reason: "HARASSMENT",
    });

    return prisma.report.findFirstOrThrow();
  }

  it("refuses one with no report and no dispute", async () => {
    const { thread } = await conversation();

    const response = await readThread(mo, thread.id);

    // #21 let any moderator read any thread, because there were no reports to
    // attach. docs/07-trust-and-safety.md always said otherwise.
    expect(response.status).toBe(404);
  });

  it("opens it when a message in it has been reported", async () => {
    const { thread, message } = await conversation();
    await reportAMessage(message.id);

    const response = await readThread(mo, thread.id);

    expect(response.status).toBe(200);
    expect(
      (response.body as { items: unknown[] }).items.length,
    ).toBeGreaterThan(0);
  });

  it("opens it when the deal is in dispute", async () => {
    const { thread, proposal } = await conversation();
    await request(app)
      .post(`/proposals/${proposal.id}/accept`)
      .set("Cookie", kadri.cookie)
      .send({});
    const deal = await prisma.deal.findFirstOrThrow();
    await prisma.deal.update({
      where: { id: deal.id },
      data: { status: "DISPUTED" },
    });

    const response = await readThread(mo, thread.id);

    // Judging a dispute means reading what was said (docs/07).
    expect(response.status).toBe(200);
  });

  it("closes again once the report is resolved", async () => {
    const { thread, message } = await conversation();
    const report = await reportAMessage(message.id);
    const opened = await readThread(mo, thread.id);
    const resolved = await request(app)
      .post(`/admin/reports/${report.id}/resolve`)
      .set("Cookie", mo.cookie)
      .send({ outcome: "RESOLVED", resolutionNote: "Warned them" });

    // It has to have been open first, or "closes again" means nothing.
    expect(opened.status).toBe(200);
    expect(resolved.status).toBe(200);
    const response = await readThread(mo, thread.id);

    // The reason to look has ended, so the permission ends with it.
    expect(response.status).toBe(404);
  });

  it("writes down that the moderator looked", async () => {
    const { thread, message } = await conversation();
    const report = await reportAMessage(message.id);
    const written = vi.spyOn(logger, "info");

    await readThread(mo, thread.id);
    const calls = written.mock.calls.filter(
      (call) => typeof call[1] === "string" && call[1].includes("moderator"),
    );
    written.mockRestore();

    // "Enforced in the service layer and logged" — the second half is the one
    // that makes the first half checkable afterwards.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toMatchObject({
      moderatorId: mo.id,
      conversationId: thread.id,
      reportId: report.id,
    });
  });

  it("still lets the two of them read their own thread, silently", async () => {
    const { thread } = await conversation();
    const written = vi.spyOn(logger, "info");

    const response = await readThread(kadri, thread.id);
    const calls = written.mock.calls.filter(
      (call) => typeof call[1] === "string" && call[1].includes("moderator"),
    );
    written.mockRestore();

    expect(response.status).toBe(200);
    // Nobody is auditing people for reading their own messages.
    expect(calls).toHaveLength(0);
  });
});
