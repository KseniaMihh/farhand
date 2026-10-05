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
 *
 * TODO(#80), with `import sharp from "sharp"` and
 * `import { HttpError } from "./errors.js"`:
 *
 * 1. `sharp(bytes, { limitInputPixels: MAX_INPUT_PIXELS })`. Then
 *    `await image.metadata()` for `width` and `height`.
 *
 *    Any error SHARP throws — more pixels than the limit (already at
 *    `metadata()`), or garbage after a good header (sometimes only at
 *    `toBuffer()`, when it really decodes) — becomes
 *    `HttpError.validationFailed("The image could not be read")`. A broken
 *    upload is the uploader's problem: 422, never 500. Your own HttpError
 *    from step 2 must pass through unchanged, so catch around the sharp
 *    calls, not around everything.
 *
 * 2. If the shorter side is under MIN_AVATAR_SIDE, refuse with
 *    `validationFailed`, naming the minimum.
 *
 * 3. `.rotate()` with no argument, BEFORE anything else changes the image:
 *    phones store a photo sideways with a note saying "turn me". Step 5 throws
 *    the note away, so the turning has to happen first or the avatar is
 *    stored on its side.
 *
 * 4. Make it square: `.resize(side, side, { fit: "cover" })`, where `side` is
 *    the shorter side, capped at AVATAR_SIDE. "cover" crops the middle rather
 *    than squashing a face. Never larger than it arrived: a 100 × 300 image
 *    becomes 100 × 100, not a blurry 512 × 512.
 *
 * 5. `.webp({ quality: 80 })` and `.toBuffer()`. sharp writes no metadata
 *    unless asked to (`withMetadata`) — so the GPS position, the camera, the
 *    date all stay behind. Do not ask.
 *
 * Return the new bytes.
 */
export function normaliseAvatar(_bytes: Buffer): Promise<Buffer> {
  throw new Error("TODO(#80): normaliseAvatar");
}
