import type { DealStatus, Need } from "@prisma/client";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/app.js";
import { prisma } from "../../src/db.js";
import {
  logIn,
  PASSWORD,
  signUpAndLogIn,
  signUpVerifiedAndLogIn,
  type TestUser,
} from "../helpers/auth.js";
import { withoutRequestId } from "../helpers/http.js";
import { createCategory } from "../helpers/needs.js";
import { breakInsideTransaction } from "../helpers/transactions.js";

/**
 * `DELETE /me` — issue #66.
 *
 * These tests are the specification. They fail until the TODOs in
 * src/services/profiles.ts are filled in.
 *
 *   npm run test:watch -- delete-account
 *
 * `AccountStatus.DELETED` has said what this means since the first week:
 * *anonymized, kept for deal history (GDPR)*. The two halves are in tension, and
 * that tension is the whole issue — the person leaving has a right to have their
 * personal data erased, and the person on the other side of a deal has a history
 * that is also theirs, which cannot be rewritten because somebody else left.
 *
 * So most of this file is not about deleting. It is about what must survive.
 */
const app = createApp();

interface ErrorBody {
  error: { code: string; message: string };
}

let anna: TestUser = { id: "", email: "", cookie: "" };
let yuki: TestUser = { id: "", email: "", cookie: "" };
let categoryId = "";

beforeEach(async () => {
  categoryId = (await createCategory("electronics")).id;
  anna = await signUpVerifiedAndLogIn(app, "anna@example.com", "Anna");
  yuki = await signUpVerifiedAndLogIn(app, "yuki@example.com", "Yuki");
});

afterEach(() => {
  vi.restoreAllMocks();
});

function deleteAccount(user: TestUser, body: object = { password: PASSWORD }) {
  return request(app).delete("/me").set("Cookie", user.cookie).send(body);
}

/** A need of Anna's, in whatever state the test needs. */
async function makeNeed(
  status: "DRAFT" | "OPEN" | "MATCHED" | "CLOSED" = "OPEN",
  requesterId = anna.id,
): Promise<Need> {
  return prisma.need.create({
    data: {
      requesterId,
      categoryId,
      title: "Japanese sunscreen",
      description: "The one not sold in Europe",
      buyCountry: "JP",
      deliverCountry: "EE",
      currency: "EUR",
      estimatedPrice: 2400,
      status,
    },
  });
}

/** A deal between Anna (requester) and Yuki (helper), at a chosen status. */
async function makeDeal(status: DealStatus) {
  const need = await makeNeed("MATCHED");
  const proposal = await prisma.proposal.create({
    data: {
      needId: need.id,
      helperId: yuki.id,
      initiatedBy: "HELPER",
      status: "ACCEPTED",
    },
  });

  return prisma.deal.create({
    data: {
      proposalId: proposal.id,
      needId: need.id,
      requesterId: anna.id,
      helperId: yuki.id,
      status,
      currency: "EUR",
    },
  });
}

const account = () => prisma.user.findUniqueOrThrow({ where: { id: anna.id } });
const profile = () => prisma.profile.findUnique({ where: { userId: anna.id } });

describe("DELETE /me", () => {
  describe("proving it is really you", () => {
    it("refuses a request with no session", async () => {
      const response = await request(app)
        .delete("/me")
        .send({ password: PASSWORD });

      expect(response.status).toBe(401);
      expect((await account()).status).toBe("ACTIVE");
    });

    it.each([
      ["no password at all", {}],
      ["a password too short to have been set", { password: "short" }],
      ["a password that is not a string", { password: 12345678 }],
    ])("refuses %s with 422", async (_name, body) => {
      const response = await deleteAccount(anna, body);

      expect(response.status).toBe(422);
      expect((await account()).status).toBe("ACTIVE");
    });

    /**
     * 403 and not 401: we know exactly who is asking. They are signed in — they
     * have simply not proved it a second time, which is what this endpoint asks
     * for because it is the one write that cannot be undone.
     */
    it("refuses the wrong password, and changes nothing", async () => {
      const response = await deleteAccount(anna, {
        password: "not the right passphrase",
      });

      expect(response.status).toBe(403);
      const after = await account();
      expect(after.status).toBe("ACTIVE");
      expect(after.email).toBe("anna@example.com");
      expect(after.deletedAt).toBeNull();
    });

    /**
     * The order of the two refusals is observable, and it is this way round on
     * purpose: prove who you are first, and only then hear anything about the
     * state of the account. A caller holding a stolen cookie and no password
     * should not be told how many deals are running before being turned away.
     */
    it("refuses a wrong password before mentioning open deals", async () => {
      await makeDeal("SHIPPED");

      const response = await deleteAccount(anna, { password: "wrong one" });

      expect(response.status).toBe(403);
      expect((await account()).status).toBe("ACTIVE");
    });

    it("accepts the right password", async () => {
      const response = await deleteAccount(anna);

      expect(response.status).toBe(204);
      expect(response.body).toEqual({});
    });

    /**
     * SESSION, not AUTH. An unverified account is still somebody's personal
     * data, and the person who signed up and never confirmed their address is
     * exactly the one most likely to want it gone.
     */
    it("lets an unverified account leave", async () => {
      const unverified = await signUpAndLogIn(app, "new@example.com");

      const response = await request(app)
        .delete("/me")
        .set("Cookie", unverified.cookie)
        .send({ password: PASSWORD });

      expect(response.status).toBe(204);
    });

    /** A suspension stops you acting. Leaving is not acting. */
    it("lets a suspended account leave", async () => {
      await prisma.user.update({
        where: { id: anna.id },
        data: { status: "SUSPENDED", suspendedUntil: null },
      });

      const response = await deleteAccount(anna);

      expect(response.status).toBe(204);
      expect((await account()).status).toBe("DELETED");
    });
  });

  describe("what is erased", () => {
    beforeEach(async () => {
      await prisma.profile.update({
        where: { userId: anna.id },
        data: {
          bio: "I fly Tallinn–Tokyo twice a year",
          city: "Tallinn",
          avatarUrl: "https://example.com/a.png",
        },
      });
    });

    it("marks the account deleted, with the time it happened", async () => {
      const before = new Date();

      await deleteAccount(anna);

      const after = await account();
      expect(after.status).toBe("DELETED");
      expect(after.deletedAt).not.toBeNull();
      expect(after.deletedAt?.getTime()).toBeGreaterThanOrEqual(
        before.getTime() - 1000,
      );
    });

    /**
     * `.invalid` is reserved by RFC 2606 and can never be a real domain, so the
     * replacement can never collide with a living account or be mistaken for a
     * way to reach anybody. The id keeps it unique, because `email` is a unique
     * column and two deletions must not fight over one value.
     */
    it("replaces the email with an address that cannot exist", async () => {
      await deleteAccount(anna);

      const after = await account();
      expect(after.email).not.toContain("anna@example.com");
      expect(after.email).toContain(anna.id);
      expect(after.email.endsWith("@farhand.invalid")).toBe(true);
    });

    it("replaces the password so the old one cannot work", async () => {
      const was = (await account()).passwordHash;

      await deleteAccount(anna);

      expect((await account()).passwordHash).not.toBe(was);
    });

    it("blanks the profile but keeps the row", async () => {
      await deleteAccount(anna);

      const after = await profile();
      expect(after).not.toBeNull();
      expect(after?.displayName).not.toBe("Anna");
      expect(after?.bio).toBeNull();
      expect(after?.city).toBeNull();
      expect(after?.avatarUrl).toBeNull();
    });

    /** On its own a country identifies nobody, and the history stays readable. */
    it("keeps the country", async () => {
      await deleteAccount(anna);

      expect((await profile())?.countryCode).toBe("EE");
    });

    it("ends every session, on every device", async () => {
      const otherDevice = await logIn(app, "anna@example.com");

      await deleteAccount(anna);

      expect(await prisma.session.count({ where: { userId: anna.id } })).toBe(
        0,
      );
      const response = await request(app)
        .get("/auth/me")
        .set("Cookie", otherDevice.cookie);
      expect(response.status).toBe(401);
    });

    /** A link already sitting in an inbox must not act on the account after. */
    it("destroys every verification and reset token", async () => {
      await request(app)
        .post("/auth/forgot-password")
        .send({ email: "anna@example.com" });
      expect(
        await prisma.verificationToken.count({ where: { userId: anna.id } }),
      ).toBeGreaterThan(0);

      await deleteAccount(anna);

      expect(
        await prisma.verificationToken.count({ where: { userId: anna.id } }),
      ).toBe(0);
    });
  });

  describe("afterwards, the account cannot be used", () => {
    it("cannot sign in, and looks exactly like an address nobody has", async () => {
      await deleteAccount(anna);

      const deleted = await request(app)
        .post("/auth/login")
        .send({ email: "anna@example.com", password: PASSWORD });
      const unknown = await request(app)
        .post("/auth/login")
        .send({ email: "nobody@example.com", password: PASSWORD });

      expect(deleted.status).toBe(unknown.status);
      expect(withoutRequestId(deleted.body)).toEqual(
        withoutRequestId(unknown.body),
      );
    });

    /**
     * "Not 200" is not enough here, and that weakness hid a real bug: if the
     * replacement password is not a value argon2 can read, verifying against it
     * throws, and login answers 500 where an unknown address answers 401. The
     * difference is an oracle — it tells anyone who can guess the replacement
     * address that the account was deleted rather than never existing, which is
     * the exact thing this endpoint's ordering works to hide.
     */
    it("answers the replacement address exactly as it answers a stranger", async () => {
      await deleteAccount(anna);
      const after = await account();

      const deleted = await request(app)
        .post("/auth/login")
        .send({ email: after.email, password: PASSWORD });
      const unknown = await request(app)
        .post("/auth/login")
        .send({ email: "nobody@example.com", password: PASSWORD });

      expect(deleted.status).toBe(401);
      expect(deleted.status).toBe(unknown.status);
      expect(withoutRequestId(deleted.body)).toEqual(
        withoutRequestId(unknown.body),
      );
    });

    it("has no public profile, exactly like an id that never existed", async () => {
      await deleteAccount(anna);

      const gone = await request(app).get(`/users/${anna.id}`);
      const never = await request(app).get("/users/cm0000000000000000000000");

      expect(gone.status).toBe(404);
      expect(withoutRequestId(gone.body)).toEqual(withoutRequestId(never.body));
    });

    /** That is what the status filter on the moderator search is for (#67). */
    it("is still findable by a moderator", async () => {
      const mo = await signUpVerifiedAndLogIn(app, "mo@example.com", "Mo");
      await prisma.user.update({
        where: { id: mo.id },
        data: { role: "MODERATOR" },
      });

      await deleteAccount(anna);

      const response = await request(app)
        .get("/admin/users?status=DELETED")
        .set("Cookie", mo.cookie);
      const body = response.body as { items: { id: string }[] };

      expect(body.items.map((u) => u.id)).toContain(anna.id);
    });
  });

  describe("their listings are taken down", () => {
    it.each([
      ["DRAFT", "CLOSED"],
      ["OPEN", "CLOSED"],
    ] as const)("turns a %s need into %s", async (from, to) => {
      const need = await makeNeed(from);

      await deleteAccount(anna);

      const after = await prisma.need.findUniqueOrThrow({
        where: { id: need.id },
      });
      expect(after.status).toBe(to);
    });

    it("leaves other people's needs alone", async () => {
      const theirs = await makeNeed("OPEN", yuki.id);

      await deleteAccount(anna);

      expect(
        (await prisma.need.findUniqueOrThrow({ where: { id: theirs.id } }))
          .status,
      ).toBe("OPEN");
    });

    it.each(["ACTIVE", "PAUSED"] as const)(
      "removes a %s help offer",
      async (status) => {
        const help = await prisma.help.create({
          data: {
            helperId: anna.id,
            country: "JP",
            shipsTo: ["EE"],
            description: "Flying Tallinn–Tokyo twice a year",
            status,
          },
        });

        await deleteAccount(anna);

        expect(
          (await prisma.help.findUniqueOrThrow({ where: { id: help.id } }))
            .status,
        ).toBe("REMOVED");
      },
    );

    it("withdraws proposals they had sent", async () => {
      const theirNeed = await makeNeed("OPEN", yuki.id);
      const proposal = await prisma.proposal.create({
        data: {
          needId: theirNeed.id,
          helperId: anna.id,
          initiatedBy: "HELPER",
          status: "PENDING",
        },
      });

      await deleteAccount(anna);

      expect(
        (
          await prisma.proposal.findUniqueOrThrow({
            where: { id: proposal.id },
          })
        ).status,
      ).toBe("WITHDRAWN");
    });

    /**
     * The one that is easy to miss. Left pending, a requester could accept a
     * proposal from somebody who can no longer sign in, and create a deal that
     * could never move.
     */
    it("declines proposals that were waiting on their needs", async () => {
      const mine = await makeNeed("OPEN");
      const proposal = await prisma.proposal.create({
        data: {
          needId: mine.id,
          helperId: yuki.id,
          initiatedBy: "HELPER",
          status: "PENDING",
        },
      });

      await deleteAccount(anna);

      expect(
        (
          await prisma.proposal.findUniqueOrThrow({
            where: { id: proposal.id },
          })
        ).status,
      ).toBe("DECLINED");
    });

    /**
     * Withdrawing reaches PENDING proposals and stops there. An accepted
     * proposal is not a loose end — it is the record of how a deal came to
     * exist, and rewriting it would make the deal's own history disagree with
     * itself.
     *
     * It has to be the helper who leaves: the proposal is theirs, so deleting
     * anybody else proves nothing about whether it was left alone. Getting that
     * wrong is exactly what let a broken version through the first time.
     */
    it("leaves the helper's accepted proposal alone when they leave", async () => {
      const deal = await makeDeal("COMPLETED");

      await deleteAccount(yuki);

      expect(
        (
          await prisma.proposal.findUniqueOrThrow({
            where: { id: deal.proposalId },
          })
        ).status,
      ).toBe("ACCEPTED");
    });

    /** The same on the other side: declining stops at PENDING too. */
    it("leaves an accepted proposal on their own need alone", async () => {
      const deal = await makeDeal("COMPLETED");

      await deleteAccount(anna);

      expect(
        (
          await prisma.proposal.findUniqueOrThrow({
            where: { id: deal.proposalId },
          })
        ).status,
      ).toBe("ACCEPTED");
    });
  });

  describe("what survives, because it is not only theirs", () => {
    it("keeps the deal, and its history, and who did what", async () => {
      const deal = await makeDeal("COMPLETED");
      await prisma.dealEvent.create({
        data: { dealId: deal.id, toStatus: "MATCHED", actorId: anna.id },
      });

      await deleteAccount(anna);

      const after = await prisma.deal.findUniqueOrThrow({
        where: { id: deal.id },
      });
      expect(after.status).toBe("COMPLETED");
      expect(after.requesterId).toBe(anna.id);

      const events = await request(app)
        .get(`/deals/${deal.id}/events`)
        .set("Cookie", yuki.cookie);
      const body = events.body as {
        items: { actor: { displayName: string } | null }[];
      };
      const names = body.items.map((e) => e.actor?.displayName);

      // Not "Unknown": the other side should be able to see that the person
      // they dealt with is gone, rather than that we cannot say who acted.
      expect(names).toContain("Deleted account");
    });

    it("keeps their messages, so the other side keeps the conversation", async () => {
      const need = await makeNeed("MATCHED");
      const proposal = await prisma.proposal.create({
        data: {
          needId: need.id,
          helperId: yuki.id,
          initiatedBy: "HELPER",
          status: "ACCEPTED",
        },
      });
      const conversation = await prisma.conversation.create({
        data: { proposalId: proposal.id },
      });
      const message = await prisma.message.create({
        data: {
          conversationId: conversation.id,
          senderId: anna.id,
          body: "Is the 100 ml size available?",
        },
      });

      await deleteAccount(anna);

      const after = await prisma.message.findUniqueOrThrow({
        where: { id: message.id },
      });
      expect(after.body).toBe("Is the 100 ml size available?");
      expect(after.senderId).toBe(anna.id);
    });

    it("keeps reports filed about them, so moderation still works", async () => {
      const report = await prisma.report.create({
        data: {
          reporterId: yuki.id,
          targetType: "USER",
          targetId: anna.id,
          reason: "SCAM",
        },
      });

      await deleteAccount(anna);

      expect(
        await prisma.report.findUnique({ where: { id: report.id } }),
      ).not.toBeNull();
    });
  });

  describe("not while a deal is running", () => {
    const RUNNING: DealStatus[] = [
      "MATCHED",
      "QUOTE_AGREED",
      "PRODUCT_PAID",
      "PURCHASED",
      "SHIPPED",
      "DELIVERED",
      "DISPUTED",
    ];

    it.each(RUNNING)("refuses while a deal is %s", async (status) => {
      await makeDeal(status);

      const response = await deleteAccount(anna);

      expect(response.status).toBe(409);
      expect((response.body as ErrorBody).error.code).toBe("CONFLICT");
      expect((await account()).status).toBe("ACTIVE");
    });

    it.each(["COMPLETED", "CANCELLED"] as const)(
      "allows it when the only deal is %s",
      async (status) => {
        await makeDeal(status);

        const response = await deleteAccount(anna);

        expect(response.status).toBe(204);
      },
    );

    /** A person who cannot see what is blocking them cannot clear it. */
    it("says how many deals are in the way", async () => {
      await makeDeal("MATCHED");
      await makeDeal("SHIPPED");

      const response = await deleteAccount(anna);

      expect((response.body as ErrorBody).error.message).toContain("2");
    });

    it("refuses the helper's side of a running deal too", async () => {
      await makeDeal("PURCHASED");

      const response = await deleteAccount(yuki);

      expect(response.status).toBe(409);
      expect(
        (await prisma.user.findUniqueOrThrow({ where: { id: yuki.id } }))
          .status,
      ).toBe("ACTIVE");
    });

    it("ignores somebody else's running deal", async () => {
      const bystander = await signUpVerifiedAndLogIn(app, "bo@example.com");
      await makeDeal("SHIPPED");

      const response = await deleteAccount(bystander);

      expect(response.status).toBe(204);
    });
  });

  /**
   * Half a deletion is worse than none: an account anonymised with its listings
   * still open, or sessions still alive, is a state nobody designed. The write
   * has to be one transaction, and this is how that is checked from outside —
   * an implementation writing row by row leaves the earlier ones behind.
   */
  describe("all of it, or none of it", () => {
    it("changes nothing if a write inside the transaction fails", async () => {
      const need = await makeNeed("OPEN");
      breakInsideTransaction("profile", "update");

      const response = await deleteAccount(anna);

      expect(response.status).toBeGreaterThanOrEqual(500);
      const after = await account();
      expect(after.status).toBe("ACTIVE");
      expect(after.email).toBe("anna@example.com");
      expect(
        (await prisma.need.findUniqueOrThrow({ where: { id: need.id } }))
          .status,
      ).toBe("OPEN");
      expect(
        await prisma.session.count({ where: { userId: anna.id } }),
      ).toBeGreaterThan(0);
    });
  });
});
