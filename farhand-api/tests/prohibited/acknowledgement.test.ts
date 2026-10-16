import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { prisma } from "../../src/db.js";
import { signUpVerifiedAndLogIn } from "../helpers/auth.js";
import type { TestUser } from "../helpers/auth.js";
import { createCategory } from "../helpers/needs.js";

/**
 * The prohibited-items acknowledgement — issue #87.
 *
 * These tests are the specification. They fail until the TODOs in
 * src/services/prohibited.ts are filled in.
 *
 *   npm run test:watch -- prohibited
 *
 * docs/07-trust-and-safety.md puts this first among the defences against
 * prohibited or illegal items, ahead of reports and moderation — because those
 * two happen after something has been posted, and this is the only one that
 * happens before.
 *
 * Three things are being tested, and the third is where the work is:
 *
 *   1. the list can be read, and it has a version
 *   2. a tick is recorded with the version it was given for
 *   3. **the tick cannot be avoided**, including by the route nobody thinks
 *      about: save a draft with no tick, then publish the draft
 */
const app = createApp();

let categoryId = "";
let kadri: TestUser;

beforeEach(async () => {
  categoryId = (await createCategory()).id;
  kadri = await signUpVerifiedAndLogIn(app, "kadri@example.com", "Kadri");
  await prisma.prohibitedItem.deleteMany({});
  await prisma.prohibitedItem.createMany({
    data: [
      { slug: "weapons", text: "Weapons, ammunition and parts", position: 1 },
      {
        slug: "drugs",
        text: "Drugs, including prescription medicines",
        position: 2,
      },
      { slug: "animals", text: "Live animals", position: 3 },
    ],
  });
});

/** The list as a client would read it before showing the form. */
async function readList(): Promise<{ version: string; items: unknown[] }> {
  const response = await request(app).get("/prohibited-items");

  expect(response.status).toBe(200);
  return response.body as { version: string; items: unknown[] };
}

const NEED = {
  title: "Japanese sunscreen",
  description: "The one not sold in Europe",
  buyCountry: "JP",
  deliverCountry: "EE",
  currency: "EUR",
  estimatedPrice: 2400,
};

function postNeed(body: object) {
  return request(app)
    .post("/needs")
    .set("Cookie", kadri.cookie)
    .send({ ...NEED, categoryId, ...body });
}

function patchNeed(id: string, body: object) {
  return request(app)
    .patch(`/needs/${id}`)
    .set("Cookie", kadri.cookie)
    .send(body);
}

const HELP = {
  country: "JP",
  description: "I live in Tokyo and can buy most things",
  shipsTo: ["EE"],
};

function postHelp(body: object) {
  return request(app)
    .post("/helps")
    .set("Cookie", kadri.cookie)
    .send({ ...HELP, categoryIds: [categoryId], ...body });
}

describe("reading the list", () => {
  it("is public, because somebody has to read it before signing up", async () => {
    const { version, items } = await readList();

    expect(items).toHaveLength(3);
    expect(items[0]).toEqual({
      slug: "weapons",
      text: "Weapons, ammunition and parts",
    });
    // A version that identifies this exact wording. Short enough to put in a
    // request body and in a column.
    expect(version).toMatch(/^[0-9a-f]{16}$/);
  });

  it("shows retired lines to nobody, and keeps their order", async () => {
    await prisma.prohibitedItem.update({
      where: { slug: "drugs" },
      data: { retiredAt: new Date() },
    });

    const { items } = await readList();

    expect(items).toEqual([
      { slug: "weapons", text: "Weapons, ammunition and parts" },
      { slug: "animals", text: "Live animals" },
    ]);
  });

  it("changes its version when the wording changes, and not otherwise", async () => {
    const first = (await readList()).version;

    // Read twice, unchanged: a version that moved on its own would make every
    // posting a 409 and the whole mechanism unusable.
    expect((await readList()).version).toBe(first);

    await prisma.prohibitedItem.update({
      where: { slug: "weapons" },
      data: { text: "Weapons, ammunition, parts and replicas" },
    });

    expect((await readList()).version).not.toBe(first);
  });

  it("changes its version when a line is retired or added", async () => {
    const first = (await readList()).version;

    await prisma.prohibitedItem.update({
      where: { slug: "animals" },
      data: { retiredAt: new Date() },
    });
    const afterRetiring = (await readList()).version;
    expect(afterRetiring).not.toBe(first);

    await prisma.prohibitedItem.create({
      data: { slug: "alcohol", text: "Alcohol and tobacco", position: 4 },
    });
    expect((await readList()).version).not.toBe(afterRetiring);
  });
});

describe("posting a need", () => {
  it("records the tick, with the version it was given for", async () => {
    const { version } = await readList();

    const response = await postNeed({ prohibitedVersion: version });

    expect(response.status).toBe(201);
    const need = await prisma.need.findFirstOrThrow();
    expect(need.prohibitedVersion).toBe(version);
    expect(need.prohibitedAckAt).toBeInstanceOf(Date);
  });

  it("refuses a request that simply does not send it", async () => {
    const response = await postNeed({});

    // THE CRITERION: a client that omits the field must not get past. A
    // boolean that defaults to true is not an acknowledgement, it is a
    // formality the server fills in on your behalf.
    expect(response.status).toBe(422);
    const body = response.body as {
      error: { details?: { field: string }[] };
    };
    expect(body.error.details?.map((d) => d.field)).toContain(
      "prohibitedVersion",
    );
    expect(await prisma.need.count()).toBe(0);
  });

  it("refuses a version that is not the current one", async () => {
    const response = await postNeed({ prohibitedVersion: "0".repeat(16) });

    expect(response.status).toBe(409);
    const body = response.body as {
      error: { code: string; details?: { version: string; items: unknown[] } };
    };
    expect(body.error.code).toBe("PROHIBITED_LIST_CHANGED");
    // The answer carries the current list, so a client can show what changed
    // and ask again rather than guessing what it missed.
    expect(body.error.details?.version).toMatch(/^[0-9a-f]{16}$/);
    expect(body.error.details?.items).toHaveLength(3);
    expect(await prisma.need.count()).toBe(0);
  });

  it("refuses the version it was given a moment too late", async () => {
    const { version } = await readList();
    // The list is reworded while somebody is filling in the form.
    await prisma.prohibitedItem.update({
      where: { slug: "drugs" },
      data: { text: "Drugs, including prescription and veterinary medicines" },
    });

    const response = await postNeed({ prohibitedVersion: version });

    // The cost of this decision, and the test that proves it is deliberate: a
    // rare, annoying re-tick after an edit. What it buys is a record that
    // always refers to wording the person actually saw.
    expect(response.status).toBe(409);
  });

  it("asks nothing of a draft, which nobody else can see", async () => {
    const response = await postNeed({ status: "DRAFT" });

    expect(response.status).toBe(201);
    const need = await prisma.need.findFirstOrThrow();
    expect(need.prohibitedVersion).toBeNull();
    expect(need.prohibitedAckAt).toBeNull();
  });

  it("records nothing on a draft even when a version is sent anyway", async () => {
    const { version } = await readList();

    const response = await postNeed({
      status: "DRAFT",
      prohibitedVersion: version,
    });

    // THE COLUMN ONLY EVER HOLDS A TICK THIS SERVICE CHECKED. The field is
    // pulled out of the body before the rest of it is copied onto the row —
    // without that, a client could write whatever it liked into the record of
    // what it agreed to, and a draft would carry an acknowledgement that was
    // never asked for or verified.
    expect(response.status).toBe(201);
    const need = await prisma.need.findFirstOrThrow();
    expect(need.prohibitedVersion).toBeNull();
    expect(need.prohibitedAckAt).toBeNull();
  });
});

describe("publishing a draft — the way in, if nobody closes it", () => {
  async function aDraft(): Promise<string> {
    const created = await postNeed({ status: "DRAFT" });
    expect(created.status).toBe(201);

    return (created.body as { need: { id: string } }).need.id;
  }

  it("refuses to publish a draft with no tick", async () => {
    const id = await aDraft();

    const response = await patchNeed(id, { status: "OPEN" });

    // The hole this issue's title is about. `updateNeedSchema` is
    // `createNeedSchema.partial()`, so a field that is required on create is
    // optional on update — and a draft is created without one. Without this
    // rule, "save a draft, then publish it" posts a public listing having
    // acknowledged nothing, and a client would do it without meaning to.
    expect(response.status).toBe(422);
    expect(
      (await prisma.need.findUniqueOrThrow({ where: { id } })).status,
    ).toBe("DRAFT");
  });

  it("publishes it when the tick comes with the change", async () => {
    const id = await aDraft();
    const { version } = await readList();

    const response = await patchNeed(id, {
      status: "OPEN",
      prohibitedVersion: version,
    });

    expect(response.status).toBe(200);
    const need = await prisma.need.findUniqueOrThrow({ where: { id } });
    expect(need.status).toBe("OPEN");
    expect(need.prohibitedVersion).toBe(version);
    expect(need.prohibitedAckAt).toBeInstanceOf(Date);
  });

  it("asks again nothing of an edit that leaves it public", async () => {
    const { version } = await readList();
    const created = await postNeed({ prohibitedVersion: version });
    const id = (created.body as { need: { id: string } }).need.id;

    const response = await patchNeed(id, {
      title: "Japanese sunscreen, SPF50",
    });

    // Already ticked, and still public: there is nothing to ask. Asking again
    // on every edit would train people to tick without reading, which is the
    // one thing this mechanism cannot survive.
    expect(response.status).toBe(200);
    expect(
      (await prisma.need.findUniqueOrThrow({ where: { id } }))
        .prohibitedVersion,
    ).toBe(version);
  });

  it("asks again when a public need goes back to being a draft and out again", async () => {
    const { version } = await readList();
    const created = await postNeed({ prohibitedVersion: version });
    const id = (created.body as { need: { id: string } }).need.id;

    expect((await patchNeed(id, { status: "DRAFT" })).status).toBe(200);
    expect((await patchNeed(id, { status: "OPEN" })).status).toBe(422);

    // And the tick from the first posting is not quietly reused, which is why
    // the rule is about the transition rather than about the column being
    // null. A listing that was withdrawn and is going out again is going out
    // against today's list.
    expect(
      (await patchNeed(id, { status: "OPEN", prohibitedVersion: version }))
        .status,
    ).toBe(200);
  });
});

describe("posting an offer to help", () => {
  it("records the tick the same way", async () => {
    const { version } = await readList();

    const response = await postHelp({ prohibitedVersion: version });

    expect(response.status).toBe(201);
    const help = await prisma.help.findFirstOrThrow();
    expect(help.prohibitedVersion).toBe(version);
    expect(help.prohibitedAckAt).toBeInstanceOf(Date);
  });

  it("refuses an active offer with no tick", async () => {
    const response = await postHelp({});

    expect(response.status).toBe(422);
    expect(await prisma.help.count()).toBe(0);
  });

  it("asks nothing of a paused offer, and asks when it is activated", async () => {
    const created = await postHelp({ status: "PAUSED" });
    expect(created.status).toBe(201);
    const id = (created.body as { help: { id: string } }).help.id;
    expect(
      (await prisma.help.findUniqueOrThrow({ where: { id } }))
        .prohibitedVersion,
    ).toBeNull();

    const refused = await request(app)
      .patch(`/helps/${id}`)
      .set("Cookie", kadri.cookie)
      .send({ status: "ACTIVE" });
    expect(refused.status).toBe(422);

    const { version } = await readList();
    const allowed = await request(app)
      .patch(`/helps/${id}`)
      .set("Cookie", kadri.cookie)
      .send({ status: "ACTIVE", prohibitedVersion: version });
    expect(allowed.status).toBe(200);
    expect(
      (await prisma.help.findUniqueOrThrow({ where: { id } }))
        .prohibitedVersion,
    ).toBe(version);
  });
});

describe("what the record is for", () => {
  it("keeps meaning what it meant after the list moves on", async () => {
    const { version } = await readList();
    await postNeed({ prohibitedVersion: version });

    // A line is reworded afterwards — which is the whole reason the list is a
    // table somebody can edit.
    await prisma.prohibitedItem.update({
      where: { slug: "weapons" },
      data: { text: "Weapons of every kind, including replicas and parts" },
    });

    const need = await prisma.need.findFirstOrThrow();
    // The need still carries the fingerprint of what its author actually saw,
    // not today's. "What did this person agree to" stays answerable, which is
    // the only reason to record a version rather than a boolean.
    expect(need.prohibitedVersion).toBe(version);
    expect((await readList()).version).not.toBe(version);
  });

  it("is a tick against wording, not a promise about the item", async () => {
    const { version } = await readList();

    // Nothing here inspects the listing. A need for "a replica pistol" is
    // accepted, recorded, and left to reports and moderation — because there
    // is no automatic detection and docs/11-risks.md says so rather than
    // implying otherwise. This test exists so that nobody later reads the
    // acknowledgement as a screening step.
    const response = await postNeed({
      title: "A replica pistol",
      prohibitedVersion: version,
    });

    expect(response.status).toBe(201);
  });
});

describe("when the list itself is missing", () => {
  it("refuses to publish anything, loudly", async () => {
    await prisma.prohibitedItem.deleteMany({});

    const response = await postNeed({ prohibitedVersion: "whatever" });

    // Our bug, not the caller's: the table is seeded by hand after a
    // migration, like the categories. If somebody forgets, the alternative to
    // this 500 is every posting ticking the fingerprint of nothing and being
    // recorded as having acknowledged a list with no lines in it — which
    // looks like success and is the quiet failure of a safety rule.
    expect(response.status).toBe(500);
    expect(await prisma.need.count()).toBe(0);
    // Nothing about our configuration reaches the caller (#4).
    const body = response.body as { error: { message: string } };
    expect(body.error.message).not.toMatch(/seed|prohibited list is empty/i);
  });

  it("still lets a draft be saved, because a draft acknowledges nothing", async () => {
    await prisma.prohibitedItem.deleteMany({});

    const response = await postNeed({ status: "DRAFT" });

    expect(response.status).toBe(201);
  });
});
