import sharp from "sharp";

/**
 * Real images for avatar tests. #79's samples were the right first bytes and
 * nothing after them — enough to sniff, not enough to decode. An avatar is
 * decoded, so these are whole images, made with the same library the API uses.
 */

type Format = "jpeg" | "png" | "webp";

/** A solid-colour image of the given size and format. */
export function solidImage(
  width: number,
  height: number,
  format: Format = "jpeg",
  colour = { r: 200, g: 120, b: 40 },
): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: colour },
  })
    .toFormat(format)
    .toBuffer();
}

/**
 * A JPEG carrying the metadata a phone writes: who took it, and where. The
 * strings are unusual on purpose, so a test can search the stored bytes for
 * them and know a match is not a coincidence.
 */
export const SECRET_ARTIST = "Anna-at-home-7f3c";

export function photoWithMetadata(): Promise<Buffer> {
  return sharp({
    create: { width: 600, height: 600, channels: 3, background: "#4a7" },
  })
    .jpeg()
    .withExif({
      IFD0: { Artist: SECRET_ARTIST, Copyright: SECRET_ARTIST },
      IFD3: {
        GPSLatitudeRef: "N",
        GPSLatitude: "59/1 26/1 0/1",
        GPSLongitudeRef: "E",
        GPSLongitude: "24/1 45/1 0/1",
      },
    })
    .toBuffer();
}

/**
 * 400 × 200, red on the left half and blue on the right, saved with the EXIF
 * note "rotate 90° clockwise" (orientation 6) — what a phone held upright
 * writes. Turned as the note says, it is 200 × 400 with red on TOP.
 */
export async function sidewaysPhoto(): Promise<Buffer> {
  const red = await sharp({
    create: { width: 200, height: 200, channels: 3, background: "#f00" },
  })
    .png()
    .toBuffer();
  return sharp({
    create: { width: 400, height: 200, channels: 3, background: "#00f" },
  })
    .composite([{ input: red, left: 0, top: 0 }])
    .jpeg({ quality: 95 })
    .withMetadata({ orientation: 6 })
    .toBuffer();
}

/** The colour of one pixel, roughly: which of red, green, blue dominates. */
export async function dominantAt(
  image: Buffer,
  x: number,
  y: number,
): Promise<"red" | "green" | "blue"> {
  const { data, info } = await sharp(image)
    .raw()
    .toBuffer({ resolveWithObject: true });
  const at = (y * info.width + x) * info.channels;
  const [r = 0, g = 0, b = 0] = [data[at], data[at + 1], data[at + 2]];
  if (r >= g && r >= b) return "red";
  return g >= b ? "green" : "blue";
}

/** Format, size and whether any metadata survived, read from stored bytes. */
export async function describe(image: Buffer) {
  const meta = await sharp(image).metadata();
  return {
    format: meta.format,
    width: meta.width,
    height: meta.height,
    hasExif: meta.exif !== undefined,
    hasIcc: meta.icc !== undefined,
    hasXmp: meta.xmp !== undefined,
  };
}

/**
 * More pixels than MAX_INPUT_PIXELS allows, in a file far under the 5 MB
 * limit: one grey colour compresses to almost nothing. A decompression bomb in
 * miniature — small to send, enormous to decode.
 */
export function pixelBomb(): Promise<Buffer> {
  return sharp({
    create: { width: 7000, height: 6000, channels: 3, background: "#888" },
  })
    .png({ compressionLevel: 9 })
    .toBuffer();
}

/**
 * 300 × 100 in three stripes: red, green, blue. Cropped square from the
 * middle it is all green; squashed into a square it still has red at its left
 * edge. One colour could not tell those two apart.
 */
export async function threeStripes(): Promise<Buffer> {
  const stripe = (background: string) =>
    sharp({ create: { width: 100, height: 100, channels: 3, background } })
      .png()
      .toBuffer();
  return sharp({
    create: { width: 300, height: 100, channels: 3, background: "#0f0" },
  })
    .composite([
      { input: await stripe("#f00"), left: 0, top: 0 },
      { input: await stripe("#00f"), left: 200, top: 0 },
    ])
    .png()
    .toBuffer();
}

/**
 * A real JPEG cut short. Its header is whole — the size reads fine — and its
 * picture data stops partway, so it fails only when it is really decoded.
 * The broken first-bytes sample fails earlier, at the header, and so cannot
 * tell whether the decode step's errors are handled.
 */
export async function truncatedJpeg(): Promise<Buffer> {
  const whole = await solidImage(300, 300, "jpeg");
  return whole.subarray(0, Math.floor(whole.length * 0.6));
}
