import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { prisma } from "../../src/db.js";
import { env } from "../../src/env.js";
import { signUpVerifiedAndLogIn } from "../helpers/auth.js";
import type { TestUser } from "../helpers/auth.js";
import { createCategory } from "../helpers/needs.js";
import { currentProhibitedVersion } from "../helpers/prohibited.js";

/**
 * The origin check on writes — issue #28.
 *
 * These tests are the specification. They fail until the TODO in
 * src/middleware/security.ts is filled in.
 *
 *   npm run test:watch -- csrf
 *
 * WHY THIS FILE IS DIFFERENT. The check is off in .env.test, because four
 * hundred other tests post without a browser to set an Origin header. This
 * file turns it on for itself, exactly as the rate-limit files do.
 *
 * WHAT IT IS FOR. The session is a cookie, and a browser attaches cookies to a
 * request whatever page caused it. A form on another website posting to
 * /needs arrives with a perfectly good session
 * (docs/10-decisions/0007-sessions-over-jwt.md). SameSite=lax already stops
 * most of that; this is the part that does not depend on the cookie attributes
 * being right forever.
 */
const app = createApp();

let categoryId = "";
let prohibitedVersion = "";
let kadri: TestUser;

beforeEach(async () => {
  // Off while the fixture is built, on for the test itself: signing up and
  // logging in are writes, and the rule under test would refuse them — the
  // helpers use no browser, so they send no Origin. Turning it on afterwards
  // is the difference between testing the rule and testing the setup.
  env.CSRF_ENABLED = false;
  categoryId = (await createCategory()).id;
  kadri = await signUpVerifiedAndLogIn(app, "kadri@example.com", "Kadri");
  prohibitedVersion = await currentProhibitedVersion();
  env.CSRF_ENABLED = true;
});

afterEach(() => {
  env.CSRF_ENABLED = false;
});

const NEED = {
  title: "Japanese sunscreen",
  description: "The one not sold in Europe",
  buyCountry: "JP",
  deliverCountry: "EE",
  currency: "EUR",
  estimatedPrice: 2400,
};

function post(headers: Record<string, string> = {}) {
  const pending = request(app)
    .post("/needs")
    .set("Cookie", kadri.cookie)
    // Ticked (#87), so that a refusal here can only ever be the origin rule
    // this file is about. `prohibitedVersion` is read in `beforeEach`, while
    // the guard is still switched off.
    .send({ ...NEED, categoryId, prohibitedVersion });

  for (const [name, value] of Object.entries(headers)) {
    void pending.set(name, value);
  }

  return pending;
}

describe("writes have to come from our own site", () => {
  it("allows one the frontend sent", async () => {
    const response = await post({ Origin: env.APP_ORIGIN });

    expect(response.status).toBe(201);
  });

  it("refuses one another website sent", async () => {
    const response = await post({ Origin: "https://evil.example" });

    // The session cookie was perfectly valid. That is the whole problem this
    // solves: the browser attached it because the browser always does.
    expect(response.status).toBe(403);
    expect(await prisma.need.count()).toBe(0);
  });

  it("refuses one with no provenance at all", async () => {
    const response = await post();

    // A write with neither Origin nor Referer is not something a browser does
    // on a cross-site request, and anything that is not a browser is not
    // carrying somebody else's cookies either.
    expect(response.status).toBe(403);
  });

  it("takes Referer when Origin is missing", async () => {
    const response = await post({ Referer: `${env.APP_ORIGIN}/needs/new` });

    // Some proxies strip Origin. Referer is the fallback, and a page under our
    // own origin is good enough provenance.
    expect(response.status).toBe(201);
  });

  it("is not fooled by an origin that merely starts the same", async () => {
    const lookalike = await post({
      Origin: `${env.APP_ORIGIN}.evil.example`,
    });
    const inTheMiddle = await post({
      Origin: `https://evil.example/?x=${env.APP_ORIGIN}`,
    });
    const refererLookalike = await post({
      Referer: `${env.APP_ORIGIN}.evil.example/needs`,
    });

    // "https://farhand.ee.evil.example" is not our origin, and a substring
    // match is how it would be let in.
    expect(lookalike.status).toBe(403);
    expect(inTheMiddle.status).toBe(403);
    expect(refererLookalike.status).toBe(403);
  });

  it("leaves reading alone", async () => {
    const browsing = await request(app)
      .get("/needs")
      .set("Origin", "https://evil.example");
    const mine = await request(app)
      .get("/me/needs")
      .set("Cookie", kadri.cookie)
      .set("Origin", "https://evil.example");

    // A GET changes nothing, and CORS already stops that page from READING
    // the answer. Refusing here would only break links and bookmarks.
    expect(browsing.status).toBe(200);
    expect(mine.status).toBe(200);
  });

  it("guards every kind of write, not only POST", async () => {
    const need = await prisma.need.create({
      data: { ...NEED, categoryId, requesterId: kadri.id, status: "OPEN" },
    });

    const patch = await request(app)
      .patch(`/needs/${need.id}`)
      .set("Cookie", kadri.cookie)
      .set("Origin", "https://evil.example")
      .send({ title: "Hijacked" });
    const remove = await request(app)
      .delete(`/needs/${need.id}`)
      .set("Cookie", kadri.cookie)
      .set("Origin", "https://evil.example");

    expect(patch.status).toBe(403);
    expect(remove.status).toBe(403);
    const after = await prisma.need.findUniqueOrThrow({
      where: { id: need.id },
    });
    expect(after.title).toBe("Japanese sunscreen");
    expect(after.status).toBe("OPEN");
  });

  it("protects signing in, which is a write too", async () => {
    const response = await request(app)
      .post("/auth/login")
      .set("Origin", "https://evil.example")
      .send({
        email: "kadri@example.com",
        password: "a decent long passphrase",
      });

    // A page that can make somebody log in as an account it controls can then
    // watch what they do next.
    expect(response.status).toBe(403);
  });

  it("does nothing at all when it is switched off", async () => {
    env.CSRF_ENABLED = false;

    const response = await post({ Origin: "https://evil.example" });

    // Which is why the other four hundred tests can post without a browser.
    expect(response.status).toBe(201);
  });
});
