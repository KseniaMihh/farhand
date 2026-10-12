import type { Prisma, User } from "@prisma/client";
import type { Logger } from "pino";
import { prisma } from "../db.js";
import { HttpError } from "../errors.js";
import { normaliseNeedPhoto } from "../images.js";
import { storage } from "../storage.js";
import {
  checkUpload,
  deleteStoredBytes,
  filePath,
  storeBytes,
  storeFileRow,
} from "./files.js";
import { loadEditableOwnNeed } from "./needs.js";

/**
 * Photos on a need (#81).
 *
 * `File` has carried an optional `needId` since the first week, and #79 built
 * everything underneath: the private bucket, the signed-link reader, and the
 * rule saying who may see a `NEED_PHOTO`. This is the half that puts them
 * there and takes them away.
 *
 * Who may do what: docs/06-api-contract.md, "Needs". The short version is that
 * a photo follows its need — anybody who may see the need may see its photos,
 * and only the requester may add or remove one, and only while the need is
 * still editable. That last rule is not restated here: it is
 * `loadEditableOwnNeed` in services/needs.ts, the same call `PATCH /needs/:id`
 * makes, because a photo is part of what a need says.
 */

/**
 * How many photos one need may carry.
 *
 * Six is a few angles plus the small print, which is often the actual reason
 * somebody is asking a stranger abroad to buy a thing. It is also the number
 * #102's arithmetic has to live with: a need's own page is up to six images,
 * each costing a request to the API and a request to the store.
 */
export const MAX_PHOTOS_PER_NEED = 6;

/** What a photo looks like in an answer: an id, and the path that serves it. */
export interface NeedPhotoView {
  id: string;
  url: string;
}

/**
 * A path, never a signed link (decision 0012): a signed link dies in five
 * minutes, and anything that stored the answer would die with it.
 */
function photoView(id: string): NeedPhotoView {
  return { id, url: filePath(id) };
}

/**
 * Refuses a seventh photo, counting on whichever client it is given.
 *
 * Called twice per upload, which is the point. Once on the plain client before
 * anything expensive happens, so the ordinary "you already have six" costs one
 * SELECT and no image work at all. Once more inside the transaction below, on
 * `tx`, where the answer is the one that is allowed to be trusted.
 */
async function assertUnderPhotoLimit(
  needId: string,
  client: Prisma.TransactionClient,
): Promise<void> {
  const count = await client.file.count({
    where: { needId, purpose: "NEED_PHOTO" },
  });

  if (count >= MAX_PHOTOS_PER_NEED) {
    throw HttpError.conflict(
      `This need already has ${String(MAX_PHOTOS_PER_NEED)} photos. ` +
        `Remove one before adding another.`,
    );
  }
}

/**
 * Stores one photo against a need.
 *
 * THE LIMIT IS NOT A COUNT FOLLOWED BY AN INSERT. Between the two sits the
 * re-encode, the slowest thing this API does, so two uploads from the same
 * person at five photos would both count five, both pass, and the need would
 * end up with seven. It is the check-then-act race docs/06-api-contract.md
 * already describes for reports — "two taps on a slow connection both read
 * 'nothing yet'" — where the answer was a database constraint. A limit on a
 * number of rows cannot be a unique index, so it is a lock instead, the same
 * one setAvatar uses (services/avatars.ts): the need's own row, held while
 * this upload counts what is there and adds itself to it.
 *
 * The order, then:
 *
 *   1. who and whether          loadEditableOwnNeed — 404, 403 or 409
 *   2. size and type            checkUpload, BEFORE the decoder sees anything
 *   3. the cheap count          so a seventh photo is never re-encoded
 *   4. normalise                the expensive step
 *   5. bytes to the store       outside the transaction: another machine
 *   6. lock, count, insert      one indivisible step
 *
 * A photo refused at 6 leaves nothing behind: the bytes stored at step 5 are
 * deleted when the transaction does not commit, the invisible side of #79's
 * two orders.
 */
export async function addNeedPhoto(
  needId: string,
  user: User,
  bytes: Buffer,
): Promise<NeedPhotoView> {
  const need = await loadEditableOwnNeed(user, needId);

  // Before the image library, never after: a file that is not a JPEG, PNG or
  // WebP — an SVG, which is a document that can carry script — must not reach
  // a decoder at all (#80).
  //
  // `storeBytes` checks again, and that is not the same check: by then the
  // bytes are the WebP we produced, so they always pass. Deleting this line
  // and running the suite answers 201 to an SVG (sharp decodes those happily)
  // and 500 to an empty body, because `sharp()` throws on an empty buffer
  // before the try/catch that turns a bad image into a 422. Measured, in a
  // variant run, rather than argued.
  checkUpload(bytes, "NEED_PHOTO");
  await assertUnderPhotoLimit(need.id, prisma);

  const normalised = await normaliseNeedPhoto(bytes);
  const stored = await storeBytes(normalised, "NEED_PHOTO");

  try {
    const file = await prisma.$transaction(async (tx) => {
      // Two uploads at once (two tabs, a double tap) both counted five a
      // moment ago. From here they are in a queue: the first adds the sixth
      // photo, the second wakes up, counts six, and is refused. Which of them
      // wins is arbitrary; that only one of them does is not.
      await tx.$queryRaw`SELECT 1 FROM "Need"
                         WHERE id = ${need.id} FOR UPDATE`;

      await assertUnderPhotoLimit(need.id, tx);

      return storeFileRow(
        stored,
        { ownerId: user.id, purpose: "NEED_PHOTO", needId: need.id },
        tx,
      );
    });

    return photoView(file.id);
  } catch (error) {
    // The bytes are stored and nothing points at them — because the count
    // refused this upload, or because the insert failed. Either way they are
    // invisible garbage, so remove them, best effort (#79), and report the
    // failure that actually happened.
    await storage.delete(stored.storageKey).catch(() => undefined);
    throw error;
  }
}

/**
 * Removes one photo, row and bytes.
 *
 * Bytes after the row, and only if the row really went — the order #79 chose
 * because bytes without a row are invisible while a row without bytes is a
 * broken image somebody can see.
 *
 * No lock. Two requests to remove the same photo leave the same one photo
 * removed: the `deleteMany` that changed nothing is the one that lost, and it
 * must not go on to delete bytes the winner's row no longer covers.
 */
export async function removeNeedPhoto(
  needId: string,
  photoId: string,
  user: User,
  log: Logger,
): Promise<void> {
  const need = await loadEditableOwnNeed(user, needId);

  // `needId` is part of the question, not decoration: a photo id belonging to
  // another need — even another need of this same owner — is not at this
  // address, and must not be deleted through it.
  const photo = await prisma.file.findFirst({
    where: { id: photoId, needId: need.id, purpose: "NEED_PHOTO" },
    select: { id: true, storageKey: true },
  });

  if (!photo) {
    throw HttpError.notFound("Photo not found");
  }

  const removed = await prisma.file.deleteMany({ where: { id: photo.id } });

  if (removed.count === 0) {
    // Somebody else removed it between the two statements. The id names
    // nothing now, which is exactly what a second DELETE of it means — and
    // not deleting the bytes matters more than the status: the winner's row
    // is gone, but these bytes may be the ones it is about to delete itself.
    //
    // NOT COVERED BY A TEST, and labelled rather than left looking covered:
    // it needs two removals of one photo to interleave between the lookup and
    // the delete. A variant run with this check deleted shows nothing at all,
    // because every reachable path has already answered 404 above (#111's
    // habit of writing down which broken versions cannot be caught).
    throw HttpError.notFound("Photo not found");
  }

  await deleteStoredBytes([photo.storageKey], log);
}

/**
 * The photos of one need, oldest first.
 *
 * Oldest first so the order is stable and is the order they were added, with
 * the id breaking ties: six uploads can share a `createdAt` to the
 * millisecond, and sorting by it alone leaves their order undefined — the
 * reason the cursor in services/shared.ts carries both.
 *
 * There is no position column and this issue does not add one: re-ordering is
 * a feature nobody has asked for, and a column that exists but is never set is
 * the kind of thing #103 spent two releases removing.
 */
export async function needPhotos(needId: string): Promise<NeedPhotoView[]> {
  const rows = await prisma.file.findMany({
    where: { needId, purpose: "NEED_PHOTO" },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true },
  });

  return rows.map((row) => photoView(row.id));
}

/**
 * The first photo of each of several needs, for list answers.
 *
 * ONE QUERY FOR THE WHOLE PAGE, never one per need — the mistake #102
 * measured, in the form a loop makes it: twenty needs is twenty round trips
 * that look like one line of code.
 *
 * It reads every photo of the page and keeps the first of each, rather than
 * asking Postgres for one row per need with `DISTINCT ON`. A page of twenty
 * fully photographed needs is 120 rows of two short columns, which is one
 * round trip and a few kilobytes; `DISTINCT ON` would trade a typed query for
 * raw SQL to save the kilobytes and not the round trip. If #93's real page
 * says otherwise, that measurement is the reason to change it.
 */
export async function coverPhotos(
  needIds: string[],
): Promise<Map<string, string>> {
  if (needIds.length === 0) {
    return new Map();
  }

  const rows = await prisma.file.findMany({
    where: { needId: { in: needIds }, purpose: "NEED_PHOTO" },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true, needId: true },
  });

  const covers = new Map<string, string>();
  for (const row of rows) {
    if (row.needId !== null && !covers.has(row.needId)) {
      covers.set(row.needId, filePath(row.id));
    }
  }

  return covers;
}

/* ─────────────────────────── needs, with pictures ─────────────────────────── */

/**
 * One need as an answer gives it: its own fields, plus every photo.
 *
 * A wrapper rather than something `getVisibleNeed` does, so the rule about who
 * may see the NEED stays one function with one job (#15's argument), and the
 * photos are added where the answer is assembled.
 */
export async function withPhotos<T extends { id: string }>(
  need: T,
): Promise<T & { photos: NeedPhotoView[] }> {
  return { ...need, photos: await needPhotos(need.id) };
}

/**
 * A page of needs, each with the path of its first photo or null.
 *
 * `coverPhoto`, not `photos`, and a bare path rather than an object: a list is
 * drawn as cards, and a card shows one picture. Six photos per row of a page
 * of twenty is 120 paths nobody renders — and the id each photo view carries
 * is for deleting it, which happens on the need's own page (decision 0012 for
 * why these are paths and not signed links).
 */
export async function withCoverPhotos<T extends { id: string }>(
  needs: T[],
): Promise<(T & { coverPhoto: string | null })[]> {
  const covers = await coverPhotos(needs.map((need) => need.id));

  return needs.map((need) => ({
    ...need,
    coverPhoto: covers.get(need.id) ?? null,
  }));
}
