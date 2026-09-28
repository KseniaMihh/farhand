import type { Need } from "@prisma/client";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/app.js";
import { prisma } from "../../src/db.js";
import { signUpVerifiedAndLogIn } from "../helpers/auth.js";
import type { TestUser } from "../helpers/auth.js";
import { createCategory } from "../helpers/needs.js";
import { breakInsideTransaction } from "../helpers/transactions.js";

/**
 * Accepting a proposal — issue #20.
 *
 * Five writes that are one decision: accept this proposal, decline the others,
 * match the need, create the deal, log the first event. docs/11-risks.md calls
 * this the hardest part of the project, and the reason is the third describe
 * block below: a half-finished accept leaves a state nothing can read.
 *
 *   npm run test:watch -- accept
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
      thankYouAmount: 500,
      status: "OPEN",
      ...overrides,
    },
  });
}

/** A need with a proposal from each helper, Yuki's first. */
async function needWithTwoProposals() {
  const need = await makeNeed();
  for (const helper of [yuki, marek]) {
    await request(app)
      .post(`/needs/${need.id}/proposals`)
      .set("Cookie", helper.cookie)
      .send({});
  }
  const proposals = await prisma.proposal.findMany({
    orderBy: { createdAt: "asc" },
  });
  const [yukis, mareks] = proposals;
  if (!yukis || !mareks) throw new Error("setup failed");

  return { need, yukis, mareks };
}

function accept(user: TestUser, proposalId: string) {
  return request(app)
    .post(`/proposals/${proposalId}/accept`)
    .set("Cookie", user.cookie)
    .send({});
}

interface DealBody {
  deal: {
    id: string;
    proposalId: string;
    needId: string;
    requesterId: string;
    helperId: string;
    status: string;
    currency: string;
    thankYouAmount: number;
    productAmount: number | null;
    shippingEstimate: number | null;
    proposal: { id: string; status: string };
    events: { fromStatus: string | null; toStatus: string; actorId: string }[];
  };
}

describe("POST /proposals/:id/accept — the five writes", () => {
  it("creates the deal, with the money copied off the need", async () => {
    const { need, yukis } = await needWithTwoProposals();

    const response = await accept(kadri, yukis.id);
    const body = response.body as DealBody;

    expect(response.status).toBe(201);
    expect(body.deal.proposalId).toBe(yukis.id);
    expect(body.deal.needId).toBe(need.id);
    expect(body.deal.requesterId).toBe(kadri.id);
    expect(body.deal.helperId).toBe(yuki.id);
    expect(body.deal.status).toBe("MATCHED");
    // Copied at creation, so editing the need later cannot move an agreed deal
    // (docs/04-deal-lifecycle.md).
    expect(body.deal.currency).toBe("EUR");
    expect(body.deal.thankYouAmount).toBe(500);
    // Nothing has been quoted yet.
    expect(body.deal.productAmount).toBeNull();
    expect(body.deal.shippingEstimate).toBeNull();
  });

  it("accepts this proposal and declines the others", async () => {
    const { yukis, mareks } = await needWithTwoProposals();

    await accept(kadri, yukis.id);

    const accepted = await prisma.proposal.findUniqueOrThrow({
      where: { id: yukis.id },
    });
    const declined = await prisma.proposal.findUniqueOrThrow({
      where: { id: mareks.id },
    });
    expect(accepted.status).toBe("ACCEPTED");
    expect(accepted.respondedAt).not.toBeNull();
    expect(declined.status).toBe("DECLINED");
    expect(declined.respondedAt).not.toBeNull();
  });

  it("leaves an already withdrawn proposal alone", async () => {
    const { yukis, mareks } = await needWithTwoProposals();
    await request(app)
      .post(`/proposals/${mareks.id}/withdraw`)
      .set("Cookie", marek.cookie)
      .send({});

    const response = await accept(kadri, yukis.id);

    expect(response.status).toBe(201);
    const marekRow = await prisma.proposal.findUniqueOrThrow({
      where: { id: mareks.id },
    });
    // Declining the rest means the ones still waiting, not rewriting history.
    expect(marekRow.status).toBe("WITHDRAWN");
  });

  it("matches the need, so nobody else can propose on it", async () => {
    const { need, yukis } = await needWithTwoProposals();

    await accept(kadri, yukis.id);

    const after = await prisma.need.findUniqueOrThrow({
      where: { id: need.id },
    });
    // MATCHED, not CLOSED: closing is what taking your own need down does.
    expect(after.status).toBe("MATCHED");

    const latecomer = await signUpVerifiedAndLogIn(app, "ida@example.com", "I");
    const tooLate = await request(app)
      .post(`/needs/${need.id}/proposals`)
      .set("Cookie", latecomer.cookie)
      .send({});
    expect(tooLate.status).toBe(409);
  });

  it("answers with what the database holds, not a copy of it", async () => {
    const { yukis, mareks } = await needWithTwoProposals();

    const response = await accept(kadri, yukis.id);
    const returned = (response.body as DealBody).deal.proposal as Record<
      string,
      unknown
    >;
    const stored = await prisma.proposal.findUniqueOrThrow({
      where: { id: yukis.id },
    });
    const declined = await prisma.proposal.findUniqueOrThrow({
      where: { id: mareks.id },
    });

    expect(returned.status).toBe("ACCEPTED");
    // An answer assembled by hand drifts: a respondedAt a few milliseconds off
    // the one that was written, an updatedAt from before the accept, and the
    // need that was joined on the way in riding along uninvited.
    expect(returned.respondedAt).toBe(stored.respondedAt?.toISOString());
    expect(returned.updatedAt).toBe(stored.updatedAt.toISOString());
    expect(returned.need).toBeUndefined();
    // Accepted and declined at one instant, because it was one decision.
    expect(declined.respondedAt?.toISOString()).toBe(
      stored.respondedAt?.toISOString(),
    );
  });

  it("logs the first event, from nowhere to MATCHED", async () => {
    const { yukis } = await needWithTwoProposals();

    const response = await accept(kadri, yukis.id);
    const body = response.body as DealBody;

    const events = await prisma.dealEvent.findMany();
    expect(events).toHaveLength(1);
    expect(events[0]?.fromStatus).toBeNull();
    expect(events[0]?.toStatus).toBe("MATCHED");
    // The requester did this, and the log says who.
    expect(events[0]?.actorId).toBe(kadri.id);
    expect(body.deal.events).toHaveLength(1);
  });
});

describe("POST /proposals/:id/accept — who and when", () => {
  it("refuses the helper who sent it", async () => {
    const { yukis } = await needWithTwoProposals();

    const response = await accept(yuki, yukis.id);

    expect(response.status).toBe(403);
    expect(await prisma.deal.count()).toBe(0);
  });

  it("refuses a stranger", async () => {
    const { yukis } = await needWithTwoProposals();
    const ida = await signUpVerifiedAndLogIn(app, "ida@example.com", "Ida");

    const response = await accept(ida, yukis.id);

    expect(response.status).toBe(403);
  });

  it("answers 404 for a proposal that does not exist", async () => {
    const response = await accept(kadri, "no-such-proposal");

    expect(response.status).toBe(404);
  });

  it("refuses a proposal that is no longer pending", async () => {
    const { yukis } = await needWithTwoProposals();
    await request(app)
      .post(`/proposals/${yukis.id}/decline`)
      .set("Cookie", kadri.cookie)
      .send({});

    const response = await accept(kadri, yukis.id);

    expect(response.status).toBe(409);
    expect(await prisma.deal.count()).toBe(0);
  });

  it("refuses the second proposal once one is accepted", async () => {
    const { yukis, mareks } = await needWithTwoProposals();
    await accept(kadri, yukis.id);

    const second = await accept(kadri, mareks.id);

    // Marek's was declined by the first accept, and the need is matched.
    expect(second.status).toBe(409);
    expect(await prisma.deal.count()).toBe(1);
  });

  it("turns away someone not signed in", async () => {
    const { yukis } = await needWithTwoProposals();

    const response = await request(app)
      .post(`/proposals/${yukis.id}/accept`)
      .send({});

    expect(response.status).toBe(401);
  });
});

describe("POST /proposals/:id/accept — all five, or none", () => {
  /**
   * The acceptance criterion in the issue: "a test proving nothing is written
   * when a later step fails". Both tests break a late step and then look for
   * wreckage left by the earlier ones.
   */

  it("writes nothing when the deal is refused", async () => {
    const { need, yukis, mareks } = await needWithTwoProposals();
    // A live deal on this need already, written straight to the database. The
    // partial unique index will refuse the one the accept is about to make —
    // a real failure, in the fourth of the five steps, with nothing mocked.
    await prisma.deal.create({
      data: {
        proposalId: mareks.id,
        needId: need.id,
        requesterId: kadri.id,
        helperId: marek.id,
        status: "MATCHED",
        currency: "EUR",
      },
    });

    const response = await accept(kadri, yukis.id);

    expect(response.status).toBe(409);
    // The three writes before it must be gone. Without a transaction they are
    // still there, and this is where that shows.
    expect(
      (await prisma.proposal.findUniqueOrThrow({ where: { id: yukis.id } }))
        .status,
    ).toBe("PENDING");
    expect(
      (await prisma.need.findUniqueOrThrow({ where: { id: need.id } })).status,
    ).toBe("OPEN");
    expect(await prisma.dealEvent.count()).toBe(0);
    expect(await prisma.deal.count()).toBe(1);
  });

  it("writes nothing at all when the last step fails", async () => {
    const { need, yukis, mareks } = await needWithTwoProposals();
    const broken = breakInsideTransaction("dealEvent");

    const response = await accept(kadri, yukis.id);
    vi.restoreAllMocks();

    expect(response.status).toBe(500);
    // Without this, an endpoint that wrote nothing at all would pass the rest
    // of the test: it too leaves no wreckage.
    expect(broken.attempts).toBe(1);
    // Every one of the four earlier writes must have been rolled back.
    expect(await prisma.deal.count()).toBe(0);
    expect(
      (await prisma.proposal.findUniqueOrThrow({ where: { id: yukis.id } }))
        .status,
    ).toBe("PENDING");
    expect(
      (await prisma.proposal.findUniqueOrThrow({ where: { id: mareks.id } }))
        .status,
    ).toBe("PENDING");
    expect(
      (await prisma.need.findUniqueOrThrow({ where: { id: need.id } })).status,
    ).toBe("OPEN");
  });

  it("still works after a failed attempt", async () => {
    const { yukis } = await needWithTwoProposals();
    breakInsideTransaction("dealEvent");
    await accept(kadri, yukis.id);
    vi.restoreAllMocks();

    const second = await accept(kadri, yukis.id);

    // The rollback left the proposal genuinely pending, not merely looking it.
    expect(second.status).toBe(201);
    expect(await prisma.deal.count()).toBe(1);
  });
});

describe("one live deal per need, kept by the database", () => {
  /**
   * The third acceptance criterion. The partial unique index
   * `one_active_deal_per_need` was added in the constraints migration; these
   * tests are what prove it is doing its job.
   */
  async function acceptedDeal() {
    const { need, yukis, mareks } = await needWithTwoProposals();
    await accept(kadri, yukis.id);
    return { need, yukis, mareks };
  }

  it("refuses a second live deal on the same need", async () => {
    const { need, mareks } = await acceptedDeal();

    const second = prisma.deal.create({
      data: {
        proposalId: mareks.id,
        needId: need.id,
        requesterId: kadri.id,
        helperId: marek.id,
        status: "MATCHED",
        currency: "EUR",
      },
    });

    // Written straight to the database, going round every check in the
    // service: the index is the last line of defence and it holds.
    await expect(second).rejects.toMatchObject({ code: "P2002" });
  });

  it("allows a new deal once the old one is cancelled", async () => {
    const { need, mareks } = await acceptedDeal();
    await prisma.deal.updateMany({ data: { status: "CANCELLED" } });

    const second = await prisma.deal.create({
      data: {
        proposalId: mareks.id,
        needId: need.id,
        requesterId: kadri.id,
        helperId: marek.id,
        status: "MATCHED",
        currency: "EUR",
      },
    });

    // The index is partial — it only counts deals that are not cancelled —
    // and this is the half of it that a plain unique index would get wrong.
    expect(second.id).toBeTruthy();
    expect(await prisma.deal.count()).toBe(2);
  });

  it("answers 409 rather than crashing when the index refuses", async () => {
    const { need, yukis, mareks } = await needWithTwoProposals();
    await accept(kadri, yukis.id);
    // Stage the race: make the guards see a world where accepting Marek is
    // still allowed. Two accepts arriving together see exactly this, and from
    // here only the index can refuse.
    vi.spyOn(prisma.proposal, "findUnique").mockResolvedValueOnce({
      ...mareks,
      status: "PENDING",
      need: { ...need, status: "OPEN" },
    } as never);

    const response = await accept(kadri, mareks.id);
    vi.restoreAllMocks();

    expect(response.status).toBe(409);
    expect(await prisma.deal.count()).toBe(1);
  });
});
