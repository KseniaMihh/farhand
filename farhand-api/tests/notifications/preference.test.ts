import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { prisma } from "../../src/db.js";
import { signUpAndLogIn, signUpVerifiedAndLogIn } from "../helpers/auth.js";
import type { TestUser } from "../helpers/auth.js";

/**
 * `PATCH /me/notifications` — the switch, issue #86.
 *
 * One boolean, and the interesting part is who may touch it. Marked SESSION
 * and not AUTH: an opt-out is the one thing an account in a bad state must
 * still be able to do. Somebody who never confirmed their address, or who has
 * been suspended, is exactly the person most likely to want the email to
 * stop — and `DELETE /me` is marked the same way for the same reason (#66).
 *
 * It is also the half of #86 that protects the other half. One unsubscribe
 * click at the provider blocks an address for everything we send, verification
 * included (decision 0015), so the only safe place to put "no thank you" is
 * inside Farhand.
 */
const app = createApp();

const ORIGIN = "http://localhost:3000";
let kadri: TestUser;

beforeEach(async () => {
  kadri = await signUpVerifiedAndLogIn(app, "kadri@example.com", "Kadri");
});

function setIt(user: TestUser, body: object) {
  return request(app)
    .patch("/me/notifications")
    .set("Cookie", user.cookie)
    .set("Origin", ORIGIN)
    .send(body);
}

describe("turning notifications off and on", () => {
  it("starts on, because the useful ones are the point", async () => {
    const me = await request(app).get("/auth/me").set("Cookie", kadri.cookie);
    const body = me.body as { user: { emailNotifications: boolean } };

    expect(body.user.emailNotifications).toBe(true);
    // Reported by /auth/me, so a client needs no second request to draw the
    // setting it is about to change.
  });

  it("turns them off, and says what the setting is now", async () => {
    const response = await setIt(kadri, { emailNotifications: false });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ emailNotifications: false });
    expect(
      (await prisma.user.findUniqueOrThrow({ where: { id: kadri.id } }))
        .emailNotifications,
    ).toBe(false);
  });

  it("turns them back on", async () => {
    await setIt(kadri, { emailNotifications: false });
    const response = await setIt(kadri, { emailNotifications: true });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ emailNotifications: true });
  });

  it("is the same answer when nothing changes", async () => {
    await setIt(kadri, { emailNotifications: false });
    const again = await setIt(kadri, { emailNotifications: false });

    // Idempotent, like `DELETE /me/avatar` when there is no avatar: the
    // caller asked for a state, and that is the state.
    expect(again.status).toBe(200);
    expect(again.body).toEqual({ emailNotifications: false });
  });
});

describe("who may change it", () => {
  it("refuses a stranger", async () => {
    const response = await request(app)
      .patch("/me/notifications")
      .set("Origin", ORIGIN)
      .send({ emailNotifications: false });

    expect(response.status).toBe(401);
  });

  it("lets an unverified account stop the email", async () => {
    const nell = await signUpAndLogIn(app, "nell@example.com", "Nell");

    const response = await setIt(nell, { emailNotifications: false });

    // AUTH would refuse this with 403 "Confirm your email address first",
    // which would mean the only way to stop unwanted email is to confirm the
    // address receiving it.
    expect(response.status).toBe(200);
  });

  it("lets a suspended account stop the email", async () => {
    await prisma.user.update({
      where: { id: kadri.id },
      data: { status: "SUSPENDED", suspendedUntil: new Date(Date.now() + 1e6) },
    });

    const response = await setIt(kadri, { emailNotifications: false });

    expect(response.status).toBe(200);
  });
});

describe("what it refuses", () => {
  it("names the field when it is not a boolean", async () => {
    const response = await setIt(kadri, { emailNotifications: "no thanks" });

    const body = response.body as {
      error: { details?: { field: string }[] };
    };

    expect(response.status).toBe(422);
    expect(body.error.details?.map((d) => d.field)).toContain(
      "emailNotifications",
    );
  });

  it("refuses an empty body rather than guessing", async () => {
    const response = await setIt(kadri, {});

    expect(response.status).toBe(422);
  });

  it("refuses a field it does not know", async () => {
    const response = await setIt(kadri, {
      emailNotifications: false,
      everything: false,
    });

    // `.strict()`, as every other body in this project is: a client sending
    // `everything: false` and getting a 200 would believe it had worked.
    expect(response.status).toBe(422);
  });

  // The "a write must carry our own Origin" rule is site-wide middleware and
  // is tested once, on one representative route, in tests/security/csrf.test.ts
  // — with `CSRF_ENABLED` flipped on for the assertion, because the suite runs
  // with it off so that the fixtures can sign anybody in. A copy of that dance
  // here would test the setup rather than this endpoint.
});
