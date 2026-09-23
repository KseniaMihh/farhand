import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { prisma } from "../../src/db.js";
import { MAX_HELP_CATEGORIES } from "../../src/services/helps.js";
import { signUpAndLogIn, signUpVerifiedAndLogIn } from "../helpers/auth.js";
import { createCategory } from "../helpers/needs.js";

/**
 * Helps: create, edit, delete — issue #17.
 *
 * These tests are the specification. They fail until the TODOs in
 * src/services/helps.ts are filled in.
 *
 *   npm run test:watch -- helps
 */
const app = createApp();

let electronics = "";
let cosmetics = "";

beforeEach(async () => {
  electronics = (await createCategory("electronics")).id;
  cosmetics = (await createCategory("cosmetics")).id;
});

function helpBody(overrides: Record<string, unknown> = {}) {
  return {
    country: "JP",
    shipsTo: ["EE", "FI"],
    description: "I live in Tokyo and post to the Baltics every other week.",
    categoryIds: [electronics],
    ...overrides,
  };
}

function post(cookie: string, body: Record<string, unknown>) {
  return request(app).post("/helps").set("Cookie", cookie).send(body);
}

function patch(cookie: string, id: string, body: Record<string, unknown>) {
  return request(app).patch(`/helps/${id}`).set("Cookie", cookie).send(body);
}

function remove(cookie: string, id: string) {
  return request(app).delete(`/helps/${id}`).set("Cookie", cookie);
}

interface HelpBody {
  help: {
    id: string;
    helperId: string;
    country: string;
    shipsTo: string[];
    description: string;
    status: string;
    categories: { id: string; slug: string }[];
  };
}

async function helper(email = "helper@example.com") {
  return signUpVerifiedAndLogIn(app, email, "Yuki");
}

describe("POST /helps — posting an offer", () => {
  it("creates an offer owned by whoever asked, active by default", async () => {
    const user = await helper();

    const response = await post(user.cookie, helpBody());
    const body = response.body as HelpBody;

    expect(response.status).toBe(201);
    expect(body.help.helperId).toBe(user.id);
    expect(body.help.status).toBe("ACTIVE");
    expect(body.help.country).toBe("JP");
  });

  it("attaches the categories it was given", async () => {
    const user = await helper();

    const response = await post(
      user.cookie,
      helpBody({ categoryIds: [electronics, cosmetics] }),
    );
    const body = response.body as HelpBody;

    // Many-to-many: a helper shops across several categories.
    expect(body.help.categories.map((c) => c.id).sort()).toEqual(
      [electronics, cosmetics].sort(),
    );
  });

  it("upper-cases the countries and drops duplicates", async () => {
    const user = await helper();

    const response = await post(
      user.cookie,
      helpBody({ country: "jp", shipsTo: ["ee", "EE", "fi"] }),
    );
    const body = response.body as HelpBody;

    expect(body.help.country).toBe("JP");
    expect(body.help.shipsTo).toEqual(["EE", "FI"]);
  });

  it("takes an empty shipsTo to mean anywhere", async () => {
    const user = await helper();

    const response = await post(user.cookie, helpBody({ shipsTo: [] }));
    const body = response.body as HelpBody;

    // Empty is a real answer, not a missing one: prisma/schema.prisma says so,
    // and #18's filter depends on it.
    expect(response.status).toBe(201);
    expect(body.help.shipsTo).toEqual([]);
  });

  it("defaults shipsTo to anywhere when it is left out entirely", async () => {
    const user = await helper();
    const { shipsTo: _omitted, ...withoutShipsTo } = helpBody();

    const response = await post(user.cookie, withoutShipsTo);

    expect(response.status).toBe(201);
    expect((response.body as HelpBody).help.shipsTo).toEqual([]);
  });

  it("refuses a category that does not exist", async () => {
    const user = await helper();

    const response = await post(
      user.cookie,
      helpBody({ categoryIds: ["no-such-category"] }),
    );

    expect(response.status).toBe(400);
  });

  it("refuses nonsense: no description, no category, a bad country code", async () => {
    const user = await helper();

    expect(
      (await post(user.cookie, helpBody({ description: "  " }))).status,
    ).toBe(422);
    expect(
      (await post(user.cookie, helpBody({ categoryIds: [] }))).status,
    ).toBe(422);
    expect(
      (await post(user.cookie, helpBody({ country: "Japan" }))).status,
    ).toBe(422);
    expect(
      (await post(user.cookie, helpBody({ shipsTo: ["Estonia"] }))).status,
    ).toBe(422);
    expect(
      (
        await post(
          user.cookie,
          helpBody({
            categoryIds: Array.from(
              { length: MAX_HELP_CATEGORIES + 1 },
              () => electronics,
            ),
          }),
        )
      ).status,
    ).toBe(422);
  });

  it("refuses a status nobody may ask for directly", async () => {
    const user = await helper();

    const response = await post(user.cookie, helpBody({ status: "REMOVED" }));

    expect(response.status).toBe(422);
  });
});

describe("POST /helps — who may post at all", () => {
  it("turns away someone who is not logged in", async () => {
    const response = await request(app).post("/helps").send(helpBody());

    expect(response.status).toBe(401);
  });

  it("turns away someone who has not confirmed their email", async () => {
    const unverified = await signUpAndLogIn(app, "new@example.com");

    const response = await post(unverified.cookie, helpBody());

    expect(response.status).toBe(403);
  });

  it("turns away a suspended user", async () => {
    const user = await helper();
    await prisma.user.update({
      where: { id: user.id },
      data: { status: "SUSPENDED" },
    });

    const response = await post(user.cookie, helpBody());

    expect(response.status).toBe(403);
  });
});

describe("PATCH /helps/:id — editing", () => {
  it("lets the owner change the description and the countries", async () => {
    const user = await helper();
    const created = (await post(user.cookie, helpBody())).body as HelpBody;

    const response = await patch(user.cookie, created.help.id, {
      description: "Now posting monthly.",
      shipsTo: ["EE"],
    });
    const body = response.body as HelpBody;

    expect(response.status).toBe(200);
    expect(body.help.description).toBe("Now posting monthly.");
    expect(body.help.shipsTo).toEqual(["EE"]);
  });

  it("replaces the categories rather than adding to them", async () => {
    const user = await helper();
    const created = (
      await post(user.cookie, helpBody({ categoryIds: [electronics] }))
    ).body as HelpBody;

    const response = await patch(user.cookie, created.help.id, {
      categoryIds: [cosmetics],
    });
    const body = response.body as HelpBody;

    // A PATCH says what the list IS now, not what to add to it.
    expect(body.help.categories.map((c) => c.id)).toEqual([cosmetics]);
  });

  it("leaves the categories alone when the field is not mentioned", async () => {
    const user = await helper();
    const created = (
      await post(user.cookie, helpBody({ categoryIds: [electronics] }))
    ).body as HelpBody;

    const response = await patch(user.cookie, created.help.id, {
      description: "Only the text changed.",
    });

    expect(
      (response.body as HelpBody).help.categories.map((c) => c.id),
    ).toEqual([electronics]);
  });

  it("can pause an offer and start it again", async () => {
    const user = await helper();
    const created = (await post(user.cookie, helpBody())).body as HelpBody;

    const paused = await patch(user.cookie, created.help.id, {
      status: "PAUSED",
    });
    const resumed = await patch(user.cookie, created.help.id, {
      status: "ACTIVE",
    });

    expect((paused.body as HelpBody).help.status).toBe("PAUSED");
    expect((resumed.body as HelpBody).help.status).toBe("ACTIVE");
  });

  it("refuses someone else's offer, and changes nothing", async () => {
    const user = await helper();
    const created = (await post(user.cookie, helpBody())).body as HelpBody;
    const other = await helper("other@example.com");

    const response = await patch(other.cookie, created.help.id, {
      description: "Hijacked",
    });

    expect(response.status).toBe(403);
    const unchanged = await prisma.help.findUniqueOrThrow({
      where: { id: created.help.id },
    });
    expect(unchanged.description).not.toBe("Hijacked");
  });

  it("answers 404 for an offer that does not exist", async () => {
    const user = await helper();

    const response = await patch(user.cookie, "no-such-help", {
      description: "x",
    });

    expect(response.status).toBe(404);
  });

  it("refuses to edit an offer that has been taken down", async () => {
    const user = await helper();
    const created = (await post(user.cookie, helpBody())).body as HelpBody;
    await remove(user.cookie, created.help.id);

    const response = await patch(user.cookie, created.help.id, {
      description: "Back again",
    });

    expect(response.status).toBe(409);
  });

  it("refuses a category that does not exist", async () => {
    const user = await helper();
    const created = (await post(user.cookie, helpBody())).body as HelpBody;

    const response = await patch(user.cookie, created.help.id, {
      categoryIds: ["no-such-category"],
    });

    expect(response.status).toBe(400);
  });
});

describe("DELETE /helps/:id — taking an offer down", () => {
  it("marks it removed rather than erasing it", async () => {
    const user = await helper();
    const created = (await post(user.cookie, helpBody())).body as HelpBody;

    const response = await remove(user.cookie, created.help.id);

    expect(response.status).toBe(204);
    const still = await prisma.help.findUniqueOrThrow({
      where: { id: created.help.id },
    });
    expect(still.status).toBe("REMOVED");
  });

  it("keeps the proposals that point at it", async () => {
    const user = await helper();
    const created = (await post(user.cookie, helpBody())).body as HelpBody;
    const requester = await signUpVerifiedAndLogIn(app, "anna@example.com");
    const need = await prisma.need.create({
      data: {
        requesterId: requester.id,
        categoryId: electronics,
        title: "Kindle",
        description: "Any colour",
        buyCountry: "JP",
        deliverCountry: "EE",
        currency: "EUR",
        estimatedPrice: 12000,
      },
    });
    await prisma.proposal.create({
      data: {
        needId: need.id,
        helperId: user.id,
        helpId: created.help.id,
        initiatedBy: "REQUESTER",
      },
    });

    await remove(user.cookie, created.help.id);

    // The whole reason for a soft delete: somebody's conversation still
    // points here.
    expect(
      await prisma.proposal.count({ where: { helpId: created.help.id } }),
    ).toBe(1);
  });

  it("does not mind being asked twice", async () => {
    const user = await helper();
    const created = (await post(user.cookie, helpBody())).body as HelpBody;
    await remove(user.cookie, created.help.id);

    const second = await remove(user.cookie, created.help.id);

    expect(second.status).toBe(204);
  });

  it("refuses someone else's offer", async () => {
    const user = await helper();
    const created = (await post(user.cookie, helpBody())).body as HelpBody;
    const other = await helper("other@example.com");

    const response = await remove(other.cookie, created.help.id);

    expect(response.status).toBe(403);
    const still = await prisma.help.findUniqueOrThrow({
      where: { id: created.help.id },
    });
    expect(still.status).toBe("ACTIVE");
  });

  it("answers 404 for an offer that does not exist", async () => {
    const user = await helper();

    const response = await remove(user.cookie, "no-such-help");

    expect(response.status).toBe(404);
  });
});
