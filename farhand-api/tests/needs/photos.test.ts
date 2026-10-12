import type { NeedStatus } from "@prisma/client";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/app.js";
import { prisma } from "../../src/db.js";
import { env } from "../../src/env.js";
import {
  MAX_NEED_PHOTO_ASPECT,
  MIN_NEED_PHOTO_SIDE,
  NEED_PHOTO_LONG_EDGE,
} from "../../src/images.js";
import { RATE_LIMITS } from "../../src/middleware/rate-limit.js";
import { MAX_FILE_BYTES } from "../../src/services/files.js";
import { MAX_PHOTOS_PER_NEED } from "../../src/services/need-photos.js";
import { storage } from "../../src/storage.js";
import {
  signUpAndLogIn,
  signUpVerifiedAndLogIn,
  type TestUser,
} from "../helpers/auth.js";
import { objectExists, sample } from "../helpers/files.js";
import { withoutRequestId } from "../helpers/http.js";
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
import { createCategory, needBody } from "../helpers/needs.js";
import { selectsOf, statementsDuring } from "../helpers/queries.js";

/**
 * Photos on a need (#81).
 *
 *   POST   /needs/:id/photos            the image as the body
 *   DELETE /needs/:id/photos/:photoId
 *
 * and the two answers that now carry pictures: `GET /needs/:id` gives a need
 * its `photos`, `GET /needs` gives each card a `coverPhoto`.
 *
 * Every image here is real and is really decoded, resized and re-encoded, so
 * what is checked is what was STORED — downloaded back through the path the
 * API handed out — not what the API says it stored. The same approach as
 * tests/profiles/avatar.test.ts, for the same reason.
 *
 * Who may do what is not a separate rule: a photo is part of what a need says,
 * so it is the need's own rule (`loadEditableOwnNeed`), and the tests below
 * compare the answers to `PATCH /needs/:id`'s rather than restating them.
 */

const app = createApp();

let kadri: TestUser; // the requester, who owns the needs here
let stranger: TestUser;
let categoryId: string;

beforeEach(async () => {
  kadri = await signUpVerifiedAndLogIn(app, "kadri@example.com", "Kadri");
  stranger = await signUpVerifiedAndLogIn(app, "sam@example.com", "Sam");
  categoryId = (await createCategory()).id;
});

afterEach(() => {
  env.RATE_LIMIT_ENABLED = false;
  vi.restoreAllMocks();
});

interface PhotoView {
  id: string;
  url: string;
}
interface PhotoBody {
  photo: PhotoView;
}
interface NeedBody {
  need: { id: string; status: NeedStatus; photos: PhotoView[] };
}
interface ListBody {
  items: { id: string; coverPhoto: string | null }[];
}
interface ErrorBody {
  error: { code: string; message: string };
}

/**
 * A need of this status. DRAFT and OPEN are asked for; the other four are
 * reached by something happening — a deal starting, the sweep, a moderator —
 * so they are set directly. What is being tested is the rule about the status,
 * not the route to it.
 */
async function aNeed(
  status: NeedStatus = "OPEN",
  owner: TestUser = kadri,
): Promise<string> {
  const created = await request(app)
    .post("/needs")
    .set("Cookie", owner.cookie)
    .send(
      needBody(categoryId, { status: status === "DRAFT" ? "DRAFT" : "OPEN" }),
    );

  expect(created.status).toBe(201);
  const { id } = (created.body as { need: { id: string } }).need;

  if (status !== "DRAFT" && status !== "OPEN") {
    await prisma.need.update({ where: { id }, data: { status } });
  }

  return id;
}

function addPhoto(needId: string, user: TestUser, bytes: Buffer) {
  return request(app)
    .post(`/needs/${needId}/photos`)
    .set("Cookie", user.cookie)
    .set("Content-Type", "application/octet-stream")
    .send(bytes);
}

function removePhoto(needId: string, photoId: string, user: TestUser) {
  return request(app)
    .delete(`/needs/${needId}/photos/${photoId}`)
    .set("Cookie", user.cookie);
}

/** A photo on the need, through the endpoint. Fails the test if it is refused. */
async function photo(needId: string, bytes?: Buffer): Promise<PhotoView> {
  const image = bytes ?? (await solidImage(400, 300));
  const response = await addPhoto(needId, kadri, image);

  expect(response.status).toBe(201);
  return (response.body as PhotoBody).photo;
}

/** `count` photos, added one after another, so their order is known. */
async function photos(needId: string, count: number): Promise<PhotoView[]> {
  const added: PhotoView[] = [];
  for (let i = 0; i < count; i++) {
    added.push(await photo(needId, await solidImage(300 + i, 300)));
  }
  return added;
}

/** The need as the API gives it, to `viewer` or to nobody. */
async function needAsSeenBy(
  needId: string,
  viewer?: TestUser,
): Promise<NeedBody["need"]> {
  const pending = request(app).get(`/needs/${needId}`);
  const response = await (viewer
    ? pending.set("Cookie", viewer.cookie)
    : pending);

  expect(response.status).toBe(200);
  return (response.body as NeedBody).need;
}

/** Follows a photo's path the way a browser would, and returns the bytes. */
async function download(url: string): Promise<Buffer> {
  const redirect = await request(app).get(url);
  expect(redirect.status).toBe(302);

  const location = redirect.headers.location;
  if (!location) throw new Error("expected a redirect to the signed URL");

  const served = await fetch(location);
  expect(served.status).toBe(200);
  return Buffer.from(await served.arrayBuffer());
}

/** Uploads one image and returns what was stored for it. */
async function storedBytesOf(needId: string, image: Buffer): Promise<Buffer> {
  return download((await photo(needId, image)).url);
}

function photoRows(needId: string) {
  return prisma.file.findMany({
    where: { needId, purpose: "NEED_PHOTO" },
    orderBy: { createdAt: "asc" },
  });
}

/**
 * Holds the next write to the store until the test lets it go, and says when
 * it got there.
 *
 * This is how the limit's race is tested without two real requests racing.
 * Firing two together does not reliably make them overlap — #12, #19 and #80
 * all found that a broken version passes every time that way — so the overlap
 * is arranged instead: one upload is stopped in the one place where a second
 * one can get past it, which is the slow call to the store that sits between
 * counting and inserting.
 */
function holdNextWriteToStore() {
  let letGo!: () => void;
  let itArrived!: () => void;
  const held = new Promise<void>((resolve) => (letGo = resolve));
  const arrived = new Promise<void>((resolve) => (itArrived = resolve));

  const real = storage.put.bind(storage);
  const put = vi.spyOn(storage, "put");
  put.mockImplementationOnce(async (key, bytes, contentType) => {
    itArrived();
    await held;
    return real(key, bytes, contentType);
  });

  return { arrived, letGo, put };
}

/**
 * Waits until Postgres itself says a connection is stuck waiting for a lock on
 * a Need, and fails the moment it becomes clear that none ever will.
 *
 * `pg_stat_activity` is the honest witness here: a backend blocked on a row
 * lock is recorded as waiting, with the statement it is waiting to run. A
 * clock cannot tell "blocked" from "slow", and this can.
 *
 * `finishedWithoutWaiting` is the other outcome — the upload completed, so
 * there was no lock to wait for — and checking it each time round makes the
 * failure immediate and specific rather than a timeout at the end.
 *
 * The suite is strictly sequential (`fileParallelism: false` in
 * vitest.config.ts), so nothing else can be holding a lock at the same time.
 * The statement is matched anyway, because a test that says what it means is
 * worth more than one that happens to be alone.
 */
async function waitForABackendBlockedOnTheNeed(
  finishedWithoutWaiting: () => boolean,
  timeoutMs = 3000,
): Promise<void> {
  const until = Date.now() + timeoutMs;

  for (;;) {
    if (finishedWithoutWaiting()) {
      throw new Error(
        "the upload finished while this transaction held the need's row: " +
          "nothing locked it, so counting and inserting are not one step",
      );
    }

    const [waiting] = await prisma.$queryRaw<{ blocked: bigint }[]>`
      SELECT count(*) AS blocked FROM pg_stat_activity
      WHERE datname = current_database()
        AND wait_event_type = 'Lock'
        AND query ILIKE '%"Need"%FOR UPDATE%'`;

    if (Number(waiting?.blocked ?? 0) > 0) return;

    if (Date.now() > until) {
      throw new Error("no connection ever waited for a lock on the need");
    }

    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe("adding a photo", () => {
  it("answers with the photo and the path that serves it", async () => {
    const needId = await aNeed();

    const response = await addPhoto(needId, kadri, await solidImage(800, 600));

    expect(response.status).toBe(201);
    const added = (response.body as PhotoBody).photo;
    expect(added.url).toBe(`/files/${added.id}`);

    const [row] = await photoRows(needId);
    expect(row).toMatchObject({
      id: added.id,
      ownerId: kadri.id,
      purpose: "NEED_PHOTO",
      needId,
      mimeType: "image/webp",
    });
  });

  it("shows on the need, and anybody may see it while the need is open", async () => {
    const needId = await aNeed();
    const added = await photo(needId);

    expect((await needAsSeenBy(needId)).photos).toEqual([added]);
    // Signed out, following the path the answer gave: the picture is there.
    expect(await describeImage(await download(added.url))).toMatchObject({
      format: "webp",
    });
  });

  it("lists them oldest first, which is the order they were added", async () => {
    const needId = await aNeed();
    const added = await photos(needId, 3);

    expect((await needAsSeenBy(needId)).photos).toEqual(added);
  });

  it("can be added to a draft, where only its owner can see it", async () => {
    const needId = await aNeed("DRAFT");
    const added = await photo(needId);

    expect((await needAsSeenBy(needId, kadri)).photos).toEqual([added]);
    // The need itself is hidden from everybody else, so its photos are too —
    // the rule is the need's, not a second one for pictures (#79).
    expect((await request(app).get(`/needs/${needId}`)).status).toBe(404);
    expect((await request(app).get(added.url)).status).toBe(404);
  });
});

describe("what is stored", () => {
  it(`is a WebP, no longer than ${String(NEED_PHOTO_LONG_EDGE)} on its long edge`, async () => {
    const needId = await aNeed();

    const stored = await storedBytesOf(needId, await solidImage(2560, 1440));

    expect(await describeImage(stored)).toMatchObject({
      format: "webp",
      width: NEED_PHOTO_LONG_EDGE,
      height: 720,
    });
    expect(NEED_PHOTO_LONG_EDGE).toBe(1280);
  });

  it("keeps the shape it arrived in, tall as well as wide", async () => {
    const needId = await aNeed();

    const stored = await storedBytesOf(needId, await solidImage(1000, 2000));

    // The avatar rule would have made this 512 × 512 and thrown half the
    // bottle away. A photo of a product is the thing being asked for.
    expect(await describeImage(stored)).toMatchObject({
      width: 640,
      height: NEED_PHOTO_LONG_EDGE,
    });
  });

  it("is never enlarged", async () => {
    const needId = await aNeed();

    const stored = await storedBytesOf(
      needId,
      await solidImage(300, 220, "png"),
    );

    expect(await describeImage(stored)).toMatchObject({
      format: "webp",
      width: 300,
      height: 220,
    });
  });

  it("is not cropped: both edges survive, not only the middle", async () => {
    const needId = await aNeed();

    // Red, green, blue stripes. Cropped from the middle this is all green.
    const stored = await storedBytesOf(needId, await threeStripes(400));

    expect(await describeImage(stored)).toMatchObject({
      width: 1200,
      height: 400,
    });
    expect(await dominantAt(stored, 10, 200)).toBe("red");
    expect(await dominantAt(stored, 1190, 200)).toBe("blue");
  });

  it("carries no metadata at all: no GPS, no camera, no name", async () => {
    const needId = await aNeed();
    const photoFile = await photoWithMetadata();
    // The input really does carry it — otherwise this proves nothing.
    expect(photoFile.includes(SECRET_ARTIST)).toBe(true);

    const stored = await storedBytesOf(needId, photoFile);

    expect(await describeImage(stored)).toMatchObject({
      hasExif: false,
      hasXmp: false,
    });
    expect(stored.includes(SECRET_ARTIST)).toBe(false);
  });

  it("is turned the right way up before the note saying how is thrown away", async () => {
    const needId = await aNeed();

    // 400 × 200, red on the left, with orientation 6. Turned as the note says
    // it is 200 × 400 with red on TOP — and, unlike an avatar, uncropped, so
    // the blue half is still there at the bottom.
    const stored = await storedBytesOf(needId, await sidewaysPhoto());

    expect(await describeImage(stored)).toMatchObject({
      width: 200,
      height: 400,
    });
    expect(await dominantAt(stored, 100, 20)).toBe("red");
    expect(await dominantAt(stored, 100, 380)).toBe("blue");
  });
});

describe("the limit of six", () => {
  it("allows six and refuses the seventh, naming the limit", async () => {
    const needId = await aNeed();
    await photos(needId, MAX_PHOTOS_PER_NEED);

    const seventh = await addPhoto(needId, kadri, await solidImage(400, 300));

    expect(seventh.status).toBe(409);
    expect((seventh.body as ErrorBody).error.message).toContain(
      String(MAX_PHOTOS_PER_NEED),
    );
    expect(await photoRows(needId)).toHaveLength(MAX_PHOTOS_PER_NEED);
    expect(MAX_PHOTOS_PER_NEED).toBe(6);
  });

  it("refuses the seventh before paying to re-encode it", async () => {
    const needId = await aNeed();
    await photos(needId, MAX_PHOTOS_PER_NEED);
    const put = vi.spyOn(storage, "put");

    expect(
      (await addPhoto(needId, kadri, await solidImage(400, 300))).status,
    ).toBe(409);

    // Nothing was written to the store, so there is nothing to clean up: the
    // ordinary "you already have six" costs one query and no image work.
    expect(put).not.toHaveBeenCalled();
  });

  it("is per need: a second need starts empty", async () => {
    const full = await aNeed();
    await photos(full, MAX_PHOTOS_PER_NEED);
    const another = await aNeed();

    expect(
      (await addPhoto(another, kadri, await solidImage(400, 300))).status,
    ).toBe(201);
  });

  it("cannot be beaten by two uploads at the same moment", async () => {
    const needId = await aNeed();
    await photos(needId, MAX_PHOTOS_PER_NEED - 1);
    const image = await solidImage(400, 300);
    const { arrived, letGo, put } = holdNextWriteToStore();

    // The first upload gets as far as the store and stops there, past the
    // cheap count — which said five, truthfully, at the time.
    const first = addPhoto(needId, kadri, image).then((response) => response);
    await arrived;

    // The second one runs to completion in the meantime and takes the sixth
    // place. Nothing about the first request is wrong; it is simply no longer
    // the one that fits.
    const second = await addPhoto(needId, kadri, image);
    expect(second.status).toBe(201);

    letGo();
    const refused = await first;

    expect(refused.status).toBe(409);
    expect(await photoRows(needId)).toHaveLength(MAX_PHOTOS_PER_NEED);
    // And the bytes it had already written are gone: a refused upload leaves
    // nothing, not even something invisible (#79's order).
    const heldKey = put.mock.calls[0]?.[0];
    if (!heldKey) throw new Error("expected the held upload to store bytes");
    expect(await objectExists(heldKey)).toBe(false);
  });

  it("counts inside a lock on the need, so a second count cannot overlap", async () => {
    const needId = await aNeed();
    const image = await solidImage(400, 300);
    let settled = false;
    let inFlight: Promise<{ status: number }> | undefined;

    // Holding the need's row is enough to stop an upload in its tracks, and
    // Postgres is asked whether that is what happened rather than a clock: an
    // earlier draft of this test waited 400 ms and called "still going" proof,
    // which on a slow machine is also true of an upload that never waited for
    // anything — re-encoding alone can take that long. CI is exactly that
    // machine (#110 is this project's lesson about measuring the wrong thing).
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM "Need" WHERE id = ${needId} FOR UPDATE`;

      inFlight = addPhoto(needId, kadri, image).then((response) => {
        settled = true;
        return response;
      });

      await waitForABackendBlockedOnTheNeed(() => settled);
    });

    // Released by the commit above, it finishes normally.
    expect((await inFlight)?.status).toBe(201);
  });
});

describe("an upload that is refused changes nothing", () => {
  /**
   * The need already has one photo. A refused upload must leave exactly that
   * one, and add nothing to the store.
   *
   * What the refused attempt handed the store is watched by name, rather than
   * comparing the whole bucket before and after (#109): anything it stored has
   * to be gone again, and naming the key says that.
   */
  async function expectRefusedWith(
    status: number,
    send: (needId: string) => Promise<{ status: number; body: unknown }>,
  ): Promise<ErrorBody> {
    const needId = await aNeed();
    const kept = await photo(needId);
    const put = vi.spyOn(storage, "put");

    const response = await send(needId);
    expect(response.status).toBe(status);

    expect((await needAsSeenBy(needId)).photos).toEqual([kept]);
    for (const [key] of put.mock.calls) {
      expect(await objectExists(key)).toBe(false);
    }

    return response.body as ErrorBody;
  }

  it("when it is not an image", async () => {
    await expectRefusedWith(422, (id) => addPhoto(id, kadri, sample.html()));
  });

  it("when it is an SVG, which is a document that can carry script", async () => {
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400"><script>alert(1)</script></svg>',
    );
    await expectRefusedWith(422, (id) => addPhoto(id, kadri, svg));
  });

  it("when it is a GIF", async () => {
    await expectRefusedWith(422, (id) => addPhoto(id, kadri, sample.gif()));
  });

  it("when it starts like a JPEG and is not one", async () => {
    await expectRefusedWith(422, (id) =>
      addPhoto(id, kadri, sample.jpeg(4096)),
    );
  });

  it("when its header is fine and its picture data is cut short", async () => {
    await expectRefusedWith(422, async (id) =>
      addPhoto(id, kadri, await truncatedJpeg()),
    );
  });

  it(`when its shorter side is under ${String(MIN_NEED_PHOTO_SIDE)}px`, async () => {
    const body = await expectRefusedWith(422, async (id) =>
      addPhoto(id, kadri, await solidImage(MIN_NEED_PHOTO_SIDE - 1, 400)),
    );

    expect(body.error.message).toContain(String(MIN_NEED_PHOTO_SIDE));
  });

  it("when it is far longer than it is wide — a scrolling screenshot", async () => {
    // 1 : 4. Capping the long edge would make it 320 × 1280 and the small
    // print, which is the whole reason somebody sends such a picture, would be
    // gone. So it is refused, and the message says what to do about it.
    const body = await expectRefusedWith(422, async (id) =>
      addPhoto(id, kadri, await solidImage(300, 1200)),
    );

    expect(body.error.message).toMatch(/crop/i);
  });

  it("but not at the limit itself, which is a whole phone screen", async () => {
    const needId = await aNeed();

    const stored = await storedBytesOf(
      needId,
      await solidImage(400, 400 * MAX_NEED_PHOTO_ASPECT),
    );

    expect(await describeImage(stored)).toMatchObject({
      width: 400,
      height: 1200,
    });
    expect(MAX_NEED_PHOTO_ASPECT).toBe(3);
  });

  it("so the narrowest thing that can be stored is still readable", async () => {
    const needId = await aNeed();

    // The two constants together are a promise about legibility, and this is
    // the worst case of it: as lopsided as the rule allows AND long enough to
    // be scaled down, so the short edge takes the full reduction. 600 × 1800
    // becomes 427 × 1280 — which is why anything more lopsided is refused
    // instead of quietly shrunk to 230 px of unreadable small print.
    const stored = await storedBytesOf(needId, await solidImage(600, 1800));

    const { width, height } = await describeImage(stored);
    expect(height).toBe(NEED_PHOTO_LONG_EDGE);
    expect(width).toBeGreaterThanOrEqual(
      Math.floor(NEED_PHOTO_LONG_EDGE / MAX_NEED_PHOTO_ASPECT),
    );
  });

  it("when it declares more pixels than anybody's photo has", async () => {
    await expectRefusedWith(422, async (id) =>
      addPhoto(id, kadri, await pixelBomb()),
    );
  });

  it("when it is over the size limit", async () => {
    await expectRefusedWith(422, (id) =>
      addPhoto(id, kadri, sample.jpeg(MAX_FILE_BYTES + 1)),
    );
  });

  it("when the body is so large it is not even read", async () => {
    await expectRefusedWith(413, (id) =>
      addPhoto(id, kadri, sample.jpeg(MAX_FILE_BYTES * 2 + 1)),
    );
  });

  it("when there is no body at all", async () => {
    await expectRefusedWith(422, (id) =>
      request(app).post(`/needs/${id}/photos`).set("Cookie", kadri.cookie),
    );
  });
});

describe("removing a photo", () => {
  it("takes the row and the bytes, and the need stops listing it", async () => {
    const needId = await aNeed();
    const added = await photo(needId);
    const [row] = await photoRows(needId);
    if (!row) throw new Error("expected the photo's row");

    const response = await removePhoto(needId, added.id, kadri);

    expect(response.status).toBe(204);
    expect((await needAsSeenBy(needId)).photos).toEqual([]);
    expect(
      await prisma.file.findUnique({ where: { id: added.id } }),
    ).toBeNull();
    expect(await objectExists(row.storageKey)).toBe(false);
  });

  it("leaves the others in the order they were added", async () => {
    const needId = await aNeed();
    const [first, second, third] = await photos(needId, 3);
    if (!second) throw new Error("expected three photos");

    expect((await removePhoto(needId, second.id, kadri)).status).toBe(204);

    expect((await needAsSeenBy(needId)).photos).toEqual([first, third]);
  });

  it("makes room: the sixth may be replaced after the fifth is gone", async () => {
    const needId = await aNeed();
    const six = await photos(needId, MAX_PHOTOS_PER_NEED);
    const last = six.at(-1);
    if (!last) throw new Error("expected six photos");

    expect((await removePhoto(needId, last.id, kadri)).status).toBe(204);

    expect(
      (await addPhoto(needId, kadri, await solidImage(400, 300))).status,
    ).toBe(201);
  });

  it("refuses a photo id that belongs to another need, and deletes nothing", async () => {
    const mine = await aNeed();
    const other = await aNeed();
    const theirs = await photo(other);
    const [row] = await photoRows(other);
    if (!row) throw new Error("expected the other need's photo");

    const response = await removePhoto(mine, theirs.id, kadri);

    // Both needs are Kadri's, so this is not about permission: the path says
    // which need, and a photo of a different one is not at that address.
    expect(response.status).toBe(404);
    expect(
      await prisma.file.findUnique({ where: { id: theirs.id } }),
    ).not.toBeNull();
    expect(await objectExists(row.storageKey)).toBe(true);
  });

  it("refuses an id that never existed, the same way", async () => {
    const needId = await aNeed();

    const response = await removePhoto(
      needId,
      "cm0doesnotexist000000000",
      kadri,
    );

    expect(response.status).toBe(404);
  });

  it("refuses the second removal of the same photo", async () => {
    const needId = await aNeed();
    const added = await photo(needId);

    expect((await removePhoto(needId, added.id, kadri)).status).toBe(204);
    // Not idempotent, deliberately: the id now names nothing, and a 204 would
    // claim something was there. Removing *an avatar* is "have none", which is
    // a state; removing a photo is about one particular picture.
    expect((await removePhoto(needId, added.id, kadri)).status).toBe(404);
  });

  it("is not something a stranger can do", async () => {
    const needId = await aNeed();
    const added = await photo(needId);
    const [row] = await photoRows(needId);
    if (!row) throw new Error("expected the photo's row");

    const response = await removePhoto(needId, added.id, stranger);

    expect(response.status).toBe(403);
    expect(await objectExists(row.storageKey)).toBe(true);
    expect((await needAsSeenBy(needId)).photos).toEqual([added]);
  });
});

/**
 * The answers to "who may touch this need" are the need's own, so they are
 * compared to `PATCH /needs/:id` rather than written out again. If the two ever
 * disagree, one of them is a second copy of the rule — which is the thing
 * `loadEditableOwnNeed` exists to prevent.
 */
describe("who may add and remove", () => {
  function patchNeed(needId: string, user: TestUser) {
    return request(app)
      .patch(`/needs/${needId}`)
      .set("Cookie", user.cookie)
      .send({ title: "Something else entirely" });
  }

  it("gives somebody else's need the same 403 as editing it", async () => {
    const needId = await aNeed("OPEN", kadri);
    const put = vi.spyOn(storage, "put");

    const refused = await addPhoto(
      needId,
      stranger,
      await solidImage(400, 300),
    );
    const editing = await patchNeed(needId, stranger);

    expect(refused.status).toBe(403);
    expect(withoutRequestId(refused.body)).toEqual(
      withoutRequestId(editing.body),
    );
    expect(put).not.toHaveBeenCalled();
  });

  it("gives a need that does not exist the same 404 as editing it", async () => {
    const missing = "cm0doesnotexist000000000";

    const refused = await addPhoto(missing, kadri, await solidImage(400, 300));
    const editing = await patchNeed(missing, kadri);

    expect(refused.status).toBe(404);
    expect(withoutRequestId(refused.body)).toEqual(
      withoutRequestId(editing.body),
    );
  });

  it("not without signing in", async () => {
    const needId = await aNeed();

    const response = await request(app)
      .post(`/needs/${needId}/photos`)
      .set("Content-Type", "application/octet-stream")
      .send(await solidImage(400, 300));

    expect(response.status).toBe(401);
  });

  it("not before confirming an email address — a photo is public at once", async () => {
    const unverified = await signUpAndLogIn(app, "new@example.com", "Nell");
    // Their own need, so what is being refused is the upload and not the need:
    // an unverified account cannot create one through the API, so this one is
    // made directly.
    const need = await prisma.need.create({
      data: {
        requesterId: unverified.id,
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

    expect(
      (await addPhoto(need.id, unverified, await solidImage(400, 300))).status,
    ).toBe(403);
  });

  it(`not more than ${String(RATE_LIMITS.needPhoto.perUser)} uploads an hour`, async () => {
    env.RATE_LIMIT_ENABLED = true;
    const needId = await aNeed();
    const tiny = await solidImage(MIN_NEED_PHOTO_SIDE, MIN_NEED_PHOTO_SIDE);

    for (let i = 0; i < RATE_LIMITS.needPhoto.perUser; i++) {
      // A refused upload still spends a request: the limiter runs before the
      // service, which is the only place it can run if deciding is itself to
      // be limited. So the first six are stored and the rest are 409s, and all
      // of them count.
      expect((await addPhoto(needId, kadri, tiny)).status).toBe(
        i < MAX_PHOTOS_PER_NEED ? 201 : 409,
      );
    }

    expect((await addPhoto(needId, kadri, tiny)).status).toBe(429);

    // Counted per person: somebody else is not caught by Kadri's uploads.
    const theirs = await aNeed("OPEN", stranger);
    expect((await addPhoto(theirs, stranger, tiny)).status).toBe(201);
  });
});

/**
 * A need stops being editable the moment somebody has acted on what it said.
 * Pictures are part of what it said.
 */
describe.each<NeedStatus>(["MATCHED", "CLOSED", "EXPIRED", "REMOVED"])(
  "a %s need",
  (status) => {
    it("cannot gain a photo", async () => {
      const needId = await aNeed(status);
      const put = vi.spyOn(storage, "put");

      const response = await addPhoto(
        needId,
        kadri,
        await solidImage(400, 300),
      );

      expect(response.status).toBe(409);
      expect(put).not.toHaveBeenCalled();
    });

    it("cannot lose one either", async () => {
      const needId = await aNeed("OPEN");
      const added = await photo(needId);
      await prisma.need.update({ where: { id: needId }, data: { status } });

      const response = await removePhoto(needId, added.id, kadri);

      expect(response.status).toBe(409);
      expect(
        await prisma.file.findUnique({ where: { id: added.id } }),
      ).not.toBeNull();
    });
  },
);

describe("needs carry their pictures", () => {
  it("gives each card in the list the first photo, as a path", async () => {
    const withPictures = await aNeed();
    const [first] = await photos(withPictures, 3);
    if (!first) throw new Error("expected three photos");
    const without = await aNeed();

    const response = await request(app).get("/needs");

    expect(response.status).toBe(200);
    const items = (response.body as ListBody).items;
    expect(items.find((item) => item.id === withPictures)?.coverPhoto).toBe(
      first.url,
    );
    // Null, not absent: a card with no picture is a case the client draws,
    // not a field it has to guess at.
    const bare = items.find((item) => item.id === without);
    expect(bare).toHaveProperty("coverPhoto");
    expect(bare?.coverPhoto).toBeNull();
  });

  it("gives the caller's own list the same field, drafts included", async () => {
    const draft = await aNeed("DRAFT");
    const added = await photo(draft);

    const response = await request(app)
      .get("/me/needs")
      .set("Cookie", kadri.cookie);

    expect(response.status).toBe(200);
    const mine = (response.body as ListBody).items.find(
      (item) => item.id === draft,
    );
    expect(mine?.coverPhoto).toBe(added.url);
  });

  it("costs a page of needs ONE query for all their photos, not one each", async () => {
    for (let i = 0; i < 4; i++) {
      await photos(await aNeed(), 2);
    }

    const statements = await statementsDuring(async () => {
      const response = await request(app).get("/needs?limit=4");
      expect(response.status).toBe(200);
      expect((response.body as ListBody).items).toHaveLength(4);
    });

    // The mistake #102 measured, in its other form: a loop that looks like one
    // line and is four round trips. Four needs, one SELECT of File.
    expect(selectsOf(statements, "File")).toBe(1);
  });
});
