import type { Deal, Need } from "@prisma/client";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { prisma } from "../../src/db.js";
import { EXPORT_TTL_MS } from "../../src/services/exports.js";
import { signUpAndLogIn, signUpVerifiedAndLogIn } from "../helpers/auth.js";
import type { TestUser } from "../helpers/auth.js";
import { runQueuedJobs } from "../helpers/jobs.js";
import { createCategory, needBody } from "../helpers/needs.js";

/**
 * Taking your data with you — issue #89.
 *
 * These tests are the specification. They fail until the TODOs in
 * src/services/exports.ts are filled in.
 *
 *   npm run test:watch -- export
 *
 * docs/07-trust-and-safety.md has promised this since version 1, and it is
 * the other half of #66: erasure answers "forget me", portability answers
 * "give me a copy first".
 *
 * THE TESTS THAT MATTER MOST are in "somebody else is in here too". Everything
 * in this product is two people's data — a conversation, a deal, a review —
 * and an export is a file that can be forwarded. The rest of this file checks
 * that the machinery works; that section checks that it does not leak.
 */
const app = createApp();

let categoryId = "";
let kadri: TestUser;
let yuki: TestUser;

beforeEach(async () => {
  categoryId = (await createCategory()).id;
  kadri = await signUpVerifiedAndLogIn(app, "kadri@example.com", "Kadri");
  yuki = await signUpVerifiedAndLogIn(app, "yuki@example.com", "Yuki");
  await prisma.job.deleteMany({});
});

function ask(user: TestUser) {
  return request(app)
    .post("/me/exports")
    .set("Cookie", user.cookie)
    .set("Origin", "http://localhost:3000")
    .send({});
}

function fetchIt(user: TestUser, id: string) {
  return request(app).get(`/me/exports/${id}`).set("Cookie", user.cookie);
}

/** Asks, runs the worker, and hands back the finished export. */
async function exportFor(user: TestUser): Promise<Record<string, unknown>> {
  const asked = await ask(user);
  expect(asked.status).toBe(202);
  const { id } = asked.body as { id: string };

  await runQueuedJobs();

  const ready = await fetchIt(user, id);
  expect(ready.status).toBe(200);

  return ready.body as Record<string, unknown>;
}

/** Kadri wants something, Yuki offers, they talk, and the deal completes. */
async function aHistory(): Promise<{ need: Need; deal: Deal }> {
  const created = await request(app)
    .post("/needs")
    .set("Cookie", kadri.cookie)
    .send(await needBody(categoryId, { title: "Japanese sunscreen" }));
  const need = (created.body as { need: Need }).need;

  await request(app)
    .post(`/needs/${need.id}/proposals`)
    .set("Cookie", yuki.cookie)
    .send({ message: "I live in Tokyo, happy to help" });
  const proposal = await prisma.proposal.findFirstOrThrow({
    where: { needId: need.id },
  });
  await request(app)
    .post(`/proposals/${proposal.id}/accept`)
    .set("Cookie", kadri.cookie)
    .send({});

  await request(app)
    .post(`/proposals/${proposal.id}/messages`)
    .set("Cookie", kadri.cookie)
    .send({ body: "Could you get two bottles?" });
  await request(app)
    .post(`/proposals/${proposal.id}/messages`)
    .set("Cookie", yuki.cookie)
    .send({ body: "Yes — posting on Friday" });

  const deal = await prisma.deal.findFirstOrThrow({
    where: { proposalId: proposal.id },
  });
  await prisma.deal.update({
    where: { id: deal.id },
    data: { status: "COMPLETED" },
  });
  await prisma.dealEvent.create({
    data: {
      dealId: deal.id,
      actorId: kadri.id,
      fromStatus: "DELIVERED",
      toStatus: "COMPLETED",
    },
  });
  await prisma.review.create({
    data: {
      dealId: deal.id,
      authorId: yuki.id,
      targetId: kadri.id,
      rating: 5,
      comment: "Clear about what was wanted",
    },
  });
  await prisma.job.deleteMany({});

  return { need, deal };
}

describe("asking for an export", () => {
  it("answers at once and leaves the work to the queue", async () => {
    const response = await ask(kadri);

    // 202, not 200: the answer is "asked for", not "here it is" (#85).
    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({ status: "PENDING" });
    const row = await prisma.dataExport.findFirstOrThrow();
    expect(row).toMatchObject({ userId: kadri.id, readyAt: null });
    expect(row.payload).toBeNull();
    expect(await prisma.job.count({ where: { kind: "data-export" } })).toBe(1);
  });

  it("is not ready until the worker has run", async () => {
    const { id } = (await ask(kadri)).body as { id: string };

    const early = await fetchIt(kadri, id);

    // Reading somebody's whole history is a dozen queries, which is why it
    // does not happen inside the request that asks for it.
    expect(early.status).toBe(409);

    await runQueuedJobs();
    expect((await fetchIt(kadri, id)).status).toBe(200);
  });

  it("refuses a second request while the first is being built", async () => {
    await ask(kadri);

    const second = await ask(kadri);

    // Otherwise a loop of requests is a loop of full-history queries nobody
    // asked for.
    expect(second.status).toBe(409);
    expect(await prisma.dataExport.count()).toBe(1);
  });

  it("allows another once the first one is ready", async () => {
    const { id } = (await ask(kadri)).body as { id: string };
    await runQueuedJobs();

    expect((await ask(kadri)).status).toBe(202);
    // And the first is still downloadable: a new request does not invalidate
    // a copy somebody may be in the middle of fetching.
    expect((await fetchIt(kadri, id)).status).toBe(200);
  });

  it("lets a request that was never built be asked for again", async () => {
    const { id } = (await ask(kadri)).body as { id: string };
    // A job that gave up after #85's five attempts leaves a row that will
    // never be ready. Without this, one failure would lock somebody out of
    // their own data for good.
    await prisma.dataExport.update({
      where: { id },
      data: { createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000) },
    });

    expect((await ask(kadri)).status).toBe(202);
  });

  it("is for whoever is signed in, whatever state their account is in", async () => {
    const nell = await signUpAndLogIn(app, "nell@example.com", "Nell");

    // SESSION, like `DELETE /me` (#66): an unverified or suspended account is
    // still entitled to its own data, and the export is handed to a session
    // rather than emailed, so nothing is sent to an address nobody proved.
    expect((await ask(nell)).status).toBe(202);

    await prisma.user.update({
      where: { id: kadri.id },
      data: { status: "SUSPENDED", suspendedUntil: new Date(Date.now() + 1e7) },
    });
    expect((await ask(kadri)).status).toBe(202);
  });

  it("refuses a stranger", async () => {
    expect(
      (
        await request(app)
          .post("/me/exports")
          .set("Origin", "http://localhost:3000")
          .send({})
      ).status,
    ).toBe(401);
  });
});

describe("what is in it", () => {
  it("carries their account, their listings, their deals and their reviews", async () => {
    await aHistory();

    const data = await exportFor(kadri);

    expect(data).toMatchObject({
      account: { email: "kadri@example.com" },
      profile: { displayName: "Kadri" },
    });
    expect(data.needs).toHaveLength(1);
    expect(data.deals).toHaveLength(1);
    // A review somebody else wrote ABOUT them: public text about this person,
    // and they are entitled to a copy.
    expect(data.reviewsReceived).toHaveLength(1);
    expect(data.proposals).toHaveLength(1);
  });

  it("says what it leaves out, and why", async () => {
    const data = await exportFor(kadri);

    // Criterion three, and the part a person would actually read. An export
    // that quietly drops something is worse than one that can be argued with.
    const left = data.notIncluded as Record<string, string>;
    expect(Object.keys(left).length).toBeGreaterThan(0);
    expect(Object.values(left).every((why) => why.length > 20)).toBe(true);
    // The two that matter most: file bytes, and other people.
    expect(JSON.stringify(left)).toMatch(/file|photo|byte/i);
  });

  it("never carries a password hash or a session token", async () => {
    await aHistory();

    const text = JSON.stringify(await exportFor(kadri));

    // The export is the one object in Farhand containing somebody's whole
    // history; it must not also contain the keys to the account.
    expect(text).not.toMatch(/passwordHash/i);
    expect(text).not.toMatch(/\$argon2/);
    expect(text).not.toMatch(/tokenHash/i);
  });

  it("reads as JSON a machine can take somewhere else", async () => {
    const asked = await ask(kadri);
    const { id } = asked.body as { id: string };
    await runQueuedJobs();

    const ready = await fetchIt(kadri, id);

    expect(ready.headers["content-type"]).toMatch(/application\/json/);
    // Named, so a browser saves it rather than painting it on the screen.
    expect(ready.headers["content-disposition"]).toMatch(/attachment/);
    expect(ready.headers["content-disposition"]).toMatch(/farhand-export/);
  });
});

describe("somebody else is in here too", () => {
  it("carries the other side's words, because they were sent to them", async () => {
    await aHistory();

    const data = await exportFor(kadri);

    // A message sent TO you is in your possession the way a received email
    // is, so exporting it discloses nothing new — and it is the only way the
    // export is a usable record of what was agreed (decision 0023).
    const text = JSON.stringify(data);
    expect(text).toContain("Could you get two bottles?");
    expect(text).toContain("Yes — posting on Friday");
  });

  it("never carries the other person's email address", async () => {
    await aHistory();

    const text = JSON.stringify(await exportFor(kadri));

    // The line the whole issue turns on. Kadri may have Yuki's words; Kadri
    // may not have Yuki's address, which a stranger could not see either.
    expect(text).not.toContain("yuki@example.com");
  });

  it("carries only what a stranger could see of the other person", async () => {
    await aHistory();
    await prisma.profile.update({
      where: { userId: yuki.id },
      data: { bio: "Private bio nobody else may export", city: "Tokyo" },
    });

    const text = JSON.stringify(await exportFor(kadri));

    // A display name is public (#65). A bio and a city are on the public
    // profile too — but they belong to Yuki, and an export of Kadri's data is
    // not the place to copy them.
    expect(text).toContain("Yuki");
    expect(text).not.toContain("Private bio nobody else may export");
  });

  it("carries nothing from a conversation they were never in", async () => {
    await aHistory();
    const marek = await signUpVerifiedAndLogIn(app, "marek@example.com", "M");
    const other = await request(app)
      .post("/needs")
      .set("Cookie", marek.cookie)
      .send(await needBody(categoryId, { title: "Somebody else's need" }));
    const need = (other.body as { need: Need }).need;
    await request(app)
      .post(`/needs/${need.id}/proposals`)
      .set("Cookie", yuki.cookie)
      .send({ message: "Nothing to do with Kadri" });
    const theirs = await prisma.proposal.findFirstOrThrow({
      where: { needId: need.id },
    });
    // AND THEY TALK. A variant run caught this: without a real conversation
    // between them, removing the permission filter from the export's
    // conversation query leaked nothing, because there was nothing to leak —
    // the first message is what creates a conversation (services/
    // conversations.ts), so a proposal alone makes none.
    await request(app)
      .post(`/proposals/${theirs.id}/messages`)
      .set("Cookie", yuki.cookie)
      .send({ body: "Strangers talking about strangers" });
    await prisma.job.deleteMany({});

    const text = JSON.stringify(await exportFor(kadri));

    expect(text).not.toContain("Somebody else's need");
    expect(text).not.toContain("Nothing to do with Kadri");
    expect(text).not.toContain("Strangers talking about strangers");
  });

  it("gives a moderator's decision about them, and nobody else's", async () => {
    const mo = await signUpVerifiedAndLogIn(app, "mo@example.com", "Mo");
    await prisma.user.update({
      where: { id: mo.id },
      data: { role: "MODERATOR" },
    });
    await prisma.adminAction.create({
      data: {
        adminId: mo.id,
        targetUserId: kadri.id,
        type: "WARN",
        reason: "Told off for shouting",
      },
    });
    await prisma.adminAction.create({
      data: {
        adminId: mo.id,
        targetUserId: yuki.id,
        type: "WARN",
        reason: "Somebody else's warning",
      },
    });
    await prisma.job.deleteMany({});

    const text = JSON.stringify(await exportFor(kadri));

    // They are entitled to know what was done about them — and the moderator
    // who did it is staff acting in a role, not a third party whose name is
    // theirs to collect.
    expect(text).toContain("Told off for shouting");
    expect(text).not.toContain("Somebody else's warning");
    expect(text).not.toContain("mo@example.com");
  });
});

describe("who may download it", () => {
  it("is nobody but the person it is about", async () => {
    const { id } = (await ask(kadri)).body as { id: string };
    await runQueuedJobs();

    const asYuki = await fetchIt(yuki, id);

    // 404, not 403: an export somebody may not read is one they may not know
    // exists. The ownership is checked on the ROW, not on the path (#79).
    expect(asYuki.status).toBe(404);
  });

  it("is not a moderator's to read", async () => {
    const mo = await signUpVerifiedAndLogIn(app, "mo@example.com", "Mo");
    await prisma.user.update({
      where: { id: mo.id },
      data: { role: "MODERATOR" },
    });
    const { id } = (await ask(kadri)).body as { id: string };
    await runQueuedJobs();

    // Moderators can read a deal, a conversation and a receipt when they have
    // to judge something. Nobody needs to read somebody's whole history.
    expect((await fetchIt(mo, id)).status).toBe(404);
  });

  it("answers 404 for an id that never existed", async () => {
    expect((await fetchIt(kadri, "no-such-export")).status).toBe(404);
  });
});

describe("it does not live forever", () => {
  it("expires, and says so rather than 404ing", async () => {
    const { id } = (await ask(kadri)).body as { id: string };
    await runQueuedJobs();
    await prisma.dataExport.update({
      where: { id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const response = await fetchIt(kadri, id);

    // 410: it was here, it is gone, and asking again is the fix — which a
    // `404` would not say.
    expect(response.status).toBe(410);
  });

  it("is swept, and the row stays as a record that it happened", async () => {
    const { id } = (await ask(kadri)).body as { id: string };
    await runQueuedJobs();
    expect(
      (await prisma.dataExport.findUniqueOrThrow({ where: { id } })).payload,
    ).not.toBeNull();

    const { sweepExpiredExports } =
      await import("../../src/services/exports.js");
    // Seven days and a minute later.
    const swept = await sweepExpiredExports(
      new Date(Date.now() + EXPORT_TTL_MS + 60_000),
    );

    expect(swept).toBe(1);
    const row = await prisma.dataExport.findUniqueOrThrow({ where: { id } });
    // The payload goes; the fact that an export was made, and when, stays —
    // that is itself something somebody may ask about.
    expect(row.payload).toBeNull();
    expect(row.readyAt).not.toBeNull();
  });

  it("leaves an unexpired export alone", async () => {
    await ask(kadri);
    await runQueuedJobs();

    const { sweepExpiredExports } =
      await import("../../src/services/exports.js");
    expect(await sweepExpiredExports(new Date())).toBe(0);
  });
});
