import type { Deal, DealStatus, Need } from "@prisma/client";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/app.js";
import { prisma } from "../../src/db.js";
import { signUpVerifiedAndLogIn } from "../helpers/auth.js";
import type { TestUser } from "../helpers/auth.js";
import { createCategory } from "../helpers/needs.js";

/**
 * The deal transition engine — issue #24.
 *
 * These tests are the specification. They fail until the TODOs in
 * src/services/transitions.ts and src/services/deals.ts are filled in.
 *
 *   npm run test:watch -- transitions
 *
 * The table being implemented is the one in docs/04-deal-lifecycle.md. It is
 * written out again at the top of this file, deliberately: if the two ever
 * disagree, one of them is a bug, and a test that reads the same table it
 * tests would never notice.
 */
const app = createApp();

const STATUSES: DealStatus[] = [
  "MATCHED",
  "QUOTE_AGREED",
  "PRODUCT_PAID",
  "PURCHASED",
  "SHIPPED",
  "DELIVERED",
  "COMPLETED",
  "CANCELLED",
  "DISPUTED",
];

type Actor = "requester" | "helper" | "moderator";

/** The document's "Either side": the deal's two people, and nobody else. */
const SIDES: Actor[] = ["requester", "helper"];

/** All three, for asking what happens when one the row does not name asks. */
const ACTORS: Actor[] = ["requester", "helper", "moderator"];

/**
 * Every move the document allows, transcribed by hand from its table —
 * including **everybody** the Who column names, which is the part #134 made
 * load-bearing. Before it, no row named more than one kind of actor, so a
 * single value was enough and "who may NOT" was nobody's business.
 */
const ALLOWED: {
  from: DealStatus;
  to: DealStatus;
  who: Actor[];
}[] = [
  { from: "MATCHED", to: "QUOTE_AGREED", who: ["requester"] },
  { from: "QUOTE_AGREED", to: "PRODUCT_PAID", who: ["requester"] },
  { from: "PRODUCT_PAID", to: "PURCHASED", who: ["helper"] },
  { from: "PURCHASED", to: "SHIPPED", who: ["helper"] },
  { from: "SHIPPED", to: "DELIVERED", who: ["requester"] },
  { from: "DELIVERED", to: "COMPLETED", who: ["requester"] },
  // Before any money has moved, a moderator may end it outright (#134).
  { from: "MATCHED", to: "CANCELLED", who: [...SIDES, "moderator"] },
  { from: "QUOTE_AGREED", to: "CANCELLED", who: [...SIDES, "moderator"] },
  // After it has, cancelling belongs to the two people. A moderator's way is
  // to freeze it first — the three rows below — and end it from there.
  { from: "PRODUCT_PAID", to: "CANCELLED", who: SIDES },
  { from: "PURCHASED", to: "CANCELLED", who: SIDES },
  // "Any state from PRODUCT_PAID to SHIPPED", written out — plus a moderator,
  // who had no move at all on a live deal before #134.
  { from: "PRODUCT_PAID", to: "DISPUTED", who: [...SIDES, "moderator"] },
  { from: "PURCHASED", to: "DISPUTED", who: [...SIDES, "moderator"] },
  { from: "SHIPPED", to: "DISPUTED", who: [...SIDES, "moderator"] },
  { from: "DISPUTED", to: "CANCELLED", who: ["moderator"] },
  // "Or previous state" (#25). All three are in the table, because it cannot
  // know which one applies to a given deal; only the one the dispute started
  // from is allowed for THAT deal, which the fixture below arranges and
  // tests/deals/cancellation.test.ts checks from the other side.
  { from: "DISPUTED", to: "PRODUCT_PAID", who: ["moderator"] },
  { from: "DISPUTED", to: "PURCHASED", who: ["moderator"] },
  { from: "DISPUTED", to: "SHIPPED", who: ["moderator"] },
];

/**
 * The extra fields a move demands — keyed by the ROW and not by the target,
 * which is the lesson of #25: a moderator returning a deal to SHIPPED sends a
 * note, while the helper posting the parcel sends a tracking number and the
 * real postage. Same target, different requirements.
 */
function fieldsFor(from: DealStatus, to: DealStatus): object {
  if (from === "DISPUTED" && to !== "CANCELLED") {
    return { note: "Tracking shows it is still on its way" };
  }

  return FIELDS[to] ?? {};
}

/** The extra fields each target demands, for the rows with only one source. */
const FIELDS: Partial<Record<DealStatus, object>> = {
  SHIPPED: { trackingNumber: "JP123456789", shippingActual: 1150 },
  CANCELLED: { note: "The shop stopped stocking it" },
  DISPUTED: { note: "The parcel never arrived" },
};

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

/**
 * The signed-in user standing for an actor. kadri is the requester of every
 * deal in this file and yuki the helper; a moderator is made per test, so it
 * is handed in rather than looked up.
 */
function userFor(actor: Actor, moderator: TestUser): TestUser {
  if (actor === "helper") return yuki;
  if (actor === "moderator") return moderator;
  return kadri;
}

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

/**
 * A deal sitting in `status`, made the way the API makes one and then put into
 * place directly. The engine is what this file tests; walking every deal
 * through five real requests to reach DISPUTED would test the walk instead.
 */
async function dealAt(
  status: DealStatus,
  disputedFrom: DealStatus = "PURCHASED",
): Promise<Deal> {
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
  // Every deal gets a quote: MATCHED → QUOTE_AGREED needs one, and having one
  // present everywhere means a refusal is never about a missing quote.
  await prisma.quote.create({
    data: {
      dealId: deal.id,
      currency: "EUR",
      productAmount: 2400,
      shippingEstimate: 900,
    },
  });

  if (status === "MATCHED") return deal;

  // A deal put straight into DISPUTED has no dispute in its history, and the
  // engine refuses to resolve one of those — for a reason that has nothing to
  // do with the table this file is testing. So it is disputed for real, from
  // `disputedFrom`, and that is the state it may be returned to.
  if (status === "DISPUTED") {
    await prisma.deal.update({
      where: { id: deal.id },
      data: { status: disputedFrom },
    });
    await move(kadri, deal.id, "DISPUTED", { note: "Something went wrong" });

    return prisma.deal.findUniqueOrThrow({ where: { id: deal.id } });
  }

  return prisma.deal.update({ where: { id: deal.id }, data: { status } });
}

function move(user: TestUser, dealId: string, to: DealStatus, extra = {}) {
  return request(app)
    .post(`/deals/${dealId}/transition`)
    .set("Cookie", user.cookie)
    .send({ to, ...(FIELDS[to] ?? {}), ...extra });
}

interface DealBody {
  deal: {
    id: string;
    status: string;
    currency: string;
    productAmount: number | null;
    shippingEstimate: number | null;
    shippingActual: number | null;
    trackingNumber: string | null;
    events: {
      fromStatus: string | null;
      toStatus: string;
      actorId: string | null;
      note: string | null;
    }[];
  };
}

describe("the table decides", () => {
  /**
   * The fourth acceptance criterion: every invalid transition is rejected.
   *
   * Nine statuses give 81 pairs. Nine of those are a status to itself, which
   * the next test covers; of the 72 that remain, the document allows 17 — so
   * 55 must be refused, whoever asks and however well-formed the request is.
   *
   * The arithmetic is asserted too. It is easy to add a row to the table above
   * and leave the count alone, and then this test quietly checks less than it
   * says it does.
   */
  it("refuses every move the table does not list", async () => {
    const mo = await makeModerator();
    const refused: string[] = [];
    const wrongly: string[] = [];

    for (const from of STATUSES) {
      const invalid = STATUSES.filter(
        (to) =>
          to !== from &&
          !ALLOWED.some((rule) => rule.from === from && rule.to === to),
      );

      for (const to of invalid) {
        const deal = await dealAt(from);
        // Try it as all three: nobody may do what the table does not allow.
        const attempts = [
          await move(kadri, deal.id, to),
          await move(yuki, deal.id, to),
          await move(mo, deal.id, to),
        ];

        for (const attempt of attempts) {
          if (attempt.status === 200) wrongly.push(`${from} → ${to}`);
        }
        refused.push(`${from} → ${to}`);
      }
    }

    expect(wrongly).toEqual([]);
    expect(ALLOWED).toHaveLength(17);
    expect(refused).toHaveLength(55);
    expect(ALLOWED.length + refused.length + STATUSES.length).toBe(81);
  }, 120_000);

  it("allows every move the table does list", async () => {
    const mo = await makeModerator();
    const failed: string[] = [];

    for (const rule of ALLOWED) {
      // For the three ways out of a dispute, the deal has to have been
      // disputed from the state this row returns it to.
      const deal = await dealAt(
        rule.from,
        rule.from === "DISPUTED" && rule.to !== "CANCELLED"
          ? rule.to
          : "PURCHASED",
      );
      // The first actor the row names. Rows naming more than one are tried
      // from every side in the test below this one, and the sides a row does
      // NOT name are tried in the test below that.
      const actor = userFor(rule.who[0] ?? "requester", mo);

      const response = await request(app)
        .post(`/deals/${deal.id}/transition`)
        .set("Cookie", actor.cookie)
        .send({ to: rule.to, ...fieldsFor(rule.from, rule.to) });
      if (response.status !== 200) {
        failed.push(
          `${rule.from} → ${rule.to} as ${rule.who.join(", ")}: ${String(response.status)}`,
        );
      }
    }

    expect(failed).toEqual([]);
  }, 120_000);

  /**
   * The other half of "who may ask", and it did not exist until #134.
   *
   * The 55-refusals test above covers moves the table does not list at all.
   * This covers the moves it DOES list, asked by somebody it does not name —
   * which was nobody's business while every row named exactly one kind of
   * actor, and is the whole shape of the new rules: a moderator may end a
   * deal nobody has paid for and may not end one somebody has.
   *
   * Without this, deleting "moderator" from a row's actors, or adding it to
   * one, breaks nothing a test can see.
   */
  it("refuses everybody the row does not name", async () => {
    const mo = await makeModerator();
    const wrongly: string[] = [];
    let attempted = 0;

    for (const rule of ALLOWED) {
      for (const actor of ACTORS.filter((who) => !rule.who.includes(who))) {
        const deal = await dealAt(
          rule.from,
          rule.from === "DISPUTED" && rule.to !== "CANCELLED"
            ? rule.to
            : "PURCHASED",
        );

        attempted += 1;
        const response = await move(
          userFor(actor, mo),
          deal.id,
          rule.to,
          fieldsFor(rule.from, rule.to),
        );

        if (response.status === 200) {
          wrongly.push(`${rule.from} → ${rule.to} as ${actor}`);
        }
      }
    }

    expect(wrongly).toEqual([]);
    // Seventeen rows times three kinds of actor is 51; the rows name 29 of
    // those between them, so 22 are asked by somebody who may not. Asserted
    // for the same reason the 55 above is: a row that quietly grew an actor
    // would leave this test checking one case less and saying nothing.
    expect(attempted).toBe(22);
  }, 120_000);

  it("refuses a status that is not a status at all", async () => {
    const deal = await dealAt("MATCHED");

    const response = await request(app)
      .post(`/deals/${deal.id}/transition`)
      .set("Cookie", kadri.cookie)
      .send({ to: "POSTED" });

    expect(response.status).toBe(422);
  });

  it("refuses standing still", async () => {
    const deal = await dealAt("PURCHASED");

    const response = await move(yuki, deal.id, "PURCHASED");

    // Not in the table, so not allowed — and a deal that transitions to where
    // it already is would write an event saying nothing happened.
    expect(response.status).toBe(409);
  });
});

describe("who may ask", () => {
  it("refuses the wrong side of the deal", async () => {
    const agreed = await dealAt("QUOTE_AGREED");
    const paid = await dealAt("PRODUCT_PAID");

    // Paying is the requester's move; buying is the helper's.
    expect((await move(yuki, agreed.id, "PRODUCT_PAID")).status).toBe(403);
    expect((await move(kadri, paid.id, "PURCHASED")).status).toBe(403);
  });

  it("tells 'you may not' apart from 'that cannot be done'", async () => {
    const agreed = await dealAt("QUOTE_AGREED");
    const matched = await dealAt("MATCHED");

    const notAllowed = await move(yuki, agreed.id, "PRODUCT_PAID");
    const notPossible = await move(kadri, matched.id, "DELIVERED");

    // The difference matters to whoever reads the error: one is about the
    // person, the other about the deal.
    expect(notAllowed.status).toBe(403);
    expect(notPossible.status).toBe(409);
  });

  it("lets either side cancel, and either side dispute", async () => {
    const one = await dealAt("QUOTE_AGREED");
    const two = await dealAt("PURCHASED");
    const three = await dealAt("PRODUCT_PAID");
    const four = await dealAt("SHIPPED");

    expect((await move(kadri, one.id, "CANCELLED")).status).toBe(200);
    expect((await move(yuki, two.id, "CANCELLED")).status).toBe(200);
    expect((await move(kadri, three.id, "DISPUTED")).status).toBe(200);
    expect((await move(yuki, four.id, "DISPUTED")).status).toBe(200);
  });

  it("keeps moderators out of the deal's own moves", async () => {
    const mo = await makeModerator();
    const shipped = await dealAt("SHIPPED");
    const paid = await dealAt("PRODUCT_PAID");

    const confirming = await move(mo, shipped.id, "DELIVERED");
    const cancelling = await move(mo, paid.id, "CANCELLED");

    // A moderator resolves disputes; they do not confirm somebody's parcel.
    expect(confirming.status).toBe(403);
    // And they do not end a deal somebody has already paid for. #134 gave
    // them a way in — freeze it, look at it, then end it with a note — and
    // deliberately not a one-click cancel over the top of money that moved.
    expect(cancelling.status).toBe(403);
  });

  /**
   * #134's whole point, as one test: a moderator can settle a live deal
   * **alone**, from every state a deal can be alive in.
   *
   * Before this, a moderator's only row started at DISPUTED, so an erasure
   * (#88) waited on one of the deal's two people choosing to press something
   * — and if both of them were banned, it waited forever.
   *
   * DELIVERED is not in the list on purpose: the parcel arrived, and
   * `autoCompleteDeliveredDeals` settles it within fourteen days whoever is
   * banned, because that sweep looks at the status and at nothing else.
   */
  it("lets a moderator settle a live deal from any state, alone", async () => {
    const mo = await makeModerator();
    const live: DealStatus[] = [
      "MATCHED",
      "QUOTE_AGREED",
      "PRODUCT_PAID",
      "PURCHASED",
      "SHIPPED",
    ];
    const stuck: string[] = [];

    for (const from of live) {
      const deal = await dealAt(from);

      // One step where no money has moved, two where it has.
      let response = await move(mo, deal.id, "CANCELLED", {
        note: "The other account is banned and cannot act (smoke).",
      });

      if (response.status !== 200) {
        await move(mo, deal.id, "DISPUTED", {
          note: "Frozen: the other account is banned.",
        });
        response = await move(mo, deal.id, "CANCELLED", {
          note: "Ended: nobody left who can move it.",
        });
      }

      if (response.status !== 200)
        stuck.push(`${from}: ${String(response.status)}`);
    }

    expect(stuck).toEqual([]);
  }, 60_000);

  it("lets a moderator end a dispute", async () => {
    const mo = await makeModerator();
    const disputed = await dealAt("DISPUTED");

    const response = await move(mo, disputed.id, "CANCELLED");

    expect(response.status).toBe(200);
    expect((response.body as DealBody).deal.status).toBe("CANCELLED");
  });

  it("hides the deal from a stranger", async () => {
    const deal = await dealAt("QUOTE_AGREED");

    const response = await move(marek, deal.id, "PRODUCT_PAID");

    expect(response.status).toBe(404);
  });
});

describe("what each transition needs", () => {
  it("will not ship without a tracking number and real postage", async () => {
    const deal = await dealAt("PURCHASED");

    const bare = await request(app)
      .post(`/deals/${deal.id}/transition`)
      .set("Cookie", yuki.cookie)
      .send({ to: "SHIPPED" });
    const partial = await request(app)
      .post(`/deals/${deal.id}/transition`)
      .set("Cookie", yuki.cookie)
      .send({ to: "SHIPPED", trackingNumber: "JP123" });

    // A deal that says SHIPPED with nothing to track is worse than a refusal.
    expect(bare.status).toBe(422);
    expect(partial.status).toBe(422);
  });

  it("writes the tracking number and real postage onto the deal", async () => {
    const deal = await dealAt("PURCHASED");

    const response = await move(yuki, deal.id, "SHIPPED");
    const body = response.body as DealBody;

    expect(body.deal.trackingNumber).toBe("JP123456789");
    expect(body.deal.shippingActual).toBe(1150);
  });

  it("will not cancel or dispute without a reason", async () => {
    const one = await dealAt("QUOTE_AGREED");
    const two = await dealAt("PURCHASED");

    const cancel = await request(app)
      .post(`/deals/${one.id}/transition`)
      .set("Cookie", kadri.cookie)
      .send({ to: "CANCELLED" });
    const dispute = await request(app)
      .post(`/deals/${two.id}/transition`)
      .set("Cookie", kadri.cookie)
      .send({ to: "DISPUTED", note: "   " });

    expect(cancel.status).toBe(422);
    expect(dispute.status).toBe(422);
  });

  it("refuses fields the target has no use for", async () => {
    const deal = await dealAt("SHIPPED");

    const response = await request(app)
      .post(`/deals/${deal.id}/transition`)
      .set("Cookie", kadri.cookie)
      .send({ to: "DELIVERED", trackingNumber: "JP123456789" });

    // Sending it means believing something untrue about what this does.
    expect(response.status).toBe(422);
  });

  it("still refuses to agree a quote that does not exist", async () => {
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

    const response = await move(kadri, deal.id, "QUOTE_AGREED");

    // The precondition the table cannot express as data. #23 had it; making
    // the engine general must not lose it.
    expect(response.status).toBe(409);
  });
});

describe("every transition writes an event", () => {
  it("records where it came from, where it went and who did it", async () => {
    const deal = await dealAt("QUOTE_AGREED");

    await move(kadri, deal.id, "PRODUCT_PAID");

    const events = await prisma.dealEvent.findMany({
      orderBy: { createdAt: "asc" },
    });
    // One from #20 creating the deal, one from this.
    expect(events).toHaveLength(2);
    expect(events[1]?.fromStatus).toBe("QUOTE_AGREED");
    expect(events[1]?.toStatus).toBe("PRODUCT_PAID");
    expect(events[1]?.actorId).toBe(kadri.id);
  });

  it("keeps the reason on the event, where it can be read later", async () => {
    const deal = await dealAt("PURCHASED");

    await move(yuki, deal.id, "CANCELLED", {
      note: "The shop stopped stocking it",
    });

    const last = await prisma.dealEvent.findFirstOrThrow({
      orderBy: { createdAt: "desc" },
    });
    expect(last.note).toBe("The shop stopped stocking it");
  });

  it("logs every step of a whole deal, in order", async () => {
    const deal = await dealAt("MATCHED");

    await move(kadri, deal.id, "QUOTE_AGREED");
    await move(kadri, deal.id, "PRODUCT_PAID");
    await move(yuki, deal.id, "PURCHASED");
    await move(yuki, deal.id, "SHIPPED");
    await move(kadri, deal.id, "DELIVERED");
    const done = await move(kadri, deal.id, "COMPLETED");

    const events = await prisma.dealEvent.findMany({
      orderBy: { createdAt: "asc" },
    });
    expect(events.map((event) => event.toStatus)).toEqual([
      "MATCHED",
      "QUOTE_AGREED",
      "PRODUCT_PAID",
      "PURCHASED",
      "SHIPPED",
      "DELIVERED",
      "COMPLETED",
    ]);
    expect((done.body as DealBody).deal.status).toBe("COMPLETED");
  });

  it("lets the write decide, not the reading before it", async () => {
    const deal = await dealAt("QUOTE_AGREED");
    await move(kadri, deal.id, "PRODUCT_PAID");
    // Two people acting at the same moment both read the deal before either
    // writes: the requester cancels while the helper marks it bought, and both
    // believe the deal is still QUOTE_AGREED. Staging the stale read is the
    // only way to tell a guarded write from an unguarded one from outside.
    vi.spyOn(prisma.deal, "findUnique").mockResolvedValueOnce({
      ...deal,
      status: "QUOTE_AGREED",
      quotes: [],
    } as never);

    const late = await move(kadri, deal.id, "CANCELLED");
    vi.restoreAllMocks();

    // Only the write itself can settle it, so the status in the WHERE clause
    // is what refuses this — not the check above it.
    expect(late.status).toBe(409);
    const after = await prisma.deal.findUniqueOrThrow({
      where: { id: deal.id },
    });
    expect(after.status).toBe("PRODUCT_PAID");
    expect(await prisma.dealEvent.count()).toBe(2);
  });

  it("writes no event when the move is refused", async () => {
    const deal = await dealAt("QUOTE_AGREED");

    const wrongPerson = await move(yuki, deal.id, "PRODUCT_PAID");
    const wrongMove = await move(kadri, deal.id, "DELIVERED");

    // Pinned first, or an endpoint that refused everything with a 500 would
    // also leave no events and pass the rest of this test.
    expect(wrongPerson.status).toBe(403);
    expect(wrongMove.status).toBe(409);
    // Only #20's creation event.
    expect(await prisma.dealEvent.count()).toBe(1);
  });
});

describe("GET /deals/:id and GET /me/deals", () => {
  it("shows a deal to its two people, with its quotes and its history", async () => {
    const deal = await dealAt("QUOTE_AGREED");
    await move(kadri, deal.id, "PRODUCT_PAID");

    const asRequester = await request(app)
      .get(`/deals/${deal.id}`)
      .set("Cookie", kadri.cookie);
    const asHelper = await request(app)
      .get(`/deals/${deal.id}`)
      .set("Cookie", yuki.cookie);
    const body = asRequester.body as DealBody & {
      deal: { quotes: { productAmount: number }[] };
    };

    expect(asRequester.status).toBe(200);
    expect(asHelper.status).toBe(200);
    expect(body.deal.status).toBe("PRODUCT_PAID");
    expect(body.deal.quotes).toHaveLength(1);
    // An event log reads forwards, oldest first.
    expect(body.deal.events.map((event) => event.toStatus)).toEqual([
      "MATCHED",
      "PRODUCT_PAID",
    ]);
  });

  it("lets a moderator read it, and nobody else", async () => {
    const mo = await makeModerator();
    const deal = await dealAt("DISPUTED");

    const moderator = await request(app)
      .get(`/deals/${deal.id}`)
      .set("Cookie", mo.cookie);
    const stranger = await request(app)
      .get(`/deals/${deal.id}`)
      .set("Cookie", marek.cookie);

    // Judging a dispute means reading the deal it is about.
    expect(moderator.status).toBe(200);
    expect(stranger.status).toBe(404);
  });

  it("lists my deals from both sides, newest first", async () => {
    await dealAt("MATCHED");
    await dealAt("SHIPPED");

    const mine = await request(app)
      .get("/me/deals")
      .set("Cookie", kadri.cookie);
    const theirs = await request(app)
      .get("/me/deals")
      .set("Cookie", yuki.cookie);
    const strangers = await request(app)
      .get("/me/deals")
      .set("Cookie", marek.cookie);

    // Kadri requested both; Yuki is helping with both; Marek is in neither.
    expect((mine.body as { items: unknown[] }).items).toHaveLength(2);
    expect((theirs.body as { items: unknown[] }).items).toHaveLength(2);
    expect((strangers.body as { items: unknown[] }).items).toHaveLength(0);
  });

  it("filters by status", async () => {
    await dealAt("MATCHED");
    await dealAt("SHIPPED");

    const response = await request(app)
      .get("/me/deals")
      .query({ status: "SHIPPED" })
      .set("Cookie", kadri.cookie);
    const items = (response.body as { items: { status: string }[] }).items;

    expect(items).toHaveLength(1);
    expect(items[0]?.status).toBe("SHIPPED");
  });

  it("pages", async () => {
    // A deal that is none of Kadri's business, made first so it is the oldest.
    // If the cursor ever escapes the "mine" filter, this is the row that turns
    // up on her last page — the trap from #16, #18, #19 and #21.
    const outsiderNeed = await makeNeed({
      requesterId: marek.id,
      title: "Not Kadri's",
    });
    await request(app)
      .post(`/needs/${outsiderNeed.id}/proposals`)
      .set("Cookie", yuki.cookie)
      .send({});
    const outsiderProposal = await prisma.proposal.findFirstOrThrow({
      where: { needId: outsiderNeed.id },
    });
    await request(app)
      .post(`/proposals/${outsiderProposal.id}/accept`)
      .set("Cookie", marek.cookie)
      .send({});

    for (let i = 0; i < 3; i++) await dealAt("MATCHED");

    const first = await request(app)
      .get("/me/deals")
      .query({ limit: 2 })
      .set("Cookie", kadri.cookie);
    const firstBody = first.body as {
      items: { id: string }[];
      nextCursor: string | null;
    };
    const second = await request(app)
      .get("/me/deals")
      .query({ limit: 2, cursor: firstBody.nextCursor ?? "" })
      .set("Cookie", kadri.cookie);
    const secondBody = second.body as { items: { id: string }[] };

    expect(firstBody.items).toHaveLength(2);
    expect(secondBody.items).toHaveLength(1);
    const seen = firstBody.items.map((item) => item.id);
    expect(secondBody.items.some((item) => seen.includes(item.id))).toBe(false);
  });

  it("turns away someone not signed in", async () => {
    const deal = await dealAt("MATCHED");

    expect((await request(app).get(`/deals/${deal.id}`)).status).toBe(401);
    expect((await request(app).get("/me/deals")).status).toBe(401);
  });
});
