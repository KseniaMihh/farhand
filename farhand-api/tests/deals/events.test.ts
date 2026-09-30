import type { Deal, DealStatus, Need } from "@prisma/client";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/app.js";
import { prisma } from "../../src/db.js";
import { logger } from "../../src/logger.js";
import {
  signUpAndLogIn,
  signUpVerifiedAndLogIn,
  type TestUser,
} from "../helpers/auth.js";
import { createCategory } from "../helpers/needs.js";
import { withoutRequestId } from "../helpers/http.js";

/**
 * `GET /deals/:id/events` — issue #67.
 *
 * These tests are the specification. They fail until the TODOs in
 * src/services/deals.ts are filled in.
 *
 *   npm run test:watch -- events
 *
 * The endpoint the contract has promised since the first week and nobody built.
 * What makes it worth having rather than a second copy of the log already inside
 * `GET /deals/:id` is one field: `actor` is a name here, not an id.
 */
const app = createApp();

interface EventsBody {
  items: {
    id: string;
    fromStatus: string | null;
    toStatus: string;
    note: string | null;
    createdAt: string;
    actor: { id: string; displayName: string } | null;
  }[];
  nextCursor: string | null;
}

interface DealBody {
  deal: { events: { toStatus: string }[] };
}

interface ErrorBody {
  error: { code: string; message: string };
}

let kadri: TestUser = { id: "", email: "", cookie: "" };
let yuki: TestUser = { id: "", email: "", cookie: "" };
let stranger: TestUser = { id: "", email: "", cookie: "" };
let mo: TestUser = { id: "", email: "", cookie: "" };
let categoryId = "";

beforeEach(async () => {
  categoryId = (await createCategory("electronics")).id;
  kadri = await signUpVerifiedAndLogIn(app, "kadri@example.com", "Kadri");
  yuki = await signUpVerifiedAndLogIn(app, "yuki@example.com", "Yuki");
  stranger = await signUpVerifiedAndLogIn(app, "nosy@example.com", "Nosy");
  mo = await signUpVerifiedAndLogIn(app, "mo@example.com", "Mo");
  await prisma.user.update({
    where: { id: mo.id },
    data: { role: "MODERATOR" },
  });
});

/** A need of Kadri's. */
async function makeNeed(): Promise<Need> {
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
    },
  });
}

/**
 * A deal between Kadri and Yuki, made through the real endpoints so that its
 * first event is the one acceptance really writes (#20).
 */
async function makeDeal(): Promise<Deal> {
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

/** Adds an event straight to the database, to control who and when. */
async function addEvent(
  dealId: string,
  toStatus: DealStatus,
  actorId: string | null,
  note: string | null = null,
) {
  return prisma.dealEvent.create({
    data: { dealId, toStatus, actorId, note },
  });
}

function read(user: TestUser, dealId: string, query = "") {
  return request(app)
    .get(`/deals/${dealId}/events${query}`)
    .set("Cookie", user.cookie);
}

/** The log lines this endpoint writes, ignoring pino's own request lines. */
function moderatorLines(calls: unknown[][]) {
  return calls.filter(
    (call) => typeof call[1] === "string" && call[1].includes("moderator"),
  );
}

describe("GET /deals/:id/events", () => {
  describe("who may read it", () => {
    it.each(["requester", "helper"] as const)(
      "lets the %s read",
      async (who) => {
        const deal = await makeDeal();

        const response = await read(
          who === "requester" ? kadri : yuki,
          deal.id,
        );

        expect(response.status).toBe(200);
        expect((response.body as EventsBody).items.length).toBeGreaterThan(0);
      },
    );

    it("lets a moderator read", async () => {
      const deal = await makeDeal();

      const response = await read(mo, deal.id);

      expect(response.status).toBe(200);
    });

    /**
     * 404 rather than 403, and the same 404 as a deal that does not exist:
     * telling a stranger that a deal is there is the leak
     * (docs/06-api-contract.md, "a deal is private to its two people").
     */
    it("answers a stranger exactly as it answers a wrong id", async () => {
      const deal = await makeDeal();

      const refused = await read(stranger, deal.id);
      const missing = await read(stranger, "cm0000000000000000000000");

      expect(refused.status).toBe(404);
      expect(missing.status).toBe(404);
      expect(withoutRequestId(refused.body)).toEqual(
        withoutRequestId(missing.body),
      );
    });

    it("refuses a request with no session", async () => {
      const deal = await makeDeal();

      const response = await request(app).get(`/deals/${deal.id}/events`);

      expect(response.status).toBe(401);
    });

    it("refuses an unverified account", async () => {
      const deal = await makeDeal();
      const unverified = await signUpAndLogIn(app, "new@example.com");

      const response = await read(unverified, deal.id);

      expect(response.status).toBe(403);
    });

    it("refuses a suspended participant", async () => {
      const deal = await makeDeal();
      await prisma.user.update({
        where: { id: kadri.id },
        data: { status: "SUSPENDED", suspendedUntil: null },
      });

      const response = await read(kadri, deal.id);

      expect(response.status).toBe(403);
    });
  });

  describe("what it returns", () => {
    it("reads forwards: oldest first", async () => {
      const deal = await makeDeal();
      await addEvent(deal.id, "QUOTE_AGREED", kadri.id);
      await addEvent(deal.id, "PRODUCT_PAID", kadri.id);

      const body = (await read(kadri, deal.id)).body as EventsBody;

      expect(body.items.map((e) => e.toStatus)).toEqual([
        "MATCHED",
        "QUOTE_AGREED",
        "PRODUCT_PAID",
      ]);
    });

    /** The whole reason this endpoint exists rather than reusing the deal read. */
    it("names who did each step", async () => {
      const deal = await makeDeal();
      await addEvent(deal.id, "PURCHASED", yuki.id);

      const body = (await read(kadri, deal.id)).body as EventsBody;
      const purchased = body.items.find((e) => e.toStatus === "PURCHASED");

      expect(purchased?.actor).toEqual({ id: yuki.id, displayName: "Yuki" });
    });

    /**
     * Nothing did this on purpose: the sweep completes a deal fourteen days
     * after delivery and writes an event with no actor (#25). A client has to
     * render that, so it is pinned.
     */
    it("reports a system event as having no actor", async () => {
      const deal = await makeDeal();
      await addEvent(
        deal.id,
        "COMPLETED",
        null,
        "Completed automatically after 14 days",
      );

      const body = (await read(kadri, deal.id)).body as EventsBody;
      const completed = body.items.find((e) => e.toStatus === "COMPLETED");

      expect(completed?.actor).toBeNull();
      expect(completed?.note).toBe("Completed automatically after 14 days");
    });

    /**
     * Registration creates a user and their profile in one transaction (#10),
     * so an actor without a profile cannot happen. The service decides what to
     * do anyway, and the decision is "a missing profile is not a reason to lose
     * who acted" — a history that silently forgets its actor is worse than one
     * naming somebody we cannot label. Untested, that decision is just a
     * plausible-looking `??` somebody will tidy into an empty string.
     */
    it("keeps the actor even when the name cannot be found", async () => {
      const deal = await makeDeal();
      const nameless = await prisma.user.create({
        data: { email: "nameless@example.com", passwordHash: "x" },
      });
      await addEvent(deal.id, "CANCELLED", nameless.id);

      const body = (await read(kadri, deal.id)).body as EventsBody;
      const cancelled = body.items.find((e) => e.toStatus === "CANCELLED");

      expect(cancelled?.actor?.id).toBe(nameless.id);
      expect(cancelled?.actor?.displayName).toBeTruthy();
    });

    it("carries each event's own fields", async () => {
      const deal = await makeDeal();

      const body = (await read(kadri, deal.id)).body as EventsBody;
      const first = body.items[0];

      expect(Object.keys(first ?? {}).sort()).toEqual([
        "actor",
        "createdAt",
        "fromStatus",
        "id",
        "note",
        "toStatus",
      ]);
    });

    it("never leaks an actor's email address", async () => {
      const deal = await makeDeal();
      await addEvent(deal.id, "PURCHASED", yuki.id);

      const response = await read(kadri, deal.id);

      expect(JSON.stringify(response.body)).not.toContain("yuki@example.com");
    });

    it("shows nothing about another deal", async () => {
      const mine = await makeDeal();
      const other = await makeDeal();
      await addEvent(other.id, "PURCHASED", yuki.id);

      const body = (await read(kadri, mine.id)).body as EventsBody;

      expect(body.items.every((e) => e.toStatus === "MATCHED")).toBe(true);
    });
  });

  describe("paging", () => {
    it("pages forwards with no overlap and nothing skipped", async () => {
      const deal = await makeDeal();
      await addEvent(deal.id, "QUOTE_AGREED", kadri.id);
      await addEvent(deal.id, "PRODUCT_PAID", kadri.id);
      await addEvent(deal.id, "PURCHASED", yuki.id);

      const first = (await read(kadri, deal.id, "?limit=2")).body as EventsBody;
      expect(first.items).toHaveLength(2);
      expect(first.nextCursor).not.toBeNull();

      const second = (
        await read(kadri, deal.id, `?limit=2&cursor=${first.nextCursor ?? ""}`)
      ).body as EventsBody;

      expect(first.items.map((e) => e.toStatus)).toEqual([
        "MATCHED",
        "QUOTE_AGREED",
      ]);
      expect(second.items.map((e) => e.toStatus)).toEqual([
        "PRODUCT_PAID",
        "PURCHASED",
      ]);
      expect(second.nextCursor).toBeNull();
    });

    it.each(["?limit=0", "?limit=51", "?limit=abc", "?cursor=not-a-cursor"])(
      "refuses %s",
      async (query) => {
        const deal = await makeDeal();

        const response = await read(kadri, deal.id, query);

        expect(response.status).toBe(422);
        expect((response.body as ErrorBody).error.code).toBe(
          "VALIDATION_FAILED",
        );
      },
    );
  });

  describe("what gets written down", () => {
    /**
     * Reading is not a decision, so it writes no AdminAction — but a power that
     * leaves no trace is one nobody can ask about afterwards. The same rule as a
     * moderator opening a conversation (#27).
     */
    it("records that a moderator looked", async () => {
      const deal = await makeDeal();
      const written = vi.spyOn(logger, "info");

      await read(mo, deal.id);
      const lines = moderatorLines(written.mock.calls);
      written.mockRestore();

      expect(lines).toHaveLength(1);
      expect(lines[0]?.[0]).toMatchObject({
        moderatorId: mo.id,
        dealId: deal.id,
      });
    });

    it("says nothing when the deal's own people read it", async () => {
      const deal = await makeDeal();
      const written = vi.spyOn(logger, "info");

      await read(kadri, deal.id);
      await read(yuki, deal.id);
      const lines = moderatorLines(written.mock.calls);
      written.mockRestore();

      expect(lines).toHaveLength(0);
    });

    /**
     * `GET /deals/:id` has let moderators in since #27 and recorded nothing.
     * Two reads of the same private thing should not differ in whether anybody
     * can find out they happened.
     */
    it("records a moderator reading the deal itself, too", async () => {
      const deal = await makeDeal();
      const written = vi.spyOn(logger, "info");

      await request(app).get(`/deals/${deal.id}`).set("Cookie", mo.cookie);
      const lines = moderatorLines(written.mock.calls);
      written.mockRestore();

      expect(lines).toHaveLength(1);
      expect(lines[0]?.[0]).toMatchObject({ moderatorId: mo.id });
    });

    it("still lets the deal's own people read the deal silently", async () => {
      const deal = await makeDeal();
      const written = vi.spyOn(logger, "info");

      const response = await request(app)
        .get(`/deals/${deal.id}`)
        .set("Cookie", kadri.cookie);
      const lines = moderatorLines(written.mock.calls);
      written.mockRestore();

      expect(response.status).toBe(200);
      expect(lines).toHaveLength(0);
    });
  });

  /** The deal read was changed to add the log line; it still answers the same. */
  it("leaves the embedded event log on GET /deals/:id alone", async () => {
    const deal = await makeDeal();
    await addEvent(deal.id, "QUOTE_AGREED", kadri.id);

    const response = await request(app)
      .get(`/deals/${deal.id}`)
      .set("Cookie", kadri.cookie);

    expect(response.status).toBe(200);
    expect(
      (response.body as DealBody).deal.events.map((e) => e.toStatus),
    ).toEqual(["MATCHED", "QUOTE_AGREED"]);
  });
});
