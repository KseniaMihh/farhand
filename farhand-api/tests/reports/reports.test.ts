import type { Need, ReportTarget } from "@prisma/client";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/app.js";
import { prisma } from "../../src/db.js";
import { signUpVerifiedAndLogIn } from "../helpers/auth.js";
import type { TestUser } from "../helpers/auth.js";
import { createCategory } from "../helpers/needs.js";

/**
 * Reports: submit and queue — issue #26.
 *
 * These tests are the specification. They fail until the TODOs in
 * src/services/reports.ts are filled in.
 *
 *   npm run test:watch -- reports
 *
 * Kadri and Yuki are the two people in a conversation, Marek is a stranger,
 * and Mo is a moderator reading the queue.
 */
const app = createApp();

let categoryId = "";
let kadri: TestUser;
let yuki: TestUser;
let marek: TestUser;

beforeEach(async () => {
  categoryId = (await createCategory()).id;
  kadri = await signUpVerifiedAndLogIn(app, "kadri@example.com", "Kadri");
  yuki = await signUpVerifiedAndLogIn(app, "yuki@example.com", "Yuki");
  marek = await signUpVerifiedAndLogIn(app, "marek@example.com", "Marek");
});

async function makeModerator() {
  const mo = await signUpVerifiedAndLogIn(app, "mo@example.com", "Mo");
  await prisma.user.update({
    where: { id: mo.id },
    data: { role: "MODERATOR" },
  });
  return mo;
}

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

async function makeHelp(helperId: string, status: "ACTIVE" | "PAUSED") {
  return prisma.help.create({
    data: {
      helperId,
      country: "JP",
      shipsTo: ["EE"],
      description: "I post to the Baltics every other week.",
      status,
      categories: { connect: [{ id: categoryId }] },
    },
  });
}

/** A message between Kadri and Yuki, which only they can see. */
async function makeMessage(senderIsHelper = true) {
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
    .set("Cookie", senderIsHelper ? yuki.cookie : kadri.cookie)
    .send({ body: "Is this the right one?" });

  return prisma.message.findFirstOrThrow();
}

function report(
  user: TestUser,
  targetType: ReportTarget,
  targetId: string,
  overrides: object = {},
) {
  return request(app)
    .post("/reports")
    .set("Cookie", user.cookie)
    .send({ targetType, targetId, reason: "SPAM", ...overrides });
}

function queue(user: TestUser, query: object = {}) {
  return request(app)
    .get("/admin/reports")
    .query(query)
    .set("Cookie", user.cookie);
}

interface ReportBody {
  report: {
    id: string;
    reporterId: string;
    targetType: string;
    targetId: string;
    reason: string;
    details: string | null;
    status: string;
    resolvedAt: string | null;
  };
}

interface QueuePage {
  items: { id: string; targetType: string; status: string; reason: string }[];
  nextCursor: string | null;
}

describe("POST /reports — the target has to be real", () => {
  it("records a report about a need", async () => {
    const need = await makeNeed();

    const response = await report(marek, "NEED", need.id, {
      reason: "PROHIBITED_ITEM",
      details: "This is a medicine, which the rules do not allow",
    });
    const body = response.body as ReportBody;

    expect(response.status).toBe(201);
    expect(body.report.reporterId).toBe(marek.id);
    expect(body.report.targetType).toBe("NEED");
    expect(body.report.targetId).toBe(need.id);
    expect(body.report.reason).toBe("PROHIBITED_ITEM");
    // The words the reporter chose, kept as they wrote them: a moderator
    // reading this later has the reason and the explanation, not just a label.
    expect(body.report.details).toBe(
      "This is a medicine, which the rules do not allow",
    );
    expect(body.report.status).toBe("OPEN");
    expect(body.report.resolvedAt).toBeNull();
  });

  it("accepts a report with no details", async () => {
    const need = await makeNeed();

    const response = await report(marek, "NEED", need.id);

    // The reason carries the meaning. Demanding a paragraph first is a way of
    // getting fewer reports about the things that matter.
    expect(response.status).toBe(201);
    expect((response.body as ReportBody).report.details).toBeNull();
  });

  it("takes reports about users, offers and messages too", async () => {
    const help = await makeHelp(yuki.id, "ACTIVE");
    const message = await makeMessage();

    expect((await report(marek, "USER", yuki.id)).status).toBe(201);
    expect((await report(marek, "HELP", help.id)).status).toBe(201);
    expect((await report(kadri, "MESSAGE", message.id)).status).toBe(201);
  });

  it("refuses an id that is not anything", async () => {
    // There is no foreign key on a polymorphic target, so the database would
    // happily store this. Only the service stands between the queue and a
    // report about the string "banana".
    expect((await report(marek, "NEED", "banana")).status).toBe(404);
    expect((await report(marek, "USER", "banana")).status).toBe(404);
    expect((await report(marek, "HELP", "banana")).status).toBe(404);
    expect((await report(marek, "MESSAGE", "banana")).status).toBe(404);
    expect(await prisma.report.count()).toBe(0);
  });

  it("refuses an id of the wrong kind of thing", async () => {
    const need = await makeNeed();

    // A real id, but not a real user: the type and the id have to agree.
    const response = await report(marek, "USER", need.id);

    expect(response.status).toBe(404);
  });

  it("refuses a target that is not a kind of thing at all", async () => {
    const need = await makeNeed();

    const response = await request(app)
      .post("/reports")
      .set("Cookie", marek.cookie)
      .send({ targetType: "CONVERSATION", targetId: need.id, reason: "SPAM" });

    expect(response.status).toBe(422);
  });

  it("refuses a reason nobody has heard of", async () => {
    const need = await makeNeed();

    const response = await report(marek, "NEED", need.id, {
      reason: "I_JUST_DO_NOT_LIKE_IT",
    });

    expect(response.status).toBe(422);
  });
});

describe("POST /reports — you can only report what you can see", () => {
  it("hides a draft need from a stranger, as a report target too", async () => {
    const draft = await makeNeed({ status: "DRAFT" });

    const response = await report(marek, "NEED", draft.id);

    // Answering differently for real and invented ids would turn this endpoint
    // into a way of asking whether any given id exists.
    expect(response.status).toBe(404);
  });

  it("hides a paused offer from a stranger", async () => {
    const paused = await makeHelp(yuki.id, "PAUSED");

    const response = await report(marek, "HELP", paused.id);

    expect(response.status).toBe(404);
  });

  it("hides a message from someone not in the conversation", async () => {
    const message = await makeMessage();

    const response = await report(marek, "MESSAGE", message.id);

    expect(response.status).toBe(404);
  });

  it("lets the other person in the conversation report it", async () => {
    const message = await makeMessage(); // sent by Yuki

    const response = await report(kadri, "MESSAGE", message.id, {
      reason: "HARASSMENT",
    });

    expect(response.status).toBe(201);
  });

  it("refuses to let someone report their own things", async () => {
    const need = await makeNeed(); // Kadri's
    const help = await makeHelp(yuki.id, "ACTIVE");
    const message = await makeMessage(); // Yuki's

    // 403 and not 404: they can obviously see it, so pretending it is missing
    // would be silly. Reporting yourself is simply not a thing.
    expect((await report(kadri, "NEED", need.id)).status).toBe(403);
    expect((await report(yuki, "HELP", help.id)).status).toBe(403);
    expect((await report(yuki, "MESSAGE", message.id)).status).toBe(403);
    expect((await report(kadri, "USER", kadri.id)).status).toBe(403);
  });

  it("turns away someone not signed in", async () => {
    const need = await makeNeed();

    const response = await request(app)
      .post("/reports")
      .send({ targetType: "NEED", targetId: need.id, reason: "SPAM" });

    expect(response.status).toBe(401);
  });
});

describe("POST /reports — the same complaint twice", () => {
  it("refuses a second open report of the same thing", async () => {
    const need = await makeNeed();
    await report(marek, "NEED", need.id);

    const again = await report(marek, "NEED", need.id, { reason: "SCAM" });

    expect(again.status).toBe(409);
    expect(await prisma.report.count()).toBe(1);
  });

  it("lets somebody else report the same thing", async () => {
    const need = await makeNeed();
    await report(marek, "NEED", need.id);
    const ida = await signUpVerifiedAndLogIn(app, "ida@example.com", "Ida");

    const response = await report(ida, "NEED", need.id);

    // Two people complaining about one need is information, not a duplicate.
    expect(response.status).toBe(201);
    expect(await prisma.report.count()).toBe(2);
  });

  it("lets the same person report it again once it is resolved", async () => {
    const need = await makeNeed();
    await report(marek, "NEED", need.id);
    await prisma.report.updateMany({
      data: { status: "RESOLVED", resolvedAt: new Date() },
    });

    const response = await report(marek, "NEED", need.id);

    // It happened again, so it is news again. The index only counts open ones.
    expect(response.status).toBe(201);
    expect(await prisma.report.count()).toBe(2);
  });

  it("leaves the duplicate to the database, not to a look-first check", async () => {
    const need = await makeNeed();
    await report(marek, "NEED", need.id);
    // Two taps on a slow connection: both read "nothing yet" before either
    // writes. Only the index can settle it, so the look-first read is staged
    // to say what it would say in that moment.
    const stale = vi
      .spyOn(prisma.report, "findFirst")
      .mockResolvedValueOnce(null);
    const staleUnique = vi
      .spyOn(prisma.report, "findUnique")
      .mockResolvedValueOnce(null);

    const again = await report(marek, "NEED", need.id);
    stale.mockRestore();
    staleUnique.mockRestore();

    expect(again.status).toBe(409);
    expect(await prisma.report.count()).toBe(1);
  });
});

describe("GET /admin/reports — the queue", () => {
  async function fillQueue() {
    const need = await makeNeed();
    const help = await makeHelp(yuki.id, "ACTIVE");
    const ida = await signUpVerifiedAndLogIn(app, "ida@example.com", "Ida");

    await report(marek, "NEED", need.id, { reason: "PROHIBITED_ITEM" });
    await report(ida, "HELP", help.id, { reason: "SCAM" });
    await report(marek, "USER", yuki.id, { reason: "HARASSMENT" });

    return { need, help };
  }

  it("is closed to everybody but moderators", async () => {
    await fillQueue();
    const mo = await makeModerator();

    expect((await queue(marek)).status).toBe(403);
    expect((await request(app).get("/admin/reports")).status).toBe(401);
    expect((await queue(mo)).status).toBe(200);
  });

  it("puts the oldest first, because it is a queue", async () => {
    await fillQueue();
    const mo = await makeModerator();

    const response = await queue(mo);
    const items = (response.body as QueuePage).items;

    // Every other list in the project is newest first. This one is work
    // waiting to be done, and the complaint that has waited longest is the one
    // that matters most (docs/07-trust-and-safety.md).
    expect(items.map((item) => item.reason)).toEqual([
      "PROHIBITED_ITEM",
      "SCAM",
      "HARASSMENT",
    ]);
  });

  it("shows what is open and not what is finished", async () => {
    await fillQueue();
    const mo = await makeModerator();
    const first = await prisma.report.findFirstOrThrow({
      orderBy: { createdAt: "asc" },
    });
    await prisma.report.update({
      where: { id: first.id },
      data: { status: "RESOLVED", resolvedAt: new Date() },
    });

    const open = await queue(mo);
    const resolved = await queue(mo, { status: "RESOLVED" });

    // A moderator opening the queue wants the work, not the archive — so OPEN
    // is the default and looking back is something you ask for.
    expect((open.body as QueuePage).items).toHaveLength(2);
    expect((resolved.body as QueuePage).items).toHaveLength(1);
  });

  it("filters by what was reported and why", async () => {
    await fillQueue();
    const mo = await makeModerator();

    const needs = await queue(mo, { targetType: "NEED" });
    const scams = await queue(mo, { reason: "SCAM" });

    expect((needs.body as QueuePage).items).toHaveLength(1);
    expect((needs.body as QueuePage).items[0]?.targetType).toBe("NEED");
    expect((scams.body as QueuePage).items).toHaveLength(1);
    expect((scams.body as QueuePage).items[0]?.reason).toBe("SCAM");
  });

  it("pages forwards through the queue", async () => {
    await fillQueue();
    const mo = await makeModerator();

    const first = await queue(mo, { limit: 2 });
    const firstBody = first.body as QueuePage;
    const second = await queue(mo, {
      limit: 2,
      cursor: firstBody.nextCursor ?? "",
    });
    const secondBody = second.body as QueuePage;

    expect(firstBody.items.map((item) => item.reason)).toEqual([
      "PROHIBITED_ITEM",
      "SCAM",
    ]);
    expect(firstBody.nextCursor).toBeTruthy();
    // Forwards: the next page is what comes AFTER the cursor in time, which is
    // the opposite direction from every other cursor in the project.
    expect(secondBody.items.map((item) => item.reason)).toEqual(["HARASSMENT"]);
    expect(secondBody.nextCursor).toBeNull();
  });

  it("refuses a filter that is not a real value", async () => {
    const mo = await makeModerator();

    expect((await queue(mo, { status: "PENDING" })).status).toBe(422);
    expect((await queue(mo, { targetType: "DEAL" })).status).toBe(422);
  });
});
