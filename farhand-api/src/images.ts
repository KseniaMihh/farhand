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
 * The most pixels an input may declare. A 50 KB PNG can claim to be 100,000 ×
 * 100,000 pixels, and decoding it would ask for forty gigabytes of memory on a
 * 512 MB machine — a "decompression bomb". Forty megapixels is a large phone
 * photo with room to spare.
 */
export const MAX_INPUT_PIXELS = 40_000_000;

/**
 * Turns an uploaded image into the avatar that is stored: square, at most
 * AVATAR_SIDE on a side, WebP, and with no metadata at all.
 *
 * The bytes have already passed `checkUpload` (src/services/files.ts), so they
 * start like a JPEG, PNG or WebP — but starting like one is not being one. A
 * file can have the right first bytes and garbage after them.
 */
/** A broken upload is the uploader's problem: 422, never 500. */
function unreadable(): HttpError {
  return HttpError.validationFailed("The image could not be read");
}

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
