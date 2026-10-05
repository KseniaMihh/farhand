import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/app.js";
import { prisma } from "../../src/db.js";
import { storage } from "../../src/storage.js";
import {
  PASSWORD,
  signUpVerifiedAndLogIn,
  type TestUser,
} from "../helpers/auth.js";
import { fileFixture, objectExists } from "../helpers/files.js";
import { createCategory, createDealFor } from "../helpers/needs.js";
import { breakInsideTransaction } from "../helpers/transactions.js";

/**
 * What deleting an account (#66) does to that account's files (#79).
 *
 * Decided: photos go, receipts stay. An avatar and a need photo are personal
 * and nobody else depends on them. A receipt is evidence in a deal the other
 * person is part of too — kept for the same reason the deal's messages are.
 */

const app = createApp();

let yuki: TestUser; // leaves
let kadri: TestUser; // stays, and was in a deal with Yuki

beforeEach(async () => {
  yuki = await signUpVerifiedAndLogIn(app, "yuki@example.com", "Yuki");
  kadri = await signUpVerifiedAndLogIn(app, "kadri@example.com", "Kadri");
});

function deleteAccount(user: TestUser) {
  return request(app)
    .delete("/me")
    .set("Cookie", user.cookie)
    .send({ password: PASSWORD });
}

/**
 * One of each kind of file Yuki can own: an avatar, a photo on her own need,
 * and a receipt in a finished deal she helped with — finished, because #66
 * refuses to delete an account with a deal still running.
 */
async function yukisFiles() {
  const category = await createCategory("cosmetics");
  const ownNeed = await prisma.need.create({
    data: {
      requesterId: yuki.id,
      categoryId: category.id,
      title: "Estonian chocolate",
      description: "Kalev, the dark one",
      buyCountry: "EE",
      deliverCountry: "JP",
      currency: "EUR",
      estimatedPrice: 900,
    },
  });
  const kadrisNeed = await prisma.need.create({
    data: {
      requesterId: kadri.id,
      categoryId: category.id,
      title: "Japanese sunscreen",
      description: "The one not sold in Europe",
      buyCountry: "JP",
      deliverCountry: "EE",
      currency: "EUR",
      estimatedPrice: 2400,
      status: "MATCHED",
    },
  });
  const deal = await createDealFor(kadrisNeed, yuki.id);
  await prisma.deal.update({
    where: { id: deal.id },
    data: { status: "COMPLETED" },
  });

  return {
    avatar: await fileFixture({ ownerId: yuki.id, purpose: "AVATAR" }),
    needPhoto: await fileFixture({
      ownerId: yuki.id,
      purpose: "NEED_PHOTO",
      needId: ownNeed.id,
    }),
    receipt: await fileFixture({
      ownerId: yuki.id,
      purpose: "PRODUCT_RECEIPT",
      dealId: deal.id,
    }),
  };
}

describe("deleting an account", () => {
  it("deletes its photos: the rows and the bytes", async () => {
    const { avatar, needPhoto } = await yukisFiles();

    expect((await deleteAccount(yuki)).status).toBe(204);

    for (const file of [avatar, needPhoto]) {
      expect(await prisma.file.findUnique({ where: { id: file.id } })).toBe(
        null,
      );
      expect(await objectExists(file.storageKey)).toBe(false);
    }
  });

  it("keeps its receipts, still readable by the other person in the deal", async () => {
    const { receipt } = await yukisFiles();

    expect((await deleteAccount(yuki)).status).toBe(204);

    expect(
      await prisma.file.findUnique({ where: { id: receipt.id } }),
    ).not.toBe(null);
    expect(await objectExists(receipt.storageKey)).toBe(true);

    const response = await request(app)
      .get(`/files/${receipt.id}`)
      .set("Cookie", kadri.cookie);
    expect(response.status).toBe(302);
  });

  it("leaves everybody else's files alone", async () => {
    await yukisFiles();
    const kadrisAvatar = await fileFixture({
      ownerId: kadri.id,
      purpose: "AVATAR",
    });

    // The deletion has to have happened, or "nothing else was touched" is
    // true of a deletion that never ran.
    expect((await deleteAccount(yuki)).status).toBe(204);

    expect(await objectExists(kadrisAvatar.storageKey)).toBe(true);
    expect(
      await prisma.file.findUnique({ where: { id: kadrisAvatar.id } }),
    ).not.toBe(null);
  });

  it("still succeeds when the store will not delete the bytes", async () => {
    // The person asked to leave, and they have left. A photo lingering in a
    // private bucket is ours to clean up, not a reason to tell them "error".
    const { avatar } = await yukisFiles();
    vi.spyOn(storage, "delete").mockRejectedValue(
      new Error("the store is down"),
    );

    const response = await deleteAccount(yuki);

    expect(response.status).toBe(204);
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: yuki.id },
    });
    expect(user.status).toBe("DELETED");
    expect(await prisma.file.findUnique({ where: { id: avatar.id } })).toBe(
      null,
    );
  });

  it("tries every key even when one of them fails", async () => {
    const { avatar, needPhoto } = await yukisFiles();
    const realDelete = storage.delete.bind(storage);
    vi.spyOn(storage, "delete").mockImplementation(async (key) => {
      if (key === avatar.storageKey) throw new Error("not this one");
      await realDelete(key);
    });

    await deleteAccount(yuki);

    // Whichever order the keys are tried in, the failing one must not stop
    // the other.
    expect(await objectExists(needPhoto.storageKey)).toBe(false);
  });

  it("deletes no bytes at all when the transaction rolls back", async () => {
    // Storage is not part of the transaction. Bytes deleted inside it would be
    // gone for rows that the rollback brings back.
    const { avatar, needPhoto } = await yukisFiles();
    const broken = breakInsideTransaction("file", "deleteMany");

    const response = await deleteAccount(yuki);

    expect(response.status).toBe(500);
    // The failure is the one this test arranged, at the moment the rows were
    // being deleted — not some earlier crash that never reached the files.
    expect(broken.attempts).toBe(1);
    for (const file of [avatar, needPhoto]) {
      expect(await prisma.file.findUnique({ where: { id: file.id } })).not.toBe(
        null,
      );
      expect(await objectExists(file.storageKey)).toBe(true);
    }
  });
});
