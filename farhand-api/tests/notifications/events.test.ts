import type { Deal, DealStatus } from "@prisma/client";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/app.js";
import { prisma } from "../../src/db.js";
import { mailer } from "../../src/mailer.js";
import { autoCompleteDeals } from "../../src/services/deals.js";
import { signUpVerifiedAndLogIn } from "../helpers/auth.js";
import type { TestUser } from "../helpers/auth.js";
import { createCategory } from "../helpers/needs.js";
import { runQueuedJobs } from "../helpers/jobs.js";

/**
 * WHICH events email, and which deliberately do not — issue #86.
 *
 * The rule the whole list follows, and the only one worth remembering:
 *
 *   Email when the recipient must DO something, or has lost the chance to.
 *   Never as an activity feed.
 *
 * The list is written out again here, by hand, from
 * docs/10-decisions/0020-what-is-worth-an-email.md. If this file and that
 * document disagree, one of them is a bug — the same arrangement as the
 * transition table in tests/deals/transitions.test.ts, and for the same
 * reason: a test that reads the table it is testing would never notice.
 *
 * The SILENT half is tested as carefully as the loud half. An email nobody
 * wanted is the kind of mistake that costs an address its trust in us, and
 * "we decided not to" is only true if something checks.
 */
const app = createApp();

/** Who is told when a deal lands in a status, and which side acted. */
interface Expectation {
  /** The move, as docs/04-deal-lifecycle.md writes it. */
  from: DealStatus;
  to: DealStatus;
  by: "requester" | "helper" | "moderator";
  /** Who hears about it, and what they are told. */
  told: { side: "requester" | "helper"; kind: string }[];
}

const DEAL_EVENTS: Expectation[] = [
  // The requester agrees the quote and then has to pay: their own next step,
  // so nothing is sent. An email about the button you just pressed is noise.
  { from: "MATCHED", to: "QUOTE_AGREED", by: "requester", told: [] },
  // Paid. Now the helper has to go and buy the thing.
  {
    from: "QUOTE_AGREED",
    to: "PRODUCT_PAID",
    by: "requester",
    told: [{ side: "helper", kind: "deal-your-turn" }],
  },
  // Bought, and the same person posts it next.
  { from: "PRODUCT_PAID", to: "PURCHASED", by: "helper", told: [] },
  // Posted — and this one is a promise the documentation has carried since
  // #22: "Requester notified to settle the difference".
  {
    from: "PURCHASED",
    to: "SHIPPED",
    by: "helper",
    told: [{ side: "requester", kind: "deal-your-turn" }],
  },
  // Arrived. The requester confirms, then completes: their own next step.
  { from: "SHIPPED", to: "DELIVERED", by: "requester", told: [] },
  // Completed, so reviews open for fourteen days (#83) — and that is news to
  // both sides, including the one who pressed the button. What is announced
  // is not the press, it is the window.
  {
    from: "DELIVERED",
    to: "COMPLETED",
    by: "requester",
    told: [
      { side: "requester", kind: "deal-completed" },
      { side: "helper", kind: "deal-completed" },
    ],
  },
  // Walked away from: the other side is owed nothing now, and has to be told
  // so, whichever of them did it.
  {
    from: "PRODUCT_PAID",
    to: "CANCELLED",
    by: "requester",
    told: [{ side: "helper", kind: "deal-cancelled" }],
  },
  {
    from: "PRODUCT_PAID",
    to: "CANCELLED",
    by: "helper",
    told: [{ side: "requester", kind: "deal-cancelled" }],
  },
  // A dispute freezes the deal (docs/04), so the other side cannot discover
  // it by trying to act.
  {
    from: "PURCHASED",
    to: "DISPUTED",
    by: "helper",
    told: [{ side: "requester", kind: "deal-disputed" }],
  },
  // A moderator resolving one is news to both, because neither of them did
  // it. Which kind depends on where it landed.
  {
    from: "DISPUTED",
    to: "PURCHASED",
    by: "moderator",
    told: [
      { side: "requester", kind: "deal-disputed" },
      { side: "helper", kind: "deal-disputed" },
    ],
  },
  {
    from: "DISPUTED",
    to: "CANCELLED",
    by: "moderator",
    told: [
      { side: "requester", kind: "deal-cancelled" },
      { side: "helper", kind: "deal-cancelled" },
    ],
  },
];

let categoryId = "";
let kadri: TestUser;
let yuki: TestUser;
let mo: TestUser;

beforeEach(async () => {
  categoryId = (await createCategory()).id;
  kadri = await signUpVerifiedAndLogIn(app, "kadri@example.com", "Kadri");
  yuki = await signUpVerifiedAndLogIn(app, "yuki@example.com", "Yuki");
  mo = await signUpVerifiedAndLogIn(app, "mo@example.com", "Mo");
  await prisma.user.update({
    where: { id: mo.id },
    data: { role: "MODERATOR" },
  });
  await prisma.job.deleteMany({});
  await prisma.notification.deleteMany({});
});

/** What each person would be emailed about, by kind. */
async function tellings(): Promise<{ email: string; kind: string }[]> {
  const rows = await prisma.notification.findMany({
    include: { user: { select: { email: true } } },
    orderBy: { createdAt: "asc" },
  });

  return rows.map((row) => ({ email: row.user.email, kind: row.kind }));
}

function sideEmail(side: "requester" | "helper"): string {
  return side === "requester" ? kadri.email : yuki.email;
}

function userFor(by: "requester" | "helper" | "moderator"): TestUser {
  if (by === "requester") return kadri;
  if (by === "helper") return yuki;
  return mo;
}

const FIELDS: Partial<Record<DealStatus, object>> = {
  SHIPPED: { trackingNumber: "JP123456789", shippingActual: 1150 },
  CANCELLED: { note: "The shop stopped stocking it" },
  DISPUTED: { note: "The parcel never arrived" },
};

/** Kadri wants something; Yuki offers; the deal exists and is MATCHED. */
async function aDeal(): Promise<Deal> {
  const need = await prisma.need.create({
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
    },
  });
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
  await prisma.quote.create({
    data: {
      dealId: deal.id,
      currency: "EUR",
      productAmount: 2400,
      shippingEstimate: 900,
    },
  });

  return deal;
}

/** A deal sitting in `status`, with the queue and the record cleared. */
async function dealAt(
  status: DealStatus,
  disputedFrom: DealStatus = "PURCHASED",
): Promise<Deal> {
  const deal = await aDeal();

  if (status === "DISPUTED") {
    await prisma.deal.update({
      where: { id: deal.id },
      data: { status: disputedFrom },
    });
    await move(yuki, deal.id, "DISPUTED", { note: "It never arrived" });
  } else if (status !== "MATCHED") {
    await prisma.deal.update({ where: { id: deal.id }, data: { status } });

    // A completed deal needs the event that completed it: #83 measures the
    // review window from it, and without one a review is refused with a 409
    // for a reason that has nothing to do with notifications.
    if (status === "COMPLETED") {
      await prisma.dealEvent.create({
        data: {
          dealId: deal.id,
          actorId: kadri.id,
          fromStatus: "DELIVERED",
          toStatus: "COMPLETED",
        },
      });
    }
  }

  await prisma.job.deleteMany({});
  await prisma.notification.deleteMany({});

  return prisma.deal.findUniqueOrThrow({ where: { id: deal.id } });
}

function move(user: TestUser, dealId: string, to: DealStatus, extra = {}) {
  return request(app)
    .post(`/deals/${dealId}/transition`)
    .set("Cookie", user.cookie)
    .send({ to, ...(FIELDS[to] ?? {}), ...extra });
}

describe("a proposal", () => {
  it("tells the person whose need it is, and not the one who offered", async () => {
    const need = await prisma.need.create({
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
      },
    });

    const response = await request(app)
      .post(`/needs/${need.id}/proposals`)
      .set("Cookie", yuki.cookie)
      .send({});
    expect(response.status).toBe(201);

    expect(await tellings()).toEqual([
      { email: kadri.email, kind: "proposal-received" },
    ]);
  });

  it("tells the helper when it is accepted, and not the requester who accepted", async () => {
    const deal = await aDeal();
    expect(deal.status).toBe("MATCHED");

    expect(await tellings()).toEqual([
      // The offer itself, to Kadri…
      { email: kadri.email, kind: "proposal-received" },
      // …and the acceptance, to Yuki, who now has a deal to quote for.
      { email: yuki.email, kind: "proposal-accepted" },
    ]);
  });

  it("tells nobody when it is declined or withdrawn", async () => {
    const need = await prisma.need.create({
      data: {
        requesterId: kadri.id,
        categoryId,
        title: "Matcha",
        description: "Ceremonial grade",
        buyCountry: "JP",
        deliverCountry: "EE",
        currency: "EUR",
        estimatedPrice: 2400,
        status: "OPEN",
      },
    });
    await request(app)
      .post(`/needs/${need.id}/proposals`)
      .set("Cookie", yuki.cookie)
      .send({});
    const proposal = await prisma.proposal.findFirstOrThrow({
      where: { needId: need.id },
    });
    await prisma.notification.deleteMany({});

    await request(app)
      .post(`/proposals/${proposal.id}/decline`)
      .set("Cookie", kadri.cookie)
      .send({});

    // Deliberate, and the one most likely to be argued about: a decline is
    // not a thing the helper has to act on, and an email saying "no" invites
    // a reply nobody reads. It is in the list of silences in decision 0020
    // rather than left to be noticed.
    expect(await tellings()).toEqual([]);
  });
});

describe("a quote", () => {
  it("tells the requester, because agreeing to it is their move", async () => {
    const deal = await dealAt("MATCHED");

    const response = await request(app)
      .post(`/deals/${deal.id}/quote`)
      .set("Cookie", yuki.cookie)
      .send({ currency: "EUR", productAmount: 2400, shippingEstimate: 900 });
    expect(response.status).toBe(201);

    // Without this one, a quoted deal waits for a requester who was never
    // told there was anything to look at.
    expect(await tellings()).toEqual([
      { email: kadri.email, kind: "deal-your-turn" },
    ]);
  });
});

describe("the deal lifecycle", () => {
  for (const row of DEAL_EVENTS) {
    const who = row.told.length
      ? row.told.map((t) => `${t.side}: ${t.kind}`).join(", ")
      : "nobody";

    it(`${row.from} → ${row.to} by the ${row.by} tells ${who}`, async () => {
      const deal = await dealAt(row.from);

      const response = await move(userFor(row.by), deal.id, row.to, {
        ...(row.by === "moderator" ? { note: "Resolved: it arrived" } : {}),
      });
      expect(response.status).toBe(200);

      expect(await tellings()).toEqual(
        row.told.map((t) => ({ email: sideEmail(t.side), kind: t.kind })),
      );
    });
  }

  it("tells both sides when the sweep completes a deal nobody touched", async () => {
    const deal = await dealAt("DELIVERED");
    // Fourteen days since delivery, which is what the sweep looks for (#101).
    await prisma.dealEvent.create({
      data: {
        dealId: deal.id,
        actorId: kadri.id,
        fromStatus: "SHIPPED",
        toStatus: "DELIVERED",
        createdAt: new Date(Date.now() - 15 * 24 * 60 * 60 * 1000),
      },
    });

    expect(await autoCompleteDeals(new Date())).toBe(1);

    // The event has a null actorId — the system acted (docs/04) — so there is
    // nobody to leave out: both sides have fourteen days to review.
    expect(await tellings()).toEqual([
      { email: kadri.email, kind: "deal-completed" },
      { email: yuki.email, kind: "deal-completed" },
    ]);
  });
});

describe("a moderator's decision", () => {
  it("tells the person it was about", async () => {
    const response = await request(app)
      .post(`/admin/users/${yuki.id}/actions`)
      .set("Cookie", mo.cookie)
      .send({ type: "SUSPEND", reason: "Shouting at a requester" });
    expect(response.status).toBe(201);

    expect(await tellings()).toEqual([
      { email: yuki.email, kind: "moderation-decision" },
    ]);
  });
});

describe("the silences, which are decisions and not gaps", () => {
  it("says nothing when somebody reviews you", async () => {
    const deal = await dealAt("COMPLETED");
    await prisma.notification.deleteMany({});

    const response = await request(app)
      .post(`/deals/${deal.id}/review`)
      .set("Cookie", kadri.cookie)
      .send({ rating: 5, comment: "Fast and kind" });
    expect(response.status).toBe(201);

    // Reviews are blind until both sides have written or the window closes
    // (#83, decision 0017). "Yuki reviewed you" tells you they went first,
    // which is the pressure the blind window exists to remove.
    expect(await tellings()).toEqual([]);
  });

  it("says nothing when a message arrives", async () => {
    const deal = await dealAt("PRODUCT_PAID");

    const response = await request(app)
      .post(`/proposals/${deal.proposalId}/messages`)
      .set("Cookie", yuki.cookie)
      .send({ body: "I am at the shop now" });
    expect(response.status).toBe(201);

    // The one most people expect, and the one that turns an inbox into a chat
    // notification. It needs a quiet period and a digest to be bearable, and
    // that is its own issue rather than a line here.
    expect(await tellings()).toEqual([]);
  });

  it("says nothing to the person who acted", async () => {
    const deal = await dealAt("QUOTE_AGREED");

    await move(kadri, deal.id, "PRODUCT_PAID");
    await runQueuedJobs();

    // Only the helper hears, and the proof is the recipient rather than the
    // count: a rule written as "everybody in the deal" would also pass a test
    // that only counted one.
    const told = await tellings();
    expect(told).toEqual([{ email: yuki.email, kind: "deal-your-turn" }]);
  });
});

describe("what the emails say", () => {
  it("names the need, so the email means something on its own", async () => {
    const sent = vi
      .spyOn(mailer, "sendNotificationEmail")
      .mockResolvedValue(undefined);
    const deal = await dealAt("QUOTE_AGREED");

    await move(kadri, deal.id, "PRODUCT_PAID");
    await runQueuedJobs();

    // Somebody with three deals open needs to know which one this is about,
    // and with no frontend (#93) there is no link to find out.
    expect(sent.mock.calls[0]?.[2] ?? "").toContain("Japanese sunscreen");
  });
});
