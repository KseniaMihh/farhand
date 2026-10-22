import type { AdminAction, Need, User } from "@prisma/client";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/app.js";
import { prisma } from "../../src/db.js";
import { mailer } from "../../src/mailer.js";
import {
  PASSWORD,
  signUpAndLogIn,
  signUpVerifiedAndLogIn,
} from "../helpers/auth.js";
import type { TestUser } from "../helpers/auth.js";
import { runQueuedJobs } from "../helpers/jobs.js";
import { createCategory, createDealFor, needBody } from "../helpers/needs.js";

/**
 * Erasing a banned account — issue #88.
 *
 * These tests are the specification. They fail until the TODOs in
 * src/services/erasure.ts are filled in.
 *
 *   npm run test:watch -- erasure
 *
 * The hole, recorded in docs/11-risks.md since #66: `DELETE /me` needs a
 * session and a ban stops sign-in, so the people most likely to want erasure
 * are the ones who cannot ask for it.
 *
 * THE TEST THAT MATTERS MOST IS THE LAST ONE, and it is not about moderators
 * at all: it runs both paths — somebody deleting their own account, and a
 * moderator erasing one — and compares what they leave behind. A second
 * deletion that differs by one forgotten line is how a receipt gets destroyed
 * or an email survives, and that failure would be invisible to every other
 * test in this file.
 */
const app = createApp();

let categoryId = "";
let mo: TestUser;
let yuki: TestUser;

beforeEach(async () => {
  categoryId = (await createCategory()).id;
  mo = await signUpVerifiedAndLogIn(app, "mo@example.com", "Mo");
  await prisma.user.update({
    where: { id: mo.id },
    data: { role: "MODERATOR" },
  });
  yuki = await signUpVerifiedAndLogIn(app, "yuki@example.com", "Yuki");
  await prisma.job.deleteMany({});
  await prisma.notification.deleteMany({});
});

/** Banned, which is the state that cannot ask for anything. */
async function ban(user: TestUser): Promise<void> {
  await prisma.user.update({
    where: { id: user.id },
    data: { status: "BANNED" },
  });
}

function erase(by: TestUser, targetId: string, body: object = {}) {
  return request(app)
    .delete(`/admin/users/${targetId}`)
    .set("Cookie", by.cookie)
    .send({ reason: "Erasure requested by email", ...body });
}

async function actions(): Promise<AdminAction[]> {
  return prisma.adminAction.findMany({ orderBy: { createdAt: "asc" } });
}

function userRow(id: string): Promise<User> {
  return prisma.user.findUniqueOrThrow({ where: { id } });
}

describe("a moderator erasing a banned account", () => {
  it("anonymises it, and answers 204", async () => {
    await ban(yuki);

    const response = await erase(mo, yuki.id);

    expect(response.status).toBe(204);
    const row = await userRow(yuki.id);
    expect(row).toMatchObject({ status: "DELETED" });
    expect(row.email).toBe(`deleted-${yuki.id}@farhand.invalid`);
    expect(row.deletedAt).toBeInstanceOf(Date);
    const profile = await prisma.profile.findUniqueOrThrow({
      where: { userId: yuki.id },
    });
    expect(profile).toMatchObject({
      displayName: "Deleted account",
      bio: null,
      city: null,
    });
    // The country stays, as it does in #66: on its own it identifies nobody
    // and it keeps a deal's history readable.
    expect(profile.countryCode).not.toBeNull();
  });

  it("records the decision in the audit log, with the reason", async () => {
    await ban(yuki);

    await erase(mo, yuki.id, { reason: "Asked by email on 18 October" });

    // Unlike reading a file, this IS a decision, so #27's log has to carry it
    // — and it is the only record left, because the row it points at no
    // longer says who it was.
    const [action] = await actions();
    expect(action).toMatchObject({
      type: "ERASE_ACCOUNT",
      adminId: mo.id,
      targetUserId: yuki.id,
      reason: "Asked by email on 18 October",
    });
  });

  it("refuses without a reason, and erases nothing", async () => {
    await ban(yuki);

    const response = await request(app)
      .delete(`/admin/users/${yuki.id}`)
      .set("Cookie", mo.cookie)
      .send({});

    expect(response.status).toBe(422);
    expect((await userRow(yuki.id)).status).toBe("BANNED");
    expect(await actions()).toHaveLength(0);
  });

  it("kills every session and token the account had", async () => {
    // A banned account cannot sign in, but it may still hold a session from
    // before the ban, and `requireAuth` reads the session before the status.
    await prisma.session.deleteMany({ where: { userId: yuki.id } });
    await prisma.session.create({
      data: {
        userId: yuki.id,
        tokenHash: "a".repeat(64),
        expiresAt: new Date(Date.now() + 1e7),
        ipAddress: "127.0.0.1",
      },
    });
    await ban(yuki);

    await erase(mo, yuki.id);

    expect(await prisma.session.count({ where: { userId: yuki.id } })).toBe(0);
    expect(
      await prisma.verificationToken.count({ where: { userId: yuki.id } }),
    ).toBe(0);
  });

  it("asks for nothing twice: a second request is still 204", async () => {
    await ban(yuki);
    await erase(mo, yuki.id);

    const again = await erase(mo, yuki.id);

    // The caller asked for a state, and that is the state — like
    // `DELETE /me/avatar` when there is no avatar.
    expect(again.status).toBe(204);
    // And no second audit row: nothing happened the second time, and an audit
    // log that records non-events is one nobody can read.
    expect(await actions()).toHaveLength(1);
  });
});

describe("who it may be used on", () => {
  it("refuses an account that is not banned, and says what to use instead", async () => {
    const response = await erase(mo, yuki.id);

    // The power is deliberately exactly as big as the hole: somebody who can
    // sign in can erase themselves with `DELETE /me`, and a moderator who can
    // erase anybody is a bigger thing than this issue asked for.
    expect(response.status).toBe(409);
    expect((await userRow(yuki.id)).status).toBe("ACTIVE");
    expect(await actions()).toHaveLength(0);
  });

  it("refuses a suspended account, which can still ask for itself", async () => {
    await prisma.user.update({
      where: { id: yuki.id },
      data: { status: "SUSPENDED", suspendedUntil: new Date(Date.now() + 1e7) },
    });

    // `DELETE /me` is marked SESSION precisely so that an account in a bad
    // state can still close itself (#66).
    expect((await erase(mo, yuki.id)).status).toBe(409);
  });

  it("refuses another moderator, and refuses the moderator themselves", async () => {
    const other = await signUpVerifiedAndLogIn(app, "ott@example.com", "Ott");
    await prisma.user.update({
      where: { id: other.id },
      data: { role: "MODERATOR", status: "BANNED" },
    });

    // Nobody moderates upwards or sideways, and nobody moderates themselves —
    // the rule `actOnUser` already applies, and for a stronger reason: a ban
    // can be lifted and this cannot.
    //
    // The moderator is NOT banned here, which matters: banning them would
    // make their own session the thing that refuses the request (401), and
    // the test would pass while proving nothing about rank. And the rank
    // check runs before the banned-only check, so erasing yourself is a 403
    // rather than a 409 — "you may not" before "that account cannot be".
    expect((await erase(mo, other.id)).status).toBe(403);
    expect((await erase(mo, mo.id)).status).toBe(403);
    expect(await actions()).toHaveLength(0);
  });

  it("is not for regular users, or for strangers", async () => {
    const nell = await signUpVerifiedAndLogIn(app, "nell@example.com", "Nell");
    await ban(yuki);

    expect((await erase(nell, yuki.id)).status).toBe(403);
    expect(
      (
        await request(app)
          .delete(`/admin/users/${yuki.id}`)
          .send({ reason: "let me in" })
      ).status,
    ).toBe(401);
    expect((await userRow(yuki.id)).status).toBe("BANNED");
  });

  it("refuses a moderator who has not confirmed their address", async () => {
    const fresh = await signUpAndLogIn(app, "new-mo@example.com", "New Mo");
    await prisma.user.update({
      where: { id: fresh.id },
      data: { role: "MODERATOR" },
    });
    await ban(yuki);

    expect((await erase(fresh, yuki.id)).status).toBe(403);
    expect((await userRow(yuki.id)).status).toBe("BANNED");
  });

  it("refuses a suspended moderator", async () => {
    await prisma.user.update({
      where: { id: mo.id },
      data: { status: "SUSPENDED", suspendedUntil: new Date(Date.now() + 1e7) },
    });
    await ban(yuki);

    // These two exist because a variant run found the guards on the route to
    // be invisible: with `requireVerified`, `requireActive` and
    // `requireRole` all deleted, every test in this file still passed. The
    // contract's marker test noticed — it compares the documented `MOD`
    // against the guards actually in front of the route — but nothing here
    // did, because the service's own rank rule happens to refuse a regular
    // user for a different reason. A rule held only by a document comparison
    // is a rule nobody has watched work.
    expect((await erase(mo, yuki.id)).status).toBe(403);
    expect((await userRow(yuki.id)).status).toBe("BANNED");
  });

  it("answers 404 for an account that never existed", async () => {
    expect((await erase(mo, "no-such-user-id")).status).toBe(404);
  });
});

describe("a deal still running", () => {
  async function aNeedAndDeal(status: "PRODUCT_PAID" | "COMPLETED") {
    const created = await request(app)
      .post("/needs")
      .set("Cookie", mo.cookie)
      .send(await needBody(categoryId));
    const need = (created.body as { need: Need }).need;
    await createDealFor(need, yuki.id, status);

    return need;
  }

  it("refuses the erasure, and names how many are in the way", async () => {
    await aNeedAndDeal("PRODUCT_PAID");
    await ban(yuki);

    const response = await erase(mo, yuki.id);

    // The same refusal as #66, for the same reason: there is somebody on the
    // other side who is owed either the thing or their money, and erasing one
    // of the two people in a live deal leaves them with neither.
    expect(response.status).toBe(409);
    const body = response.body as { error: { message: string } };
    expect(body.error.message).toMatch(/1 deal/);
    // And it names the remedy a MODERATOR has, which is not the one the
    // account's owner has: they cannot settle somebody else's deal, only
    // freeze it and end it (#134).
    expect(body.error.message).toMatch(/frozen and then ended/);
    expect((await userRow(yuki.id)).status).toBe("BANNED");
    expect(await actions()).toHaveLength(0);
  });

  it("allows it once the deal is over", async () => {
    await aNeedAndDeal("COMPLETED");
    await ban(yuki);

    expect((await erase(mo, yuki.id)).status).toBe(204);
  });

  /**
   * THE DEADLOCK, AND THE WAY OUT — #134.
   *
   * The deal here is between two people who are not the moderator, and both
   * of them are banned, so there is nobody in it who could settle it. Before
   * #134 this account could never be erased: the refusal above was correct
   * and permanent, which is what `docs/11-risks.md` recorded.
   *
   * It runs the whole way through on purpose. Each half passes on its own
   * against the wrong implementation — a moderator who can cancel anything
   * passes the erasure, and an erasure that ignores live deals passes the
   * transitions — and only together do they say that the obligation can
   * actually be met.
   */
  it("can be cleared by the moderator alone, and then erased", async () => {
    const kadri = await signUpVerifiedAndLogIn(
      app,
      "kadri@example.com",
      "Kadri",
    );
    const created = await request(app)
      .post("/needs")
      .set("Cookie", kadri.cookie)
      .send(await needBody(categoryId));
    const need = (created.body as { need: Need }).need;
    const { id: dealId } = await createDealFor(need, yuki.id, "PRODUCT_PAID");

    await ban(yuki);
    await ban(kadri);

    // Nobody in the deal can act, and the erasure says so.
    expect((await erase(mo, yuki.id)).status).toBe(409);

    const transition = (to: string, note: string) =>
      request(app)
        .post(`/deals/${dealId}/transition`)
        .set("Cookie", mo.cookie)
        .send({ to, note });

    // Money has moved, so it is two steps: freeze, look, end.
    expect((await transition("DISPUTED", "Both accounts banned.")).status).toBe(
      200,
    );
    expect(
      (await transition("CANCELLED", "Ended: nobody left to settle it."))
        .status,
    ).toBe(200);

    expect((await erase(mo, yuki.id)).status).toBe(204);
    expect((await userRow(yuki.id)).status).toBe("DELETED");
  });
});

describe("what is kept, and what goes", () => {
  it("keeps the receipts, because they are somebody else's evidence", async () => {
    const created = await request(app)
      .post("/needs")
      .set("Cookie", mo.cookie)
      .send(await needBody(categoryId));
    const need = (created.body as { need: Need }).need;
    const deal = await createDealFor(need, yuki.id, "COMPLETED");
    const receipt = await prisma.file.create({
      data: {
        ownerId: yuki.id,
        purpose: "PRODUCT_RECEIPT",
        storageKey: `receipts/${deal.id}-kept`,
        mimeType: "image/webp",
        sizeBytes: 1234,
        dealId: deal.id,
      },
    });
    await ban(yuki);

    await erase(mo, yuki.id);

    // #66 and decision 0016: a receipt is evidence in somebody else's
    // dispute rather than a possession of whoever uploaded it.
    expect(
      await prisma.file.findUnique({ where: { id: receipt.id } }),
    ).not.toBeNull();
  });

  it("closes the listings so nobody can act on them", async () => {
    const created = await request(app)
      .post("/needs")
      .set("Cookie", yuki.cookie)
      .send(await needBody(categoryId));
    const need = (created.body as { need: Need }).need;
    await ban(yuki);

    await erase(mo, yuki.id);

    expect(
      (await prisma.need.findUniqueOrThrow({ where: { id: need.id } })).status,
    ).toBe("CLOSED");
  });

  it("sends no email about it", async () => {
    const sent = vi.spyOn(mailer, "sendNotificationEmail").mockResolvedValue();
    await ban(yuki);

    await erase(mo, yuki.id);
    await runQueuedJobs();

    // There is nowhere to send it: the address is anonymised in the same
    // transaction. #86's moderation-decision email is for decisions somebody
    // can act on, and this one was asked for.
    expect(sent).not.toHaveBeenCalled();
  });
});

/**
 * What this last test does and does not hold, learned from the variant run.
 *
 * It catches DIVERGENCE: give `DELETE /me` its own copy of the anonymisation
 * again and it fails first and loudest, which is exactly the failure the
 * issue's second criterion is about.
 *
 * It does NOT catch a mistake the two paths SHARE. Delete the line that
 * anonymises the email and both halves are equally wrong, so the comparison
 * still passes — it is the tests above, and #66's own, that notice. That is
 * the right division of labour, and worth saying out loud so nobody reads
 * this one test as covering the whole of erasure.
 */
describe("the two paths cannot drift apart", () => {
  it("leaves exactly what DELETE /me leaves", async () => {
    // Two accounts in the same shape, one closing itself and one erased by a
    // moderator. THIS is the test the issue's second criterion asks for: not
    // "does erasure work" but "is it the same erasure".
    const selfClosing = await signUpVerifiedAndLogIn(
      app,
      "anna@example.com",
      "Anna",
    );
    const erased = await signUpVerifiedAndLogIn(app, "bea@example.com", "Bea");

    for (const person of [selfClosing, erased]) {
      const created = await request(app)
        .post("/needs")
        .set("Cookie", person.cookie)
        .send(await needBody(categoryId, { title: `Need for ${person.id}` }));
      expect(created.status).toBe(201);
      await prisma.help.create({
        data: {
          helperId: person.id,
          country: "JP",
          shipsTo: ["EE"],
          description: "I can buy things in Tokyo",
          status: "ACTIVE",
          prohibitedVersion: "x".repeat(16),
          prohibitedAckAt: new Date(),
        },
      });
      await prisma.session.create({
        data: {
          userId: person.id,
          tokenHash: `${person.id}-session`.padEnd(64, "0").slice(0, 64),
          expiresAt: new Date(Date.now() + 1e7),
          ipAddress: "127.0.0.1",
        },
      });
    }

    await request(app)
      .delete("/me")
      .set("Cookie", selfClosing.cookie)
      .send({ password: PASSWORD });

    await prisma.user.update({
      where: { id: erased.id },
      data: { status: "BANNED" },
    });
    expect((await erase(mo, erased.id)).status).toBe(204);

    /** Everything about an account that erasure is supposed to change. */
    async function shapeOf(userId: string) {
      const user = await userRow(userId);
      const profile = await prisma.profile.findUniqueOrThrow({
        where: { userId },
      });

      return {
        status: user.status,
        emailIsAnonymised: user.email === `deleted-${userId}@farhand.invalid`,
        emailVerifiedAt: user.emailVerifiedAt !== null,
        deletedAt: user.deletedAt !== null,
        displayName: profile.displayName,
        bio: profile.bio,
        city: profile.city,
        // The value, not whether it is there: the column cannot be null, and
        // both fixtures start as "EE", so a path that blanked the country
        // would show up here as a difference.
        countryCode: profile.countryCode,
        avatarFileId: profile.avatarFileId,
        sessions: await prisma.session.count({ where: { userId } }),
        tokens: await prisma.verificationToken.count({ where: { userId } }),
        openNeeds: await prisma.need.count({
          where: { requesterId: userId, status: { in: ["DRAFT", "OPEN"] } },
        }),
        liveHelps: await prisma.help.count({
          where: { helperId: userId, status: { in: ["ACTIVE", "PAUSED"] } },
        }),
        pendingProposals: await prisma.proposal.count({
          where: { helperId: userId, status: "PENDING" },
        }),
      };
    }

    expect(await shapeOf(erased.id)).toEqual(await shapeOf(selfClosing.id));
  });
});
