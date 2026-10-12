import type { FilePurpose, Need, NeedStatus } from "@prisma/client";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { prisma } from "../../src/db.js";
import { READ_URL_SECONDS, REDIRECT_CACHE_SECONDS } from "../../src/storage.js";
import { signUpVerifiedAndLogIn, type TestUser } from "../helpers/auth.js";
import {
  deleteObjectBehindTheApi,
  fileFixture,
  sample,
} from "../helpers/files.js";
import { withoutRequestId } from "../helpers/http.js";
import { createCategory, createDealFor } from "../helpers/needs.js";

/**
 * GET /files/:id — the only way to read a file (#79).
 *
 * The answer is never the bytes: it is a 302 to a signed URL that expires.
 * Files here are made with `fileFixture`, which bypasses storeFile, so these
 * tests stand on their own whatever state the upload half is in.
 *
 * Who may see what is docs/02-roles-and-permissions.md; the per-purpose table
 * is in src/services/files.ts above fileReadUrl.
 */

const app = createApp();

let kadri: TestUser; // requester
let yuki: TestUser; // helper
let stranger: TestUser;
let moderator: TestUser;

beforeEach(async () => {
  kadri = await signUpVerifiedAndLogIn(app, "kadri@example.com", "Kadri");
  yuki = await signUpVerifiedAndLogIn(app, "yuki@example.com", "Yuki");
  stranger = await signUpVerifiedAndLogIn(app, "sam@example.com", "Sam");
  moderator = await signUpVerifiedAndLogIn(app, "mo@example.com", "Mo");
  await prisma.user.update({
    where: { id: moderator.id },
    data: { role: "MODERATOR" },
  });
});

async function needWithStatus(status: NeedStatus): Promise<Need> {
  const category = await createCategory(`c-${status.toLowerCase()}`);
  return prisma.need.create({
    data: {
      requesterId: kadri.id,
      categoryId: category.id,
      title: "Japanese sunscreen",
      description: "The one not sold in Europe",
      buyCountry: "JP",
      deliverCountry: "EE",
      currency: "EUR",
      estimatedPrice: 2400,
      status,
    },
  });
}

/** GET /files/:id, as `viewer` or signed out. */
function get(fileId: string, viewer?: TestUser) {
  const req = request(app).get(`/files/${fileId}`);
  return viewer ? req.set("Cookie", viewer.cookie) : req;
}

/** The answer an id that never existed gets — the baseline every refusal must match. */
async function unknownFileAnswer() {
  const response = await get("cm0doesnotexist000000000");
  expect(response.status).toBe(404);
  return withoutRequestId(response.body);
}

/** Where a redirect points. Fails the test, rather than the type, if nowhere. */
function locationOf(response: { headers: Record<string, string> }): string {
  const location = response.headers.location;
  if (!location) throw new Error("expected a redirect with a Location header");
  return location;
}

async function expectHiddenFrom(fileId: string, viewer?: TestUser) {
  const response = await get(fileId, viewer);
  expect(response.status).toBe(404);
  expect(withoutRequestId(response.body)).toEqual(await unknownFileAnswer());
}

async function expectVisibleTo(fileId: string, viewer?: TestUser) {
  const response = await get(fileId, viewer);
  expect(response.status).toBe(302);
}

describe("reading a file", () => {
  it("redirects to a URL that serves the bytes", async () => {
    const bytes = sample.png(3000);
    const file = await fileFixture({
      ownerId: kadri.id,
      purpose: "AVATAR",
      bytes,
    });

    const response = await get(file.id);
    expect(response.status).toBe(302);

    const served = await fetch(locationOf(response));
    expect(served.status).toBe(200);
    expect(Buffer.from(await served.arrayBuffer())).toEqual(bytes);
  });

  it("hands out a URL that expires in five minutes", async () => {
    const file = await fileFixture({ ownerId: kadri.id, purpose: "AVATAR" });

    const location = new URL(locationOf(await get(file.id)));

    expect(location.searchParams.get("X-Amz-Expires")).toBe(
      String(READ_URL_SECONDS),
    );
    expect(READ_URL_SECONDS).toBe(300);
  });

  it("lets the browser keep the redirect, but not past its signature", async () => {
    // This used to insist on `no-store`, on the reasoning that a cached 302
    // outlives the signature inside it. The reasoning was right and the
    // conclusion too strong: the cached copy carries that same signature, so
    // keeping it for less time than the signature lasts cannot reach past the
    // expiry it already has. Why that is worth doing, and the invariant
    // between the two numbers, are in tests/files/cost.test.ts (#102).
    const file = await fileFixture({ ownerId: kadri.id, purpose: "AVATAR" });

    const response = await get(file.id);

    expect(response.headers["cache-control"]).toBe(
      `private, max-age=${String(REDIRECT_CACHE_SECONDS)}`,
    );
    expect(REDIRECT_CACHE_SECONDS).toBeLessThan(READ_URL_SECONDS);
  });

  it("never makes the bytes readable without a signature", async () => {
    const file = await fileFixture({ ownerId: kadri.id, purpose: "AVATAR" });
    const signed = new URL(locationOf(await get(file.id)));

    // The same address with the signature taken off: what anybody would try
    // who saw one URL and guessed the pattern.
    const unsigned = `${signed.origin}${signed.pathname}`;

    expect((await fetch(unsigned)).status).toBe(403);
  });

  it("answers 404 for a file that does not exist", async () => {
    const response = await get("cm0doesnotexist000000000");

    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({
      error: { code: "NOT_FOUND", message: "File not found" },
    });
  });

  it("does not crash when the bytes have vanished from under the row", async () => {
    const file = await fileFixture({ ownerId: kadri.id, purpose: "AVATAR" });
    await deleteObjectBehindTheApi(file.storageKey);

    const response = await get(file.id);

    // Still a redirect: the API does not ask the store on every view. It is
    // the store that answers, and it answers "not found" rather than the API
    // answering "server error".
    expect(response.status).toBe(302);
    expect((await fetch(locationOf(response))).status).toBe(404);
  });
});

describe("an avatar", () => {
  it("is anybody's to see, signed in or not", async () => {
    const file = await fileFixture({ ownerId: kadri.id, purpose: "AVATAR" });

    await expectVisibleTo(file.id);
    await expectVisibleTo(file.id, stranger);
  });

  it("is still shown while its owner is suspended", async () => {
    // The same rule as GET /users/:id: a suspension stops somebody acting,
    // not existing.
    await prisma.user.update({
      where: { id: kadri.id },
      data: { status: "SUSPENDED" },
    });
    const file = await fileFixture({ ownerId: kadri.id, purpose: "AVATAR" });

    await expectVisibleTo(file.id, stranger);
  });

  it("disappears with a banned owner's profile, exactly like a missing file", async () => {
    await prisma.user.update({
      where: { id: kadri.id },
      data: { status: "BANNED" },
    });
    const file = await fileFixture({ ownerId: kadri.id, purpose: "AVATAR" });

    await expectHiddenFrom(file.id, stranger);
  });
});

describe("a photo on a need", () => {
  it("is anybody's to see while the need is open", async () => {
    const need = await needWithStatus("OPEN");
    const file = await fileFixture({
      ownerId: kadri.id,
      purpose: "NEED_PHOTO",
      needId: need.id,
    });

    await expectVisibleTo(file.id);
  });

  it("stays visible once the need is matched, because a deal is running on it", async () => {
    const need = await needWithStatus("MATCHED");
    const file = await fileFixture({
      ownerId: kadri.id,
      purpose: "NEED_PHOTO",
      needId: need.id,
    });

    await expectVisibleTo(file.id, stranger);
  });

  it("on a draft is its owner's alone, and a stranger cannot tell it exists", async () => {
    const need = await needWithStatus("DRAFT");
    const file = await fileFixture({
      ownerId: kadri.id,
      purpose: "NEED_PHOTO",
      needId: need.id,
    });

    await expectVisibleTo(file.id, kadri);
    await expectHiddenFrom(file.id, stranger);
    await expectHiddenFrom(file.id);
  });

  it("on a closed need is hidden from strangers, not from its owner", async () => {
    const need = await needWithStatus("CLOSED");
    const file = await fileFixture({
      ownerId: kadri.id,
      purpose: "NEED_PHOTO",
      needId: need.id,
    });

    await expectVisibleTo(file.id, kadri);
    await expectHiddenFrom(file.id, stranger);
  });

  /**
   * The moderator case, added by #81.
   *
   * A receipt has had one since #79 (`isParticipant || isModerator`) and a
   * need's photo had not, which was an oversight rather than a decision:
   * PROHIBITED_ITEM is one of `ReportReason`'s values and NEED is one of
   * `ReportTarget`'s, so a report about a picture is a thing this API accepts.
   * Without this, the act of removing the need hid the evidence it was removed
   * for — and `GET /admin/reports/:id` is how a moderator gets the id at all
   * (tests/admin/moderation.test.ts).
   */
  describe.each<NeedStatus>(["DRAFT", "CLOSED", "EXPIRED", "REMOVED"])(
    "on a %s need",
    (status) => {
      it("is visible to a moderator, who may have to look at why", async () => {
        const need = await needWithStatus(status);
        const file = await fileFixture({
          ownerId: kadri.id,
          purpose: "NEED_PHOTO",
          needId: need.id,
        });

        await expectVisibleTo(file.id, moderator);
        // The same request from somebody with no role is still a 404: this is
        // one more case, not a wider rule.
        await expectHiddenFrom(file.id, stranger);
      });
    },
  );
});

describe.each<FilePurpose>(["PRODUCT_RECEIPT", "SHIPPING_RECEIPT"])(
  "a %s",
  (purpose) => {
    async function receipt() {
      const need = await needWithStatus("MATCHED");
      const deal = await createDealFor(need, yuki.id);
      return fileFixture({ ownerId: yuki.id, purpose, dealId: deal.id });
    }

    it("is visible to both people in the deal", async () => {
      const file = await receipt();

      await expectVisibleTo(file.id, yuki);
      await expectVisibleTo(file.id, kadri);
    });

    it("is visible to a moderator", async () => {
      const file = await receipt();

      await expectVisibleTo(file.id, moderator);
    });

    it("is hidden from anyone else, exactly like a missing file", async () => {
      const file = await receipt();

      await expectHiddenFrom(file.id, stranger);
      await expectHiddenFrom(file.id);
    });
  },
);
