import type { Deal, Need } from "@prisma/client";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/app.js";
import { prisma } from "../../src/db.js";
import { signUpVerifiedAndLogIn } from "../helpers/auth.js";
import type { TestUser } from "../helpers/auth.js";
import { createCategory } from "../helpers/needs.js";
import { breakInsideTransaction } from "../helpers/transactions.js";

/**
 * Quotes — issue #23.
 *
 * These tests are the specification. They fail until the TODOs in
 * src/services/deals.ts are filled in.
 *
 *   npm run test:watch -- quotes
 *
 * Kadri's need was matched with Yuki in #20, so there is a deal. Now Yuki says
 * what it will actually cost, and Kadri says yes — or waits for a better
 * number. Marek is a stranger to all of it.
 *
 * Money is whole cents everywhere (docs/10-decisions/0006): €24.00 is 2400.
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

/** A matched deal between Kadri and Yuki, made the way the API makes one. */
async function matchedDeal(overrides: Partial<Deal> = {}): Promise<Deal> {
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
  const deal = await prisma.deal.findFirstOrThrow({
    where: { proposalId: proposal.id },
  });

  if (Object.keys(overrides).length === 0) return deal;

  return prisma.deal.update({ where: { id: deal.id }, data: overrides });
}

const AQUOTE = {
  currency: "EUR",
  productAmount: 2400,
  shippingEstimate: 900,
};

function quote(user: TestUser, dealId: string, body: object = AQUOTE) {
  return request(app)
    .post(`/deals/${dealId}/quote`)
    .set("Cookie", user.cookie)
    .send(body);
}

function accept(user: TestUser, dealId: string, to = "QUOTE_AGREED") {
  return request(app)
    .post(`/deals/${dealId}/transition`)
    .set("Cookie", user.cookie)
    .send({ to });
}

function quotes(user: TestUser, dealId: string) {
  return request(app).get(`/deals/${dealId}/quotes`).set("Cookie", user.cookie);
}

interface QuoteBody {
  quote: {
    id: string;
    dealId: string;
    currency: string;
    productAmount: number;
    shippingEstimate: number;
    acceptedAt: string | null;
  };
}

interface DealBody {
  deal: {
    id: string;
    status: string;
    currency: string;
    productAmount: number | null;
    shippingEstimate: number | null;
    events: { fromStatus: string | null; toStatus: string; actorId: string }[];
  };
}

describe("POST /deals/:id/quote — the helper says what it costs", () => {
  it("records the amounts without agreeing to anything", async () => {
    const deal = await matchedDeal();

    const response = await quote(yuki, deal.id);
    const body = response.body as QuoteBody;

    expect(response.status).toBe(201);
    expect(body.quote.productAmount).toBe(2400);
    expect(body.quote.shippingEstimate).toBe(900);
    expect(body.quote.currency).toBe("EUR");
    expect(body.quote.acceptedAt).toBeNull();

    // The deal itself has not moved, and its own amounts are still empty:
    // those are what was AGREED, and nobody has agreed yet.
    const after = await prisma.deal.findUniqueOrThrow({
      where: { id: deal.id },
    });
    expect(after.status).toBe("MATCHED");
    expect(after.productAmount).toBeNull();
    expect(after.shippingEstimate).toBeNull();
  });

  it("keeps every revision, newest first", async () => {
    const deal = await matchedDeal();

    await quote(yuki, deal.id, { ...AQUOTE, productAmount: 2400 });
    await quote(yuki, deal.id, { ...AQUOTE, productAmount: 2600 });
    const response = await quotes(kadri, deal.id);
    const listed = (response.body as { quotes: QuoteBody["quote"][] }).quotes;

    // A revision replaces the offer on the table but not the record of it:
    // "what did you quote me last week?" has an answer.
    expect(listed.map((row) => row.productAmount)).toEqual([2600, 2400]);
  });

  it("refuses the requester", async () => {
    const deal = await matchedDeal();

    const response = await quote(kadri, deal.id);

    // Being quoted at is not the same as quoting.
    expect(response.status).toBe(403);
    expect(await prisma.quote.count()).toBe(0);
  });

  it("hides the deal from everyone else", async () => {
    const deal = await matchedDeal();

    expect((await quote(marek, deal.id)).status).toBe(404);
    expect((await quotes(marek, deal.id)).status).toBe(404);
  });

  it("answers 404 for a deal that does not exist", async () => {
    expect((await quote(yuki, "no-such-deal")).status).toBe(404);
  });

  it("refuses once a quote has been agreed", async () => {
    const deal = await matchedDeal();
    await quote(yuki, deal.id);
    await accept(kadri, deal.id);

    const response = await quote(yuki, deal.id, {
      ...AQUOTE,
      productAmount: 9900,
    });

    // Revisions are allowed only while MATCHED. After that the amounts are
    // what both of them agreed to, and a new number is a new conversation.
    expect(response.status).toBe(409);
  });

  it("refuses amounts that are not whole cents", async () => {
    const deal = await matchedDeal();

    expect(
      (await quote(yuki, deal.id, { ...AQUOTE, productAmount: 24.5 })).status,
    ).toBe(422);
    expect(
      (await quote(yuki, deal.id, { ...AQUOTE, productAmount: -100 })).status,
    ).toBe(422);
    expect(
      (await quote(yuki, deal.id, { ...AQUOTE, productAmount: 0 })).status,
    ).toBe(422);
    // Free postage is a real offer, so zero is allowed here and not above.
    expect(
      (await quote(yuki, deal.id, { ...AQUOTE, shippingEstimate: 0 })).status,
    ).toBe(201);
  });

  it("refuses a currency that is not three letters", async () => {
    const deal = await matchedDeal();

    expect(
      (await quote(yuki, deal.id, { ...AQUOTE, currency: "€" })).status,
    ).toBe(422);
    expect(
      (await quote(yuki, deal.id, { ...AQUOTE, currency: "jpy" })).status,
    ).toBe(201);
  });

  it("turns away someone not signed in", async () => {
    const deal = await matchedDeal();

    const response = await request(app)
      .post(`/deals/${deal.id}/quote`)
      .send(AQUOTE);

    expect(response.status).toBe(401);
  });
});

describe("POST /deals/:id/transition — the requester agrees", () => {
  it("moves the deal and locks the amounts onto it", async () => {
    const deal = await matchedDeal();
    await quote(yuki, deal.id, {
      currency: "JPY",
      productAmount: 3200,
      shippingEstimate: 1100,
    });

    const response = await accept(kadri, deal.id);
    const body = response.body as DealBody;

    expect(response.status).toBe(200);
    expect(body.deal.status).toBe("QUOTE_AGREED");
    // Copied onto the deal, currency included: the quote may name a different
    // one from the need, and accepting is when it stops being negotiable.
    expect(body.deal.productAmount).toBe(3200);
    expect(body.deal.shippingEstimate).toBe(1100);
    expect(body.deal.currency).toBe("JPY");
  });

  it("marks the quote that was agreed, and only that one", async () => {
    const deal = await matchedDeal();
    await quote(yuki, deal.id, { ...AQUOTE, productAmount: 2400 });
    await quote(yuki, deal.id, { ...AQUOTE, productAmount: 2600 });

    await accept(kadri, deal.id);

    const rows = await prisma.quote.findMany({ orderBy: { createdAt: "asc" } });
    // The newest is the offer on the table; the older one was never agreed.
    expect(rows[0]?.acceptedAt).toBeNull();
    expect(rows[1]?.acceptedAt).not.toBeNull();
    const after = await prisma.deal.findUniqueOrThrow({
      where: { id: deal.id },
    });
    expect(after.productAmount).toBe(2600);
  });

  it("logs the transition", async () => {
    const deal = await matchedDeal();
    await quote(yuki, deal.id);

    const response = await accept(kadri, deal.id);
    const body = response.body as DealBody;

    const events = await prisma.dealEvent.findMany({
      orderBy: { createdAt: "asc" },
    });
    // One from #20 creating the deal, one from this.
    expect(events).toHaveLength(2);
    expect(events[1]?.fromStatus).toBe("MATCHED");
    expect(events[1]?.toStatus).toBe("QUOTE_AGREED");
    expect(events[1]?.actorId).toBe(kadri.id);
    expect(body.deal.events).toHaveLength(2);
  });

  it("refuses the helper", async () => {
    const deal = await matchedDeal();
    await quote(yuki, deal.id);

    const response = await accept(yuki, deal.id);

    // Agreeing to your own price is not agreement.
    expect(response.status).toBe(403);
  });

  it("refuses when there is nothing to agree to", async () => {
    const deal = await matchedDeal();

    const response = await accept(kadri, deal.id);

    expect(response.status).toBe(409);
    const after = await prisma.deal.findUniqueOrThrow({
      where: { id: deal.id },
    });
    expect(after.status).toBe("MATCHED");
  });

  it("refuses a deal that has already moved on", async () => {
    const deal = await matchedDeal();
    await quote(yuki, deal.id);
    await accept(kadri, deal.id);

    const again = await accept(kadri, deal.id);

    expect(again.status).toBe(409);
    expect(await prisma.dealEvent.count()).toBe(2);
  });

  it("hides the deal from a stranger", async () => {
    const deal = await matchedDeal();
    await quote(yuki, deal.id);

    const response = await accept(marek, deal.id);

    expect(response.status).toBe(404);
  });

  it("refuses a move the table does not allow from here", async () => {
    const deal = await matchedDeal();
    await quote(yuki, deal.id);

    const response = await accept(kadri, deal.id, "SHIPPED");

    // This was a 422 while the endpoint knew one transition and every other
    // target was simply unrecognised. Now that the table is complete, SHIPPED
    // is a real status the deal cannot reach from MATCHED — which is a 409,
    // the same answer as any other move the table does not list. The
    // scaffolding is gone and the honest answer took its place (#24).
    expect(response.status).toBe(409);
  });

  it("writes nothing at all when the last step fails", async () => {
    const deal = await matchedDeal();
    await quote(yuki, deal.id);
    // Break the event write from inside the real transaction, the way #20's
    // accept is tested: three writes that are one decision, so a failure in
    // the third must take the first two with it.
    const broken = breakInsideTransaction("dealEvent");

    const response = await accept(kadri, deal.id);
    vi.restoreAllMocks();

    expect(response.status).toBe(500);
    expect(broken.attempts).toBe(1);
    const after = await prisma.deal.findUniqueOrThrow({
      where: { id: deal.id },
    });
    expect(after.status).toBe("MATCHED");
    expect(after.productAmount).toBeNull();
    expect(after.currency).toBe("EUR");
    expect((await prisma.quote.findFirstOrThrow()).acceptedAt).toBeNull();
    // Only the one #20 wrote when the deal was created.
    expect(await prisma.dealEvent.count()).toBe(1);
  });

  it("still agrees cleanly after a failed attempt", async () => {
    const deal = await matchedDeal();
    await quote(yuki, deal.id);
    breakInsideTransaction("dealEvent");
    await accept(kadri, deal.id);
    vi.restoreAllMocks();

    const second = await accept(kadri, deal.id);

    // The rollback left the deal genuinely matched, not merely looking it.
    expect(second.status).toBe(200);
    expect((second.body as DealBody).deal.status).toBe("QUOTE_AGREED");
  });

  it("writes nothing when the deal cannot be moved", async () => {
    const deal = await matchedDeal({ status: "CANCELLED" });
    await prisma.quote.create({
      data: { dealId: deal.id, ...AQUOTE },
    });

    const response = await accept(kadri, deal.id);

    expect(response.status).toBe(409);
    // None of the three writes may have happened on their own.
    const after = await prisma.deal.findUniqueOrThrow({
      where: { id: deal.id },
    });
    expect(after.productAmount).toBeNull();
    expect(await prisma.quote.findFirstOrThrow()).toMatchObject({
      acceptedAt: null,
    });
    expect(await prisma.dealEvent.count()).toBe(1);
  });
});

describe("one accepted quote per deal, kept by the database", () => {
  it("refuses a second accepted quote on the same deal", async () => {
    const deal = await matchedDeal();
    await quote(yuki, deal.id);
    await accept(kadri, deal.id);

    const second = prisma.quote.create({
      data: { dealId: deal.id, ...AQUOTE, acceptedAt: new Date() },
    });

    // Straight to the database, past every check in the service: the partial
    // unique index is the last line of defence, as in #20.
    await expect(second).rejects.toMatchObject({ code: "P2002" });
  });

  it("allows any number of quotes nobody has agreed to", async () => {
    const deal = await matchedDeal();

    await quote(yuki, deal.id);
    await quote(yuki, deal.id, { ...AQUOTE, productAmount: 2500 });
    await quote(yuki, deal.id, { ...AQUOTE, productAmount: 2600 });

    // The index only counts accepted ones — that is what "partial" buys.
    expect(await prisma.quote.count()).toBe(3);
  });

  it("refuses negative money even written by hand", async () => {
    const deal = await matchedDeal();

    const bad = prisma.quote.create({
      data: { dealId: deal.id, ...AQUOTE, productAmount: -1 },
    });

    await expect(bad).rejects.toThrow();
  });
});
