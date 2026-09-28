import type { Deal, DealStatus, Need } from "@prisma/client";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/app.js";
import { prisma } from "../../src/db.js";
import { autoCompleteDeals } from "../../src/services/deals.js";
import { signUpVerifiedAndLogIn } from "../helpers/auth.js";
import type { TestUser } from "../helpers/auth.js";
import { createCategory } from "../helpers/needs.js";
import { breakInsideTransaction } from "../helpers/transactions.js";

/**
 * Cancellation, disputes and auto-completion — issue #25.
 *
 * These tests are the specification. They fail until the TODOs in
 * src/services/deals.ts and src/services/transitions.ts are filled in.
 *
 *   npm run test:watch -- cancellation
 *
 * #24 built the moves. This is what the moves MEAN: a cancelled deal releases
 * the need it came from, a dispute can be resolved back to where it started,
 * and a deal nobody confirms finishes by itself after a fortnight.
 */
const app = createApp();

const DAY = 24 * 60 * 60 * 1000;

let categoryId = "";
let kadri: TestUser;
let yuki: TestUser;

beforeEach(async () => {
  categoryId = (await createCategory()).id;
  kadri = await signUpVerifiedAndLogIn(app, "kadri@example.com", "Kadri");
  yuki = await signUpVerifiedAndLogIn(app, "yuki@example.com", "Yuki");
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

/** A deal in `status`, with the need it came from. */
async function dealAt(
  status: DealStatus,
): Promise<{ deal: Deal; needId: string }> {
  const need = await makeNeed();
  await request(app)
    .post(`/needs/${need.id}/proposals`)
    .set("Cookie", yuki.cookie)
    .send({});
  const proposal = await prisma.proposal.findFirstOrThrow({
    where: { needId: need.id },
  });
  await request(app)
    .post(`/proposals/${proposal.id}/accept`)
    .set("Cookie", kadri.cookie)
    .send({});
  const created = await prisma.deal.findFirstOrThrow({
    where: { proposalId: proposal.id },
  });
  await prisma.quote.create({
    data: {
      dealId: created.id,
      currency: "EUR",
      productAmount: 2400,
      shippingEstimate: 900,
    },
  });

  const deal =
    status === "MATCHED"
      ? created
      : await prisma.deal.update({
          where: { id: created.id },
          data: { status },
        });

  return { deal, needId: need.id };
}

function move(user: TestUser, dealId: string, to: DealStatus, body = {}) {
  return request(app)
    .post(`/deals/${dealId}/transition`)
    .set("Cookie", user.cookie)
    .send({ to, ...body });
}

const REASON = { note: "The shop stopped stocking it" };

describe("cancelling releases the need", () => {
  it("puts the need back on the board", async () => {
    const { deal, needId } = await dealAt("QUOTE_AGREED");

    const response = await move(kadri, deal.id, "CANCELLED", REASON);

    expect(response.status).toBe(200);
    const need = await prisma.need.findUniqueOrThrow({ where: { id: needId } });
    // Nothing was bought — cancelling is only possible before shipping — so
    // somebody else can still do this.
    expect(need.status).toBe("OPEN");
  });

  it("lets a new helper propose on the reopened need", async () => {
    const { deal, needId } = await dealAt("PRODUCT_PAID");
    await move(yuki, deal.id, "CANCELLED", REASON);
    const marek = await signUpVerifiedAndLogIn(app, "marek@example.com", "M");

    const response = await request(app)
      .post(`/needs/${needId}/proposals`)
      .set("Cookie", marek.cookie)
      .send({});

    expect(response.status).toBe(201);
  });

  it("does not let the same helper back in", async () => {
    const { deal, needId } = await dealAt("QUOTE_AGREED");
    await move(kadri, deal.id, "CANCELLED", REASON);

    // Pinned first: without it this test passes for the wrong reason, because
    // a need that is still MATCHED refuses everybody.
    const need = await prisma.need.findUniqueOrThrow({ where: { id: needId } });
    expect(need.status).toBe("OPEN");

    const again = await request(app)
      .post(`/needs/${needId}/proposals`)
      .set("Cookie", yuki.cookie)
      .send({});

    // One proposal per helper per need, whatever became of it (#19). The slot
    // stays taken, and that is deliberate rather than an oversight.
    expect(again.status).toBe(409);
  });

  it("leaves a need the requester has already closed", async () => {
    const { deal, needId } = await dealAt("QUOTE_AGREED");
    await prisma.need.update({
      where: { id: needId },
      data: { status: "CLOSED" },
    });

    const response = await move(kadri, deal.id, "CANCELLED", REASON);

    expect(response.status).toBe(200);
    const need = await prisma.need.findUniqueOrThrow({ where: { id: needId } });
    // They took it down on purpose. A cancellation must not quietly republish
    // something somebody deliberately withdrew.
    expect(need.status).toBe("CLOSED");
  });

  it("leaves a need a moderator has removed", async () => {
    const { deal, needId } = await dealAt("QUOTE_AGREED");
    await prisma.need.update({
      where: { id: needId },
      data: { status: "REMOVED" },
    });

    await move(kadri, deal.id, "CANCELLED", REASON);

    const need = await prisma.need.findUniqueOrThrow({ where: { id: needId } });
    expect(need.status).toBe("REMOVED");
  });

  it("reopens nothing if the cancellation fails halfway", async () => {
    const { deal, needId } = await dealAt("QUOTE_AGREED");
    // Break the event write from inside the transaction: releasing the need is
    // part of cancelling, so it has to be undone with everything else. Written
    // through `prisma` instead of `tx` it would survive the rollback, and the
    // need would be open with the deal still live.
    const broken = breakInsideTransaction("dealEvent");

    const response = await move(kadri, deal.id, "CANCELLED", REASON);
    vi.restoreAllMocks();

    expect(response.status).toBe(500);
    expect(broken.attempts).toBe(1);
    const need = await prisma.need.findUniqueOrThrow({ where: { id: needId } });
    expect(need.status).toBe("MATCHED");
    expect(
      (await prisma.deal.findUniqueOrThrow({ where: { id: deal.id } })).status,
    ).toBe("QUOTE_AGREED");
  });

  it("reopens nothing when the cancellation is refused", async () => {
    const { deal, needId } = await dealAt("SHIPPED");

    const response = await move(kadri, deal.id, "CANCELLED", REASON);

    // Too late to cancel once it is in the post.
    expect(response.status).toBe(409);
    const need = await prisma.need.findUniqueOrThrow({ where: { id: needId } });
    expect(need.status).toBe("MATCHED");
  });
});

describe("a dispute freezes the deal", () => {
  async function disputed(from: DealStatus) {
    const { deal, needId } = await dealAt(from);
    await move(kadri, deal.id, "DISPUTED", { note: "The parcel never came" });

    return { deal, needId };
  }

  it("stops both of them moving it anywhere", async () => {
    const { deal } = await disputed("SHIPPED");

    const byRequester = await move(kadri, deal.id, "DELIVERED");
    const byHelper = await move(yuki, deal.id, "CANCELLED", REASON);

    // Frozen: the two of them have stopped agreeing, so neither gets to
    // decide what happens next.
    expect(byRequester.status).toBe(409);
    expect(byHelper.status).toBe(403);
    const after = await prisma.deal.findUniqueOrThrow({
      where: { id: deal.id },
    });
    expect(after.status).toBe("DISPUTED");
  });

  it("lets a moderator send it back where it came from", async () => {
    const mo = await makeModerator();
    const { deal } = await disputed("PURCHASED");

    const response = await move(mo, deal.id, "PURCHASED", {
      note: "Tracking shows it is still in transit",
    });

    expect(response.status).toBe(200);
    const after = await prisma.deal.findUniqueOrThrow({
      where: { id: deal.id },
    });
    expect(after.status).toBe("PURCHASED");
  });

  it("refuses any state but the one it came from", async () => {
    const mo = await makeModerator();
    const { deal } = await disputed("PURCHASED");

    const wrong = await move(mo, deal.id, "SHIPPED", { note: "Call it sent" });

    // The table lists all three states a dispute can be resolved into,
    // because it cannot know which applies here. The event log does.
    expect(wrong.status).toBe(409);
  });

  it("lets a moderator cancel it instead", async () => {
    const mo = await makeModerator();
    const { deal, needId } = await disputed("PRODUCT_PAID");

    const response = await move(mo, deal.id, "CANCELLED", {
      note: "Neither side can show what happened",
    });

    expect(response.status).toBe(200);
    // A moderator's cancellation releases the need like any other.
    const need = await prisma.need.findUniqueOrThrow({ where: { id: needId } });
    expect(need.status).toBe("OPEN");
  });

  it("records the resolution on the event", async () => {
    const mo = await makeModerator();
    const { deal } = await disputed("SHIPPED");

    await move(mo, deal.id, "SHIPPED", {
      note: "Tracking says delivered to the neighbour",
    });

    const last = await prisma.dealEvent.findFirstOrThrow({
      orderBy: { createdAt: "desc" },
    });
    expect(last.fromStatus).toBe("DISPUTED");
    expect(last.toStatus).toBe("SHIPPED");
    expect(last.note).toBe("Tracking says delivered to the neighbour");
    expect(last.actorId).toBe(mo.id);
  });

  it("can be disputed again after being sent back", async () => {
    const mo = await makeModerator();
    const { deal } = await disputed("PURCHASED");
    await move(mo, deal.id, "PURCHASED", { note: "Give it another week" });

    const second = await move(yuki, deal.id, "DISPUTED", {
      note: "Still nothing",
    });

    expect(second.status).toBe(200);
  });
});

describe("a delivered deal finishes by itself", () => {
  /** Puts a deal at DELIVERED, with its delivery event dated `daysAgo`. */
  async function deliveredDaysAgo(daysAgo: number) {
    const { deal } = await dealAt("SHIPPED");
    await move(kadri, deal.id, "DELIVERED");
    const event = await prisma.dealEvent.findFirstOrThrow({
      where: { dealId: deal.id, toStatus: "DELIVERED" },
    });
    await prisma.dealEvent.update({
      where: { id: event.id },
      data: { createdAt: new Date(Date.now() - daysAgo * DAY) },
    });

    return deal;
  }

  it("completes one delivered more than fourteen days ago", async () => {
    const deal = await deliveredDaysAgo(15);

    const completed = await autoCompleteDeals(new Date());

    expect(completed).toBe(1);
    const after = await prisma.deal.findUniqueOrThrow({
      where: { id: deal.id },
    });
    expect(after.status).toBe("COMPLETED");
  });

  it("leaves one delivered yesterday alone", async () => {
    const deal = await deliveredDaysAgo(1);

    const completed = await autoCompleteDeals(new Date());

    expect(completed).toBe(0);
    const after = await prisma.deal.findUniqueOrThrow({
      where: { id: deal.id },
    });
    expect(after.status).toBe("DELIVERED");
  });

  it("says the system did it, not a person", async () => {
    const deal = await deliveredDaysAgo(20);

    await autoCompleteDeals(new Date());

    const last = await prisma.dealEvent.findFirstOrThrow({
      where: { dealId: deal.id },
      orderBy: { createdAt: "desc" },
    });
    expect(last.fromStatus).toBe("DELIVERED");
    expect(last.toStatus).toBe("COMPLETED");
    // A null actor is how the log says "nobody asked for this"
    // (docs/05-data-model.md).
    expect(last.actorId).toBeNull();
  });

  it("takes the date it is given, so the rule can be tested at all", async () => {
    const deal = await deliveredDaysAgo(2);

    const completed = await autoCompleteDeals(new Date(Date.now() + 13 * DAY));

    // Two days ago plus thirteen days on is fifteen days: due.
    expect(completed).toBe(1);
    const after = await prisma.deal.findUniqueOrThrow({
      where: { id: deal.id },
    });
    expect(after.status).toBe("COMPLETED");
  });

  it("leaves deals in any other status where they are", async () => {
    const { deal: shipped } = await dealAt("SHIPPED");
    const { deal: disputed } = await dealAt("PRODUCT_PAID");
    await move(kadri, disputed.id, "DISPUTED", { note: "Nothing arrived" });
    // Both are old enough to be due, if only status were the rule.
    await prisma.dealEvent.updateMany({
      data: { createdAt: new Date(Date.now() - 30 * DAY) },
    });

    const completed = await autoCompleteDeals(new Date());

    expect(completed).toBe(0);
    expect(
      (await prisma.deal.findUniqueOrThrow({ where: { id: shipped.id } }))
        .status,
    ).toBe("SHIPPED");
    expect(
      (await prisma.deal.findUniqueOrThrow({ where: { id: disputed.id } }))
        .status,
    ).toBe("DISPUTED");
  });

  it("is safe to run twice", async () => {
    await deliveredDaysAgo(15);

    const first = await autoCompleteDeals(new Date());
    const second = await autoCompleteDeals(new Date());

    // The schedule may fire twice, or two copies may overlap. The second run
    // must find nothing left to do rather than writing a second event.
    expect(first).toBe(1);
    expect(second).toBe(0);
    expect(
      await prisma.dealEvent.count({ where: { toStatus: "COMPLETED" } }),
    ).toBe(1);
  });

  it("counts the latest delivery, not the first one", async () => {
    const deal = await deliveredDaysAgo(30);
    // A second delivery, today. Two DELIVERED events on one deal cannot happen
    // through the API as the table stands — a delivered deal cannot be
    // disputed, so it can never go back and arrive again — which is why this
    // history is written straight to the database. The sweep should not depend
    // on that staying true: "when was it delivered" means the last time, and a
    // month-old first attempt must not carry a deal that arrived this morning.
    await prisma.dealEvent.create({
      data: {
        dealId: deal.id,
        actorId: kadri.id,
        fromStatus: "SHIPPED",
        toStatus: "DELIVERED",
      },
    });

    const completed = await autoCompleteDeals(new Date());

    expect(completed).toBe(0);
    expect(
      (await prisma.deal.findUniqueOrThrow({ where: { id: deal.id } })).status,
    ).toBe("DELIVERED");
  });

  it("stands down when the requester gets there first", async () => {
    const deal = await deliveredDaysAgo(20);
    // The requester presses "done" in the moment between the sweep listing the
    // deals and writing to this one. The job file promises that running two
    // copies at once completes each deal exactly once; this is that promise.
    await move(kadri, deal.id, "COMPLETED");
    vi.spyOn(prisma.deal, "findMany").mockResolvedValueOnce([
      {
        ...deal,
        status: "DELIVERED",
        events: [{ createdAt: new Date(Date.now() - 20 * DAY) }],
      },
    ] as never);

    const completed = await autoCompleteDeals(new Date());
    vi.restoreAllMocks();

    // The status in the WHERE clause is what refuses it, so the log gets one
    // completion and not two.
    expect(completed).toBe(0);
    expect(
      await prisma.dealEvent.count({ where: { toStatus: "COMPLETED" } }),
    ).toBe(1);
  });

  it("completes several at once, and counts them", async () => {
    await deliveredDaysAgo(15);
    await deliveredDaysAgo(40);
    await deliveredDaysAgo(3);

    const completed = await autoCompleteDeals(new Date());

    expect(completed).toBe(2);
  });
});
