import type { Need, Help } from "@prisma/client";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/app.js";
import { prisma } from "../../src/db.js";
import { signUpAndLogIn, signUpVerifiedAndLogIn } from "../helpers/auth.js";
import type { TestUser } from "../helpers/auth.js";
import { createCategory } from "../helpers/needs.js";

/**
 * Proposals: send, decline, withdraw — issue #19.
 *
 * These tests are the specification. They fail until the TODOs in
 * src/services/proposals.ts are filled in.
 *
 *   npm run test:watch -- proposals
 *
 * The cast is: Kadri wants something (the requester), Yuki lives where it is
 * sold (the helper) — docs/03-user-journeys.md.
 */
const app = createApp();

let categoryId = "";
let kadri: TestUser;
let yuki: TestUser;

beforeEach(async () => {
  categoryId = (await createCategory()).id;
  kadri = await signUpVerifiedAndLogIn(app, "kadri@example.com", "Kadri");
  yuki = await signUpVerifiedAndLogIn(app, "yuki@example.com", "Yuki");
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

async function makeHelp(overrides: Partial<Help> = {}) {
  return prisma.help.create({
    data: {
      helperId: yuki.id,
      country: "JP",
      shipsTo: ["EE"],
      description: "I post to the Baltics every other week.",
      status: "ACTIVE",
      ...overrides,
      categories: { connect: [{ id: categoryId }] },
    },
  });
}

interface ProposalBody {
  proposal: {
    id: string;
    needId: string;
    helperId: string;
    helpId: string | null;
    initiatedBy: string;
    status: string;
    message: string | null;
    respondedAt: string | null;
  };
}

function propose(user: TestUser, needId: string, body: object = {}) {
  return request(app)
    .post(`/needs/${needId}/proposals`)
    .set("Cookie", user.cookie)
    .send(body);
}

function approach(user: TestUser, helpId: string, body: object) {
  return request(app)
    .post(`/helps/${helpId}/proposals`)
    .set("Cookie", user.cookie)
    .send(body);
}

function act(user: TestUser, proposalId: string, what: "decline" | "withdraw") {
  return request(app)
    .post(`/proposals/${proposalId}/${what}`)
    .set("Cookie", user.cookie)
    .send({});
}

describe("POST /needs/:id/proposals — a helper answers a need", () => {
  it("records the proposal as started by the helper", async () => {
    const need = await makeNeed();

    const response = await propose(yuki, need.id, { message: "I can get it." });
    const body = response.body as ProposalBody;

    expect(response.status).toBe(201);
    expect(body.proposal.helperId).toBe(yuki.id);
    expect(body.proposal.initiatedBy).toBe("HELPER");
    expect(body.proposal.status).toBe("PENDING");
    expect(body.proposal.message).toBe("I can get it.");
    expect(body.proposal.helpId).toBeNull();
  });

  it("allows a proposal with no message", async () => {
    const need = await makeNeed();

    const response = await propose(yuki, need.id);

    expect(response.status).toBe(201);
    expect((response.body as ProposalBody).proposal.message).toBeNull();
  });

  it("refuses your own need", async () => {
    const need = await makeNeed();

    const response = await propose(kadri, need.id, {});

    // The first rule in the issue: you cannot offer to shop for yourself.
    expect(response.status).toBe(403);
    expect(await prisma.proposal.count()).toBe(0);
  });

  it("refuses a second proposal from the same helper", async () => {
    const need = await makeNeed();
    await propose(yuki, need.id, {});

    const second = await propose(yuki, need.id, { message: "Still here!" });

    expect(second.status).toBe(409);
    expect(await prisma.proposal.count()).toBe(1);
  });

  it("leaves the duplicate to the database, not to a look-first check", async () => {
    const need = await makeNeed();
    await propose(yuki, need.id, {});
    // Two requests arriving together both see "no proposal yet". A look-first
    // check would let the second one through; only the unique constraint can
    // actually decide, which is what the issue asks for. Staging the stale
    // read is the only way to tell the two apart from outside.
    const staleFirst = vi
      .spyOn(prisma.proposal, "findFirst")
      .mockResolvedValueOnce(null);
    const staleUnique = vi
      .spyOn(prisma.proposal, "findUnique")
      .mockResolvedValueOnce(null);

    const second = await propose(yuki, need.id, {});
    staleFirst.mockRestore();
    staleUnique.mockRestore();

    expect(second.status).toBe(409);
    expect(await prisma.proposal.count()).toBe(1);
  });

  it("lets a different helper propose on the same need", async () => {
    const need = await makeNeed();
    const marek = await signUpVerifiedAndLogIn(app, "marek@example.com", "M");
    await propose(yuki, need.id, {});

    const response = await propose(marek, need.id, {});

    expect(response.status).toBe(201);
    expect(await prisma.proposal.count()).toBe(2);
  });

  it("refuses a need that is already matched", async () => {
    const need = await makeNeed({ status: "MATCHED" });

    const response = await propose(yuki, need.id, {});

    // Readable, but spoken for.
    expect(response.status).toBe(409);
  });

  it("hides a draft need, as if it did not exist", async () => {
    const need = await makeNeed({ status: "DRAFT" });

    const response = await propose(yuki, need.id, {});

    expect(response.status).toBe(404);
  });

  it("answers 404 for a need that never existed", async () => {
    const response = await propose(yuki, "no-such-need", {});

    expect(response.status).toBe(404);
  });

  it("turns away someone not logged in, unverified, or suspended", async () => {
    const need = await makeNeed();
    const unverified = await signUpAndLogIn(app, "new@example.com");
    await prisma.user.update({
      where: { id: yuki.id },
      data: { status: "SUSPENDED" },
    });

    expect(
      (await request(app).post(`/needs/${need.id}/proposals`).send({})).status,
    ).toBe(401);
    expect((await propose(unverified, need.id, {})).status).toBe(403);
    expect((await propose(yuki, need.id, {})).status).toBe(403);
  });
});

describe("POST /helps/:id/proposals — a requester approaches a helper", () => {
  it("records the proposal as started by the requester", async () => {
    const need = await makeNeed();
    const help = await makeHelp();

    const response = await approach(kadri, help.id, {
      needId: need.id,
      message: "Would you get this?",
    });
    const body = response.body as ProposalBody;

    expect(response.status).toBe(201);
    expect(body.proposal.initiatedBy).toBe("REQUESTER");
    // The caller is the requester, so the helper is the offer's owner.
    expect(body.proposal.helperId).toBe(yuki.id);
    expect(body.proposal.needId).toBe(need.id);
    expect(body.proposal.helpId).toBe(help.id);
    expect(body.proposal.status).toBe("PENDING");
  });

  it("refuses to introduce someone else's need", async () => {
    const help = await makeHelp();
    const marek = await signUpVerifiedAndLogIn(app, "marek@example.com", "M");
    const need = await makeNeed(); // Kadri's

    const response = await approach(marek, help.id, { needId: need.id });

    expect(response.status).toBe(403);
    expect(await prisma.proposal.count()).toBe(0);
  });

  it("refuses your own offer", async () => {
    const help = await makeHelp(); // Yuki's
    const yukisNeed = await makeNeed({ requesterId: yuki.id });

    const response = await approach(yuki, help.id, { needId: yukisNeed.id });

    // The same mistake as proposing on your own need, seen from the other side.
    expect(response.status).toBe(403);
  });

  it("refuses a need that is not open", async () => {
    const help = await makeHelp();
    const need = await makeNeed({ status: "CLOSED" });

    const response = await approach(kadri, help.id, { needId: need.id });

    expect(response.status).toBe(409);
  });

  it("hides a paused offer, as if it did not exist", async () => {
    const help = await makeHelp({ status: "PAUSED" });
    const need = await makeNeed();

    const response = await approach(kadri, help.id, { needId: need.id });

    expect(response.status).toBe(404);
  });

  it("refuses when those two are already talking about that need", async () => {
    const need = await makeNeed();
    const help = await makeHelp();
    await propose(yuki, need.id, {});

    const response = await approach(kadri, help.id, { needId: need.id });

    // One proposal per helper per need, whichever side starts it.
    expect(response.status).toBe(409);
    expect(await prisma.proposal.count()).toBe(1);
  });

  it("requires a needId", async () => {
    const help = await makeHelp();

    const response = await approach(kadri, help.id, {});

    expect(response.status).toBe(422);
  });
});

describe("POST /proposals/:id/decline", () => {
  async function pendingProposal() {
    const need = await makeNeed();
    await propose(yuki, need.id, {});
    return prisma.proposal.findFirstOrThrow();
  }

  it("lets the requester decline, and records when", async () => {
    const proposal = await pendingProposal();

    const response = await act(kadri, proposal.id, "decline");
    const body = response.body as ProposalBody;

    expect(response.status).toBe(200);
    expect(body.proposal.status).toBe("DECLINED");
    expect(body.proposal.respondedAt).not.toBeNull();
  });

  it("refuses the helper who sent it", async () => {
    const proposal = await pendingProposal();

    const response = await act(yuki, proposal.id, "decline");

    expect(response.status).toBe(403);
  });

  it("refuses a stranger", async () => {
    const proposal = await pendingProposal();
    const marek = await signUpVerifiedAndLogIn(app, "marek@example.com", "M");

    const response = await act(marek, proposal.id, "decline");

    expect(response.status).toBe(403);
  });

  it("refuses a proposal that is no longer pending", async () => {
    const proposal = await pendingProposal();
    await act(kadri, proposal.id, "decline");

    const again = await act(kadri, proposal.id, "decline");

    expect(again.status).toBe(409);
  });

  it("answers 404 for a proposal that does not exist", async () => {
    const response = await act(kadri, "no-such-proposal", "decline");

    expect(response.status).toBe(404);
  });
});

describe("POST /proposals/:id/withdraw", () => {
  async function pendingProposal() {
    const need = await makeNeed();
    await propose(yuki, need.id, {});
    return prisma.proposal.findFirstOrThrow();
  }

  it("lets the helper withdraw, and records when", async () => {
    const proposal = await pendingProposal();

    const response = await act(yuki, proposal.id, "withdraw");
    const body = response.body as ProposalBody;

    expect(response.status).toBe(200);
    expect(body.proposal.status).toBe("WITHDRAWN");
    expect(body.proposal.respondedAt).not.toBeNull();
  });

  it("refuses the requester", async () => {
    const proposal = await pendingProposal();

    const response = await act(kadri, proposal.id, "withdraw");

    // Declining is the requester's word for it, and it is a different verb.
    expect(response.status).toBe(403);
  });

  it("refuses a proposal already declined", async () => {
    const proposal = await pendingProposal();
    await act(kadri, proposal.id, "decline");

    const response = await act(yuki, proposal.id, "withdraw");

    expect(response.status).toBe(409);
  });

  it("does not free the slot: withdrawing is not undo", async () => {
    const proposal = await pendingProposal();
    await act(yuki, proposal.id, "withdraw");

    const again = await propose(yuki, proposal.needId, { message: "Sorry!" });

    // The unique constraint is on (needId, helperId) and takes no notice of
    // status, so the withdrawn row keeps the slot for good. That follows from
    // "one proposal per helper per need" — see docs/06-api-contract.md. If this
    // test ever fails, someone has changed that rule and the contract with it.
    expect(again.status).toBe(409);
    expect(await prisma.proposal.count()).toBe(1);
  });
});

describe("GET /me/proposals", () => {
  it("shows what I have sent and what I have received", async () => {
    const need = await makeNeed();
    await propose(yuki, need.id, {});

    const asHelper = await request(app)
      .get("/me/proposals")
      .set("Cookie", yuki.cookie);
    const asRequester = await request(app)
      .get("/me/proposals")
      .set("Cookie", kadri.cookie);

    expect((asHelper.body as { items: unknown[] }).items).toHaveLength(1);
    expect((asRequester.body as { items: unknown[] }).items).toHaveLength(1);
  });

  it("shows nothing of other people's proposals", async () => {
    const need = await makeNeed();
    await propose(yuki, need.id, {});
    const marek = await signUpVerifiedAndLogIn(app, "marek@example.com", "M");

    const response = await request(app)
      .get("/me/proposals")
      .set("Cookie", marek.cookie);

    expect((response.body as { items: unknown[] }).items).toHaveLength(0);
  });

  it("pages, keeping both sides in one list", async () => {
    // A proposal that is none of Kadri's business, made first so that it is
    // the oldest: if the cursor ever escapes the "mine" filter, this is the row
    // that turns up on her last page.
    const anna = await signUpVerifiedAndLogIn(app, "anna@example.com", "Anna");
    const annasNeed = await makeNeed({
      requesterId: anna.id,
      title: "Not Kadri's",
    });
    await propose(yuki, annasNeed.id, {});

    for (let i = 0; i < 3; i++) {
      const need = await makeNeed({ title: `Need ${String(i)}` });
      const helper = await signUpVerifiedAndLogIn(
        app,
        `helper${String(i)}@example.com`,
        "H",
      );
      await propose(helper, need.id, {});
    }

    const first = await request(app)
      .get("/me/proposals")
      .query({ limit: 2 })
      .set("Cookie", kadri.cookie);
    const firstBody = first.body as {
      items: { id: string }[];
      nextCursor: string | null;
    };
    const second = await request(app)
      .get("/me/proposals")
      .query({ limit: 2, cursor: firstBody.nextCursor ?? "" })
      .set("Cookie", kadri.cookie);
    const secondBody = second.body as { items: { id: string }[] };

    expect(firstBody.items).toHaveLength(2);
    expect(firstBody.nextCursor).toBeTruthy();
    expect(secondBody.items).toHaveLength(1);
    const firstIds = firstBody.items.map((item) => item.id);
    expect(secondBody.items.some((item) => firstIds.includes(item.id))).toBe(
      false,
    );
  });

  it("requires being logged in", async () => {
    const response = await request(app).get("/me/proposals");

    expect(response.status).toBe(401);
  });
});
