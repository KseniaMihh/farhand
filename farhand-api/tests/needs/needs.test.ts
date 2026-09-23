import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { prisma } from "../../src/db.js";
import { MAX_OPEN_NEEDS } from "../../src/services/needs.js";
import { signUpAndLogIn, signUpVerifiedAndLogIn } from "../helpers/auth.js";
import { createCategory, createDealFor, needBody } from "../helpers/needs.js";

/**
 * Needs: create, edit, delete — issue #15.
 *
 * These tests are the specification. They fail until the TODOs in
 * src/services/needs.ts are filled in.
 *
 *   npm run test:watch -- needs
 *
 * The issue asks for "tests for each permission rule", so each rule from
 * docs/02-roles-and-permissions.md gets its own test: who owns it, what state
 * it is in, and how many open needs the account already has.
 */
const app = createApp();

let categoryId = "";

beforeEach(async () => {
  categoryId = (await createCategory()).id;
});

function post(cookie: string, body: Record<string, unknown>) {
  return request(app).post("/needs").set("Cookie", cookie).send(body);
}

function patch(cookie: string, id: string, body: Record<string, unknown>) {
  return request(app).patch(`/needs/${id}`).set("Cookie", cookie).send(body);
}

function remove(cookie: string, id: string) {
  return request(app).delete(`/needs/${id}`).set("Cookie", cookie);
}

interface NeedBody {
  need: {
    id: string;
    requesterId: string;
    title: string;
    status: string;
    buyCountry: string;
    currency: string;
    estimatedPrice: number;
    thankYouAmount: number;
  };
}

/** Anna, verified and logged in — the state every need endpoint requires. */
async function anna() {
  return signUpVerifiedAndLogIn(app, "anna@example.com", "Anna");
}

/** Makes `count` open needs for whoever owns this cookie. */
async function openNeeds(cookie: string, count: number) {
  for (let i = 0; i < count; i++) {
    const response = await post(
      cookie,
      needBody(categoryId, { title: `Need ${String(i)}` }),
    );
    expect(response.status).toBe(201);
  }
}

describe("POST /needs — creating", () => {
  it("creates a need, open by default, owned by whoever asked", async () => {
    const user = await anna();

    const response = await post(user.cookie, needBody(categoryId));
    const body = response.body as NeedBody;

    expect(response.status).toBe(201);
    expect(body.need.status).toBe("OPEN");
    expect(body.need.requesterId).toBe(user.id);
    expect(body.need.title).toBe("Japanese sunscreen, 50 ml");
  });

  it("stores money as whole cents and countries in capitals", async () => {
    const user = await anna();

    const response = await post(
      user.cookie,
      needBody(categoryId, {
        buyCountry: "jp",
        currency: "eur",
        estimatedPrice: 2400,
        thankYouAmount: 500,
      }),
    );
    const body = response.body as NeedBody;

    expect(body.need.buyCountry).toBe("JP");
    expect(body.need.currency).toBe("EUR");
    expect(body.need.estimatedPrice).toBe(2400);
    expect(body.need.thankYouAmount).toBe(500);
  });

  it("can save a draft instead", async () => {
    const user = await anna();

    const response = await post(
      user.cookie,
      needBody(categoryId, { status: "DRAFT" }),
    );

    expect((response.body as NeedBody).need.status).toBe("DRAFT");
  });

  it("refuses a category that does not exist", async () => {
    const user = await anna();

    const response = await post(user.cookie, needBody("no-such-category-id"));

    expect(response.status).toBe(400);
  });

  it("refuses nonsense: no title, a price of zero, a bad country", async () => {
    const user = await anna();

    expect(
      (await post(user.cookie, needBody(categoryId, { title: "   " }))).status,
    ).toBe(422);
    expect(
      (await post(user.cookie, needBody(categoryId, { estimatedPrice: 0 })))
        .status,
    ).toBe(422);
    expect(
      (await post(user.cookie, needBody(categoryId, { estimatedPrice: 24.5 })))
        .status,
    ).toBe(422);
    expect(
      (await post(user.cookie, needBody(categoryId, { buyCountry: "Japan" })))
        .status,
    ).toBe(422);
    expect(
      (await post(user.cookie, needBody(categoryId, { currency: "€" }))).status,
    ).toBe(422);
  });

  it("refuses a status nobody may ask for directly", async () => {
    const user = await anna();

    // MATCHED is reached by accepting a proposal (#20), never by saying so.
    const response = await post(
      user.cookie,
      needBody(categoryId, { status: "MATCHED" }),
    );

    expect(response.status).toBe(422);
  });
});

describe("POST /needs — who may post at all", () => {
  it("turns away someone who is not logged in", async () => {
    const response = await request(app)
      .post("/needs")
      .send(needBody(categoryId));

    expect(response.status).toBe(401);
  });

  it("turns away someone who has not confirmed their email", async () => {
    const unverified = await signUpAndLogIn(app, "new@example.com");

    const response = await post(unverified.cookie, needBody(categoryId));

    // docs/02-roles-and-permissions.md: an unconfirmed user may sign in, but
    // may not post.
    expect(response.status).toBe(403);
  });

  it("turns away a suspended user", async () => {
    const user = await anna();
    await prisma.user.update({
      where: { id: user.id },
      data: { status: "SUSPENDED" },
    });

    const response = await post(user.cookie, needBody(categoryId));

    expect(response.status).toBe(403);
  });
});

describe("POST /needs — the limit on open needs", () => {
  it(`refuses the need after ${String(MAX_OPEN_NEEDS)} open ones`, async () => {
    const user = await anna();
    await openNeeds(user.cookie, MAX_OPEN_NEEDS);

    const response = await post(user.cookie, needBody(categoryId));

    // 409, not 422: the request is fine, the account's state is the problem.
    expect(response.status).toBe(409);
  });

  it("does not count drafts, which nobody can see", async () => {
    const user = await anna();
    for (let i = 0; i < MAX_OPEN_NEEDS + 3; i++) {
      await post(user.cookie, needBody(categoryId, { status: "DRAFT" }));
    }

    const response = await post(user.cookie, needBody(categoryId));

    expect(response.status).toBe(201);
  });

  it("frees a place when one is taken down", async () => {
    const user = await anna();
    await openNeeds(user.cookie, MAX_OPEN_NEEDS);
    const first = await prisma.need.findFirstOrThrow();

    await remove(user.cookie, first.id);

    expect((await post(user.cookie, needBody(categoryId))).status).toBe(201);
  });

  it("counts each account separately", async () => {
    const user = await anna();
    await openNeeds(user.cookie, MAX_OPEN_NEEDS);
    const bob = await signUpVerifiedAndLogIn(app, "bob@example.com", "Bob");

    const response = await post(bob.cookie, needBody(categoryId));

    expect(response.status).toBe(201);
  });
});

describe("PATCH /needs/:id — editing", () => {
  it("lets the owner change their need", async () => {
    const user = await anna();
    const created = (await post(user.cookie, needBody(categoryId)))
      .body as NeedBody;

    const response = await patch(user.cookie, created.need.id, {
      title: "Japanese sunscreen, 100 ml",
      estimatedPrice: 3000,
    });
    const body = response.body as NeedBody;

    expect(response.status).toBe(200);
    expect(body.need.title).toBe("Japanese sunscreen, 100 ml");
    expect(body.need.estimatedPrice).toBe(3000);
  });

  it("refuses someone else's need, and changes nothing", async () => {
    const user = await anna();
    const created = (await post(user.cookie, needBody(categoryId)))
      .body as NeedBody;
    const bob = await signUpVerifiedAndLogIn(app, "bob@example.com", "Bob");

    const response = await patch(bob.cookie, created.need.id, {
      title: "Bob was here",
    });

    expect(response.status).toBe(403);
    const unchanged = await prisma.need.findUniqueOrThrow({
      where: { id: created.need.id },
    });
    expect(unchanged.title).toBe("Japanese sunscreen, 50 ml");
  });

  it("answers 404 for a need that does not exist", async () => {
    const user = await anna();

    const response = await patch(user.cookie, "no-such-need", { title: "x" });

    expect(response.status).toBe(404);
  });

  it("refuses once the need is matched, because a deal depends on it", async () => {
    const user = await anna();
    const created = (await post(user.cookie, needBody(categoryId)))
      .body as NeedBody;
    await prisma.need.update({
      where: { id: created.need.id },
      data: { status: "MATCHED" },
    });

    const response = await patch(user.cookie, created.need.id, {
      title: "Something else entirely",
    });

    expect(response.status).toBe(409);
  });

  it("lets a draft be published", async () => {
    const user = await anna();
    const draft = (
      await post(user.cookie, needBody(categoryId, { status: "DRAFT" }))
    ).body as NeedBody;

    const response = await patch(user.cookie, draft.need.id, {
      status: "OPEN",
    });

    expect(response.status).toBe(200);
    expect((response.body as NeedBody).need.status).toBe("OPEN");
  });

  it("counts publishing a draft against the limit", async () => {
    const user = await anna();
    const draft = (
      await post(user.cookie, needBody(categoryId, { status: "DRAFT" }))
    ).body as NeedBody;
    await openNeeds(user.cookie, MAX_OPEN_NEEDS);

    const response = await patch(user.cookie, draft.need.id, {
      status: "OPEN",
    });

    // Otherwise the limit is trivially avoided: save drafts, publish them all.
    expect(response.status).toBe(409);
  });
});

describe("DELETE /needs/:id — taking a need down", () => {
  it("closes the need rather than erasing it", async () => {
    const user = await anna();
    const created = (await post(user.cookie, needBody(categoryId)))
      .body as NeedBody;

    const response = await remove(user.cookie, created.need.id);

    expect(response.status).toBe(204);
    // Soft deletion: proposals and messages point here, and that history has
    // to survive (docs/05-data-model.md).
    const still = await prisma.need.findUniqueOrThrow({
      where: { id: created.need.id },
    });
    expect(still.status).toBe("CLOSED");
  });

  it("does not mind being asked twice", async () => {
    const user = await anna();
    const created = (await post(user.cookie, needBody(categoryId)))
      .body as NeedBody;
    await remove(user.cookie, created.need.id);

    const second = await remove(user.cookie, created.need.id);

    expect(second.status).toBe(204);
  });

  it("refuses someone else's need", async () => {
    const user = await anna();
    const created = (await post(user.cookie, needBody(categoryId)))
      .body as NeedBody;
    const bob = await signUpVerifiedAndLogIn(app, "bob@example.com", "Bob");

    const response = await remove(bob.cookie, created.need.id);

    expect(response.status).toBe(403);
    const still = await prisma.need.findUniqueOrThrow({
      where: { id: created.need.id },
    });
    expect(still.status).toBe("OPEN");
  });

  it("answers 404 for a need that does not exist", async () => {
    const user = await anna();

    const response = await remove(user.cookie, "no-such-need");

    expect(response.status).toBe(404);
  });

  it("refuses while someone is shopping for it", async () => {
    const user = await anna();
    const created = (await post(user.cookie, needBody(categoryId)))
      .body as NeedBody;
    const need = await prisma.need.findUniqueOrThrow({
      where: { id: created.need.id },
    });
    const bob = await signUpVerifiedAndLogIn(app, "bob@example.com", "Bob");
    await createDealFor(need, bob.id, "MATCHED");

    const response = await remove(user.cookie, created.need.id);

    expect(response.status).toBe(409);
  });

  it("allows it again once that deal is cancelled", async () => {
    const user = await anna();
    const created = (await post(user.cookie, needBody(categoryId)))
      .body as NeedBody;
    const need = await prisma.need.findUniqueOrThrow({
      where: { id: created.need.id },
    });
    const bob = await signUpVerifiedAndLogIn(app, "bob@example.com", "Bob");
    await createDealFor(need, bob.id, "CANCELLED");

    const response = await remove(user.cookie, created.need.id);

    // "Live" means any deal that is not cancelled — the same definition the
    // database's one_active_deal_per_need index uses.
    expect(response.status).toBe(204);
  });
});
