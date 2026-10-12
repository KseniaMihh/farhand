import sharp from "sharp";
import { HttpError } from "./errors.js";

/**
 * What happens to an image before it is stored.
 *
 * ONE FILE KNOWS ABOUT SHARP, the image library — the same seam as
 * src/storage.ts for S3 and src/observability.ts for Sentry. sharp is a native
 * module, the kind Windows' Smart App Control blocked once already (#70), and
 * `@img/sharp-wasm32` is installed beside it as the same kind of fallback the
 * password library has: slower, never blocked.
 *
 * Avatars are re-encoded rather than stored as uploaded (#80), for three
 * reasons: a phone photo's metadata often holds the GPS position it was taken
 * at, which for a selfie is usually somebody's home; a 4 MB photo shown as a
 * 64 px circle is 4 MB nobody needed; and one format and one size are what a
 * frontend can rely on.
 */

/** The longest side an avatar is stored at. Square, so both sides. */
export const AVATAR_SIDE = 512;

/** Smaller than this is refused: it would be a blur at any size it is shown. */
export const MIN_AVATAR_SIDE = 64;

/**
 * The longest side a need's photo is stored at — the LONGEST, not both (#81).
 *
 * An avatar is cropped square because a face fits a square and every avatar
 * being the same shape is worth more than the corners. A photo of a product is
 * the opposite: crop it and you throw away the product. A tall bottle, a wide
 * box and a screenshot of an ingredient list all have to survive, so the
 * aspect ratio is kept and only the long edge is capped.
 *
 * 1280 rather than 512 because these are read, not glanced at. Half the reason
 * somebody asks a stranger abroad to buy a thing is the small print on the
 * back of it.
 *
 * Why there is no crop, and why a shape beyond MAX_NEED_PHOTO_ASPECT is
 * refused rather than squeezed into this:
 * docs/10-decisions/0013-need-photos-keep-their-shape.md
 */
export const NEED_PHOTO_LONG_EDGE = 1280;

/** Below this a photo shows nothing useful about a product. */
export const MIN_NEED_PHOTO_SIDE = 200;

/**
 * The most lopsided a need's photo may be, long edge over short edge.
 *
 * Capping only the long edge has a failure the avatar rule cannot have: a
 * scrolling screenshot of 1080 × 6000 becomes 230 × 1280, and the small print
 * that was the whole point of sending it is gone. Scaling such an image by its
 * SHORT edge instead would keep it readable and cost two and a half megapixels
 * to store, which is #102's arithmetic wrecked by the rarest kind of upload.
 *
 * So it is refused, and the message says to crop. Three to one is wider than
 * anything a camera or a single screen produces — a 4:3 photo is 1.33, 16:9 is
 * 1.78, a whole tall phone screen is about 2.17 — so what this turns away is
 * stitched and scrolling captures, which a person can crop to the part they
 * actually meant. Destroying the picture quietly would be worse than saying so.
 */
export const MAX_NEED_PHOTO_ASPECT = 3;

/**
 * The most pixels an input may declare. A 50 KB PNG can claim to be 100,000 ×
 * 100,000 pixels, and decoding it would ask for forty gigabytes of memory on a
 * 512 MB machine — a "decompression bomb". Forty megapixels is a large phone
 * photo with room to spare.
 */
export const MAX_INPUT_PIXELS = 40_000_000;

/** A broken upload is the uploader's problem: 422, never 500. */
function unreadable(): HttpError {
  return HttpError.validationFailed("The image could not be read");
}

/**
 * Turns an uploaded image into the avatar that is stored: square, at most
 * AVATAR_SIDE on a side, WebP, and with no metadata at all.
 *
 * The bytes have already passed `checkUpload` (src/services/files.ts), so they
 * start like a JPEG, PNG or WebP — but starting like one is not being one. A
 * file can have the right first bytes and garbage after them.
 */
export async function normaliseAvatar(bytes: Buffer): Promise<Buffer> {
  const image = sharp(bytes, { limitInputPixels: MAX_INPUT_PIXELS });

  let width: number | undefined;
  let height: number | undefined;

  try {
    const metadata = await image.metadata();
    width = metadata.width;
    height = metadata.height;
  } catch {
    // Includes "more pixels than MAX_INPUT_PIXELS", which sharp already
    // refuses here, at the header.
    throw unreadable();
  }

  if (!width || !height) {
    throw unreadable();
  }

  const shorterSide = Math.min(width, height);
  if (shorterSide < MIN_AVATAR_SIDE) {
    throw HttpError.validationFailed(
      `The image must be at least ${String(MIN_AVATAR_SIDE)}px on its shorter side`,
    );
  }

  const side = Math.min(shorterSide, AVATAR_SIDE);

  try {
    // rotate() FIRST: a phone stores a photo sideways with a note saying
    // "turn me", and webp() writes no metadata, so that note is lost. Turn it
    // before, or the avatar is stored on its side. Then a square crop from the
    // middle (cover, not squash), never larger than it arrived.
    return await image
      .rotate()
      .resize(side, side, { fit: "cover" })
      .webp({ quality: 80 })
      .toBuffer();
  } catch {
    // A good header with broken picture data fails only here, at decode.
    throw unreadable();
  }
}

/**
 * Turns an uploaded image into the photo that is stored on a need (#81).
 *
 * Everything `normaliseAvatar` does about safety, it does too: turned upright
 * before the metadata that says which way up is thrown away, re-encoded
 * rather than passed through, and written as WebP with no metadata at all —
 * which is what removes the GPS position a phone puts in a photo of somebody's
 * kitchen table.
 *
 * What it does NOT do is crop. See NEED_PHOTO_LONG_EDGE.
 */
export async function normaliseNeedPhoto(bytes: Buffer): Promise<Buffer> {
  const image = sharp(bytes, { limitInputPixels: MAX_INPUT_PIXELS });

  let width: number | undefined;
  let height: number | undefined;

  try {
    const metadata = await image.metadata();
    width = metadata.width;
    height = metadata.height;
  } catch {
    throw unreadable();
  }

  if (!width || !height) {
    throw unreadable();
  }

  // The two numbers as the file declares them, which for a sideways phone
  // photo is the other way round from how it will be shown. Both checks below
  // are symmetric in them — the shorter side, the longer over the shorter — so
  // they give the same answer before rotating as after, which is why they can
  // happen here, before a single pixel is decoded.
  const shorterSide = Math.min(width, height);
  const longerSide = Math.max(width, height);

  if (shorterSide < MIN_NEED_PHOTO_SIDE) {
    throw HttpError.validationFailed(
      `The image must be at least ${String(MIN_NEED_PHOTO_SIDE)}px on its shorter side`,
    );
  }

  if (longerSide > shorterSide * MAX_NEED_PHOTO_ASPECT) {
    throw HttpError.validationFailed(
      `The image is more than ${String(MAX_NEED_PHOTO_ASPECT)} times longer ` +
        `than it is wide. Crop it to the part you mean first`,
    );
  }

  try {
    // rotate() FIRST, for the reason normaliseAvatar does it: webp() writes no
    // metadata, so the note saying "turn me" is about to be lost.
    //
    // Then "inside", not "cover": the box is square and the image is fitted
    // INTO it, so whichever edge is longer ends at NEED_PHOTO_LONG_EDGE and
    // the other keeps its proportion. withoutEnlargement means a small photo
    // stays small rather than being blown up into a blur.
    return await image
      .rotate()
      .resize({
        width: NEED_PHOTO_LONG_EDGE,
        height: NEED_PHOTO_LONG_EDGE,
        fit: "inside",
        withoutEnlargement: true,
      })
      .webp({ quality: 80 })
      .toBuffer();
  } catch {
    // A good header with broken picture data fails only here, at decode.
    throw unreadable();
  }
}
