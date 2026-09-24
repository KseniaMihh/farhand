import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { prisma } from "../../src/db.js";
import { env } from "../../src/env.js";
import { RATE_LIMITS } from "../../src/middleware/rate-limit.js";
import { signUpVerifiedAndLogIn } from "../helpers/auth.js";
import type { TestUser } from "../helpers/auth.js";
import { createCategory } from "../helpers/needs.js";

/**
 * The rate limit on sending messages — issue #21, third criterion.
 *
 * Like tests/auth/rate-limit.test.ts, this file is different from the others:
 *
 * FIRST, .env.test turns rate limiting off, because every other file makes
 * dozens of requests on purpose. This one turns it back on for itself.
 *
 * SECOND, the counters live in memory and survive the database being emptied,
 * so every test needs its own account — otherwise the second test starts with
 * the first one's budget already spent.
 */
const app = createApp();

beforeEach(() => {
  env.RATE_LIMIT_ENABLED = true;
});

afterEach(() => {
  env.RATE_LIMIT_ENABLED = false;
});

let senderCounter = 0;

/** A fresh pair of people and a proposal between them, for one test only. */
async function freshThread() {
  senderCounter += 1;
  const suffix = String(senderCounter);
  const categoryId = (await createCategory()).id;
  const requester = await signUpVerifiedAndLogIn(
    app,
    `requester${suffix}@example.com`,
    "R",
  );
  const helper = await signUpVerifiedAndLogIn(
    app,
    `helper${suffix}@example.com`,
    "H",
  );
  const need = await prisma.need.create({
    data: {
      requesterId: requester.id,
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
    .set("Cookie", helper.cookie)
    .send({});
  const proposal = await prisma.proposal.findFirstOrThrow({
    where: { needId: need.id },
  });

  return { requester, helper, proposal };
}

function send(user: TestUser, proposalId: string) {
  return request(app)
    .post(`/proposals/${proposalId}/messages`)
    .set("Cookie", user.cookie)
    .send({ body: "hello" });
}

describe("POST /proposals/:id/messages is rate limited", () => {
  it("allows a real back-and-forth, then refuses", async () => {
    const { helper, proposal } = await freshThread();
    const max = RATE_LIMITS.message.perUser;

    const statuses: number[] = [];
    for (let i = 0; i < max + 1; i++) {
      statuses.push((await send(helper, proposal.id)).status);
    }

    expect(statuses.slice(0, max)).toEqual(Array(max).fill(201));
    expect(statuses.at(-1)).toBe(429);
  });

  it("says how long to wait", async () => {
    const { helper, proposal } = await freshThread();
    for (let i = 0; i < RATE_LIMITS.message.perUser; i++) {
      await send(helper, proposal.id);
    }

    const refused = await send(helper, proposal.id);

    expect(refused.status).toBe(429);
    expect(Number(refused.headers["retry-after"])).toBeGreaterThan(0);
    expect((refused.body as { error: { code: string } }).error.code).toBe(
      "TOO_MANY_REQUESTS",
    );
  });

  it("counts the sender, not the address they send from", async () => {
    const { requester, helper, proposal } = await freshThread();
    for (let i = 0; i < RATE_LIMITS.message.perUser; i++) {
      await send(helper, proposal.id);
    }

    // Same machine, same address, different person: the limiter keys on the
    // session, so the other side of the conversation still has their say.
    // Keyed on the body's email — which a message does not carry — both of
    // them would share one budget and this would be 429.
    const theirTurn = await send(requester, proposal.id);

    expect(theirTurn.status).toBe(201);
  });

  it("spends budget even on a message it then refuses", async () => {
    const { helper, proposal } = await freshThread();

    const refused = await request(app)
      .post(`/proposals/${proposal.id}/messages`)
      .set("Cookie", helper.cookie)
      .send({ body: "   " });
    const statuses: number[] = [];
    for (let i = 0; i < RATE_LIMITS.message.perUser; i++) {
      statuses.push((await send(helper, proposal.id)).status);
    }

    // A rejected message still spends budget — the limiter runs before the
    // handler, and that is deliberate: otherwise a flood of invalid requests
    // would be free. This test records that, so a change to it is a decision
    // and not an accident.
    expect(refused.status).toBe(422);
    expect(statuses.at(-1)).toBe(429);
  });
});
