import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/app.js";
import { prisma } from "../../src/db.js";
import { env } from "../../src/env.js";
import { AVATAR_SIDE } from "../../src/images.js";
import { RATE_LIMITS } from "../../src/middleware/rate-limit.js";
import { MAX_FILE_BYTES } from "../../src/services/files.js";
import { storage } from "../../src/storage.js";
import {
  PASSWORD,
  signUpAndLogIn,
  signUpVerifiedAndLogIn,
  type TestUser,
} from "../helpers/auth.js";
import { fileFixture, objectExists, sample } from "../helpers/files.js";
import {
  describe as describeImage,
  dominantAt,
  photoWithMetadata,
  pixelBomb,
  SECRET_ARTIST,
  sidewaysPhoto,
  solidImage,
  threeStripes,
  truncatedJpeg,
} from "../helpers/images.js";
import { breakInsideTransaction } from "../helpers/transactions.js";

/**
 * Avatars (#80): PUT and DELETE /me/avatar, and the avatarUrl every profile
 * now carries.
 *
 * Every image here is real and is really decoded, resized and re-encoded, so
 * the tests check what was STORED — downloaded back through GET /files/:id —
 * not what the API says it stored.
 */

const app = createApp();

let anna: TestUser;
let yuki: TestUser;

beforeEach(async () => {
  anna = await signUpVerifiedAndLogIn(app, "anna@example.com", "Anna");
  yuki = await signUpVerifiedAndLogIn(app, "yuki@example.com", "Yuki");
});

afterEach(() => {
  env.RATE_LIMIT_ENABLED = false;
});

interface ProfileBody {
  profile: { avatarUrl: string | null; displayName: string };
}

function upload(user: TestUser, bytes: Buffer) {
  return request(app)
    .put("/me/avatar")
    .set("Cookie", user.cookie)
    .set("Content-Type", "application/octet-stream")
    .send(bytes);
}

function remove(user: TestUser) {
  return request(app).delete("/me/avatar").set("Cookie", user.cookie);
}

/** Follows an avatarUrl the way a browser would, and returns the bytes. */
async function download(avatarUrl: string): Promise<Buffer> {
  const redirect = await request(app).get(avatarUrl);
  expect(redirect.status).toBe(302);
  const location = redirect.headers.location;
  if (!location) throw new Error("expected a redirect");
  const served = await fetch(location);
  expect(served.status).toBe(200);
  return Buffer.from(await served.arrayBuffer());
}

/** Uploads and returns the stored image's bytes. */
async function uploadAndFetch(user: TestUser, bytes: Buffer) {
  const response = await upload(user, bytes);
  expect(response.status).toBe(200);
  const { avatarUrl } = (response.body as ProfileBody).profile;
  if (!avatarUrl) throw new Error("expected an avatarUrl");
  return download(avatarUrl);
}

async function annasAvatarFiles() {
  return prisma.file.findMany({
    where: { ownerId: anna.id, purpose: "AVATAR" },
  });
}

describe("setting an avatar", () => {
  it("answers with the profile, pointing at the new file by path", async () => {
    const response = await upload(anna, await solidImage(800, 600));

    expect(response.status).toBe(200);
    const { avatarUrl } = (response.body as ProfileBody).profile;
    expect(avatarUrl).toMatch(/^\/files\/[^/]+$/);

    const profile = await prisma.profile.findUniqueOrThrow({
      where: { userId: anna.id },
    });
    expect(avatarUrl).toBe(`/files/${String(profile.avatarFileId)}`);
  });

  it("shows on the public profile and on /auth/me", async () => {
    const response = await upload(anna, await solidImage(300, 300));
    const { avatarUrl } = (response.body as ProfileBody).profile;

    const publicProfile = await request(app).get(`/users/${anna.id}`);
    expect(
      (publicProfile.body as { user: { avatarUrl: string } }).user,
    ).toMatchObject({ avatarUrl });

    const me = await request(app).get("/auth/me").set("Cookie", anna.cookie);
    expect(
      (me.body as { user: { profile: { avatarUrl: string } } }).user.profile
        .avatarUrl,
    ).toBe(avatarUrl);
  });

  it("is null, not absent, on a profile without one", async () => {
    const publicProfile = await request(app).get(`/users/${yuki.id}`);
    const user = (publicProfile.body as { user: Record<string, unknown> }).user;

    expect(user).toHaveProperty("avatarUrl");
    expect(user.avatarUrl).toBeNull();
  });

  it("is only ever the caller's own: another person's profile is untouched", async () => {
    // Anna's upload has to have worked, or "Yuki is untouched" is true of an
    // upload that did nothing at all.
    expect((await upload(anna, await solidImage(300, 300))).status).toBe(200);

    const yukisProfile = await prisma.profile.findUniqueOrThrow({
      where: { userId: yuki.id },
    });
    expect(yukisProfile.avatarFileId).toBeNull();
  });
});

describe("what is stored", () => {
  it("is a square WebP, scaled down to the avatar size", async () => {
    const stored = await uploadAndFetch(anna, await solidImage(2000, 1200));

    expect(await describeImage(stored)).toMatchObject({
      format: "webp",
      width: AVATAR_SIDE,
      height: AVATAR_SIDE,
    });
    expect(AVATAR_SIDE).toBe(512);
  });

  it("is cropped from the middle, not squashed", async () => {
    const stored = await uploadAndFetch(anna, await threeStripes());

    expect(await describeImage(stored)).toMatchObject({
      width: 100,
      height: 100,
    });
    // Both edges: a squashed image keeps its red and blue stripes there.
    expect(await dominantAt(stored, 3, 50)).toBe("green");
    expect(await dominantAt(stored, 96, 50)).toBe("green");
  });

  it("is square, but never larger than it arrived", async () => {
    const stored = await uploadAndFetch(
      anna,
      await solidImage(100, 300, "png"),
    );

    expect(await describeImage(stored)).toMatchObject({
      format: "webp",
      width: 100,
      height: 100,
    });
  });

  it("carries no metadata at all: no GPS, no camera, no name", async () => {
    const photo = await photoWithMetadata();
    // The input really does carry it — otherwise this proves nothing.
    expect(photo.includes(SECRET_ARTIST)).toBe(true);

    const stored = await uploadAndFetch(anna, photo);

    expect(await describeImage(stored)).toMatchObject({
      hasExif: false,
      hasXmp: false,
    });
    expect(stored.includes(SECRET_ARTIST)).toBe(false);
  });

  it("is turned the right way up before the note saying how is thrown away", async () => {
    // Sideways: red on the left, with orientation 6. Turned, red is on top.
    // Cropped square from the middle: the top-middle pixel is red if it was
    // turned, blue if it was not.
    const stored = await uploadAndFetch(anna, await sidewaysPhoto());

    expect(await describeImage(stored)).toMatchObject({
      width: 200,
      height: 200,
    });
    expect(await dominantAt(stored, 150, 20)).toBe("red");
    expect(await dominantAt(stored, 150, 180)).toBe("blue");
  });
});

describe("an upload that is refused changes nothing", () => {
  /**
   * Anna already has an avatar. A refused upload must leave it exactly as it
   * was — same file, same bytes — and add nothing to the store.
   */
  async function expectRefusedWith(
    status: number,
    send: () => Promise<{ status: number }>,
  ) {
    await upload(anna, await solidImage(300, 300));
    const [before] = await annasAvatarFiles();

    // Watch what the refused attempt hands the store, rather than comparing
    // the whole bucket before and after (#109). Anything it did store has to
    // be gone again, and naming the key says that; a listing that matches only
    // says the totals agree.
    const put = vi.spyOn(storage, "put");

    expect((await send()).status).toBe(status);

    const after = await annasAvatarFiles();
    expect(after).toEqual([before]);
    for (const [key] of put.mock.calls) {
      expect(await objectExists(key)).toBe(false);
    }
  }

  it("when it is not an image", async () => {
    await expectRefusedWith(422, () => upload(anna, sample.html()));
  });

  it("when it is an SVG, which is a document that can carry script", async () => {
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><script>alert(1)</script></svg>',
    );
    await expectRefusedWith(422, () => upload(anna, svg));
  });

  it("when it is a GIF", async () => {
    await expectRefusedWith(422, () => upload(anna, sample.gif()));
  });

  it("when it starts like a JPEG and is not one", async () => {
    // Passes the first-bytes check, fails the decoder: 422, not a 500.
    await expectRefusedWith(422, () => upload(anna, sample.jpeg(4096)));
  });

  it("when its header is fine and its picture data is cut short", async () => {
    await expectRefusedWith(422, () =>
      truncatedJpeg().then((image) => upload(anna, image)),
    );
  });

  it("when it is smaller than 64 × 64", async () => {
    await expectRefusedWith(422, () =>
      solidImage(63, 200).then((image) => upload(anna, image)),
    );
  });

  it("when it declares more pixels than anybody's photo has", async () => {
    await expectRefusedWith(422, () =>
      pixelBomb().then((b) => upload(anna, b)),
    );
  });

  it("when it is over the size limit", async () => {
    await expectRefusedWith(422, () =>
      upload(anna, sample.jpeg(MAX_FILE_BYTES + 1)),
    );
  });

  it("when the body is so large it is not even read", async () => {
    await expectRefusedWith(413, () =>
      upload(anna, sample.jpeg(MAX_FILE_BYTES * 2 + 1)),
    );
  });

  it("when there is no body at all", async () => {
    await expectRefusedWith(422, () =>
      request(app).put("/me/avatar").set("Cookie", anna.cookie),
    );
  });
});

/**
 * What is NOT tested here: two uploads from the same person at the same moment.
 * setAvatar locks the profile row so the second waits for the first. Firing two
 * real requests together does not reliably make them overlap — #12 and #19
 * both found a broken version passing every time that way — so a test of it
 * would pass with or without the lock and prove nothing. The lock is argued
 * for in the code instead, and "replacing sweeps up every other avatar file"
 * below is the safety net if it ever fails.
 */
describe("replacing an avatar", () => {
  it("leaves exactly one avatar file, and the old bytes gone", async () => {
    await upload(anna, await solidImage(300, 300));
    const [first] = await annasAvatarFiles();
    if (!first) throw new Error("expected a first avatar");

    await upload(anna, await solidImage(400, 400));

    const files = await annasAvatarFiles();
    expect(files).toHaveLength(1);
    expect(files[0]?.id).not.toBe(first.id);
    expect(await objectExists(first.storageKey)).toBe(false);

    const profile = await prisma.profile.findUniqueOrThrow({
      where: { userId: anna.id },
    });
    expect(profile.avatarFileId).toBe(files[0]?.id);
  });

  it("sweeps up an avatar file nothing points at, left by an earlier failure", async () => {
    const stray = await fileFixture({ ownerId: anna.id, purpose: "AVATAR" });

    await upload(anna, await solidImage(300, 300));

    expect(
      await prisma.file.findUnique({ where: { id: stray.id } }),
    ).toBeNull();
    expect(await objectExists(stray.storageKey)).toBe(false);
  });

  it("never touches anybody else's avatar", async () => {
    await upload(yuki, await solidImage(300, 300));
    const [yukis] = await prisma.file.findMany({ where: { ownerId: yuki.id } });
    if (!yukis) throw new Error("expected Yuki's avatar");

    await upload(anna, await solidImage(300, 300));
    await upload(anna, await solidImage(400, 400));

    expect(await objectExists(yukis.storageKey)).toBe(true);
    expect(
      await prisma.file.findUnique({ where: { id: yukis.id } }),
    ).not.toBeNull();
  });

  it("that fails halfway keeps the old avatar and leaves no new file behind", async () => {
    await upload(anna, await solidImage(300, 300));
    const [old] = await annasAvatarFiles();
    if (!old) throw new Error("expected an avatar");
    const put = vi.spyOn(storage, "put");
    const broken = breakInsideTransaction("profile", "update");

    const response = await upload(anna, await solidImage(400, 400));

    expect(response.status).toBe(500);
    expect(broken.attempts).toBe(1);
    // The old one is still the avatar, bytes and all…
    const profile = await prisma.profile.findUniqueOrThrow({
      where: { userId: anna.id },
    });
    expect(profile.avatarFileId).toBe(old.id);
    expect(await objectExists(old.storageKey)).toBe(true);
    // …and the new one was cleaned up, row and bytes. The key is the one the
    // failed upload actually wrote, so this names what must be gone instead of
    // asking whether the bucket looks the same as it did (#109).
    expect(await annasAvatarFiles()).toEqual([old]);
    expect(put).toHaveBeenCalledOnce();
    const newKey = put.mock.calls[0]?.[0];
    if (!newKey) throw new Error("expected the new avatar bytes to be stored");
    expect(await objectExists(newKey)).toBe(false);
  });
});

describe("removing an avatar", () => {
  it("deletes it, row and bytes, and the profile says null", async () => {
    await upload(anna, await solidImage(300, 300));
    const [file] = await annasAvatarFiles();
    if (!file) throw new Error("expected an avatar");

    const response = await remove(anna);

    expect(response.status).toBe(200);
    expect((response.body as ProfileBody).profile.avatarUrl).toBeNull();
    expect(await annasAvatarFiles()).toEqual([]);
    expect(await objectExists(file.storageKey)).toBe(false);

    const publicProfile = await request(app).get(`/users/${anna.id}`);
    expect(
      (publicProfile.body as { user: { avatarUrl: unknown } }).user.avatarUrl,
    ).toBeNull();
  });

  it("is fine when there is nothing to remove", async () => {
    const response = await remove(anna);

    expect(response.status).toBe(200);
    expect((response.body as ProfileBody).profile.avatarUrl).toBeNull();
  });

  it("that fails halfway removes nothing", async () => {
    await upload(anna, await solidImage(300, 300));
    const [file] = await annasAvatarFiles();
    if (!file) throw new Error("expected an avatar");
    const broken = breakInsideTransaction("profile", "update");

    expect((await remove(anna)).status).toBe(500);

    expect(broken.attempts).toBe(1);
    expect(await annasAvatarFiles()).toEqual([file]);
    expect(await objectExists(file.storageKey)).toBe(true);
  });
});

describe("who may", () => {
  it("not without signing in", async () => {
    const response = await request(app)
      .put("/me/avatar")
      .set("Content-Type", "application/octet-stream")
      .send(await solidImage(300, 300));

    expect(response.status).toBe(401);
  });

  it("not before confirming an email address — an avatar is public at once", async () => {
    const unverified = await signUpAndLogIn(app, "sam@example.com", "Sam");

    expect((await upload(unverified, await solidImage(300, 300))).status).toBe(
      403,
    );
  });

  it(`not more than ${String(RATE_LIMITS.avatar.perUser)} times an hour`, async () => {
    env.RATE_LIMIT_ENABLED = true;
    const tiny = await solidImage(64, 64);

    for (let i = 0; i < RATE_LIMITS.avatar.perUser; i++) {
      expect((await upload(anna, tiny)).status).toBe(200);
    }
    expect((await upload(anna, tiny)).status).toBe(429);
    // Counted per person: somebody else is not caught by Anna's uploads.
    expect((await upload(yuki, tiny)).status).toBe(200);
  });
});

describe("deleting an account (#66)", () => {
  it("removes the avatar's bytes, not only the row", async () => {
    await upload(anna, await solidImage(300, 300));
    const [file] = await annasAvatarFiles();
    if (!file) throw new Error("expected an avatar");

    const deleted = await request(app)
      .delete("/me")
      .set("Cookie", anna.cookie)
      .send({ password: PASSWORD });

    expect(deleted.status).toBe(204);
    expect(await prisma.file.findUnique({ where: { id: file.id } })).toBeNull();
    expect(await objectExists(file.storageKey)).toBe(false);
  });
});
