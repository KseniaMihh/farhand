import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/app.js";
import { prisma } from "../../src/db.js";
import { MAX_FILE_BYTES, storeFile } from "../../src/services/files.js";
import { storage } from "../../src/storage.js";
import { signUpVerifiedAndLogIn } from "../helpers/auth.js";
import { allKeys, objectExists, sample } from "../helpers/files.js";

/**
 * storeFile — the one way bytes get in (#79).
 *
 * No endpoint calls it yet: #80, #81 and #82 each add an upload for their own
 * purpose. So it is tested directly, as a function, against the real database
 * and the real local store. The rules every upload will inherit are pinned
 * here once.
 */

const app = createApp();
let ownerId: string;

beforeEach(async () => {
  ownerId = (await signUpVerifiedAndLogIn(app, "kadri@example.com", "Kadri"))
    .id;
});

/** Asserts the promise was refused as invalid, not as a crash. */
async function expectRefused(promise: Promise<unknown>): Promise<void> {
  await expect(promise).rejects.toMatchObject({
    status: 422,
    code: "VALIDATION_FAILED",
  });
}

describe("a file that is accepted", () => {
  it("is stored, and described by a row naming owner, purpose, key, type and size", async () => {
    const bytes = sample.png(4096);

    const file = await storeFile({ ownerId, purpose: "AVATAR", bytes });

    expect(file).toMatchObject({
      ownerId,
      purpose: "AVATAR",
      mimeType: "image/png",
      sizeBytes: 4096,
    });
    expect(await objectExists(file.storageKey)).toBe(true);

    // The row is the one in the database, not an object assembled in memory.
    const stored = await prisma.file.findUniqueOrThrow({
      where: { id: file.id },
    });
    expect(stored).toEqual(file);
  });

  it("records what the bytes are, read from the bytes", async () => {
    // Nothing the caller says about the type is even accepted as input: the
    // only source for mimeType is the file itself.
    const webp = await storeFile({
      ownerId,
      purpose: "NEED_PHOTO",
      bytes: sample.webp(),
    });
    const jpeg = await storeFile({
      ownerId,
      purpose: "NEED_PHOTO",
      bytes: sample.jpeg(),
    });

    expect(webp.mimeType).toBe("image/webp");
    expect(jpeg.mimeType).toBe("image/jpeg");
  });

  it("is stored under a key that says nothing about it, and never reused", async () => {
    const first = await storeFile({
      ownerId,
      purpose: "AVATAR",
      bytes: sample.png(),
    });
    const second = await storeFile({
      ownerId,
      purpose: "AVATAR",
      bytes: sample.png(),
    });

    expect(first.storageKey).not.toBe(second.storageKey);
    expect(first.storageKey).toMatch(/^files\//);
    // A signed URL carries the key. Whose file it is must not be in it.
    expect(first.storageKey).not.toContain(ownerId);
  });

  it("may be exactly the size limit", async () => {
    const file = await storeFile({
      ownerId,
      purpose: "AVATAR",
      bytes: sample.png(MAX_FILE_BYTES),
    });

    expect(file.sizeBytes).toBe(MAX_FILE_BYTES);
  });

  it("may be a PDF when it is a receipt", async () => {
    const file = await storeFile({
      ownerId,
      purpose: "PRODUCT_RECEIPT",
      bytes: sample.pdf(),
    });

    expect(file.mimeType).toBe("application/pdf");
  });
});

describe("a file that is refused leaves nothing behind", () => {
  /**
   * Every refusal here is checked three ways: the answer is 422, there is no
   * row, and there are no new bytes in the store. "Refused rather than stored
   * and regretted" is the criterion, so an implementation that stores first
   * and deletes afterwards must fail — the spy on `put` catches exactly that.
   */
  async function expectNothingStored(attempt: () => Promise<unknown>) {
    const keysBefore = await allKeys();
    const put = vi.spyOn(storage, "put");

    await expectRefused(attempt());

    expect(put).not.toHaveBeenCalled();
    expect(await prisma.file.count()).toBe(0);
    expect(await allKeys()).toEqual(keysBefore);
  }

  it("when it is one byte over the limit", async () => {
    await expectNothingStored(() =>
      storeFile({
        ownerId,
        purpose: "AVATAR",
        bytes: sample.png(MAX_FILE_BYTES + 1),
      }),
    );
  });

  it("when it is empty", async () => {
    await expectNothingStored(() =>
      storeFile({ ownerId, purpose: "AVATAR", bytes: Buffer.alloc(0) }),
    );
  });

  it("when it is not an image at all, whatever it would be called", async () => {
    await expectNothingStored(() =>
      storeFile({ ownerId, purpose: "NEED_PHOTO", bytes: sample.html() }),
    );
  });

  it("when it is an image of a type we do not take", async () => {
    await expectNothingStored(() =>
      storeFile({ ownerId, purpose: "NEED_PHOTO", bytes: sample.gif() }),
    );
  });

  it("when it is a PDF and the purpose is a photo", async () => {
    // The same bytes are accepted as a receipt (above). The allowed list is
    // per purpose, not one list for everything.
    await expectNothingStored(() =>
      storeFile({ ownerId, purpose: "AVATAR", bytes: sample.pdf() }),
    );
  });
});

describe("a failure halfway through", () => {
  it("in the store leaves no row", async () => {
    vi.spyOn(storage, "put").mockRejectedValueOnce(
      new Error("the store is down"),
    );

    await expect(
      storeFile({ ownerId, purpose: "AVATAR", bytes: sample.png() }),
    ).rejects.toThrow("the store is down");

    expect(await prisma.file.count()).toBe(0);
  });

  it("in the database removes the bytes it had already stored", async () => {
    const keysBefore = await allKeys();
    const put = vi.spyOn(storage, "put");
    vi.spyOn(prisma.file, "create").mockRejectedValueOnce(
      new Error("the database is down"),
    );

    await expect(
      storeFile({ ownerId, purpose: "AVATAR", bytes: sample.png() }),
    ).rejects.toThrow("the database is down");

    // The bytes really were stored first — otherwise "removed" proves nothing.
    expect(put).toHaveBeenCalledOnce();
    expect(await allKeys()).toEqual(keysBefore);
  });

  it("reports the failure that happened, not the cleanup's", async () => {
    vi.spyOn(prisma.file, "create").mockRejectedValueOnce(
      new Error("the database is down"),
    );
    vi.spyOn(storage, "delete").mockRejectedValueOnce(
      new Error("and so is the cleanup"),
    );

    await expect(
      storeFile({ ownerId, purpose: "AVATAR", bytes: sample.png() }),
    ).rejects.toThrow("the database is down");
  });
});
