import { randomUUID } from "node:crypto";
import type { File, FilePurpose, Prisma, User } from "@prisma/client";
import type { Logger } from "pino";
import { prisma } from "../db.js";
import { HttpError } from "../errors.js";
import { ROLE_RANK } from "../middleware/auth.js";
import { storage } from "../storage.js";

/**
 * Uploaded files: the rules, not the bytes.
 *
 * A `File` row is metadata — who owns it, what it is for, how big, what type,
 * and the key its bytes are stored under. The bytes themselves live in object
 * storage behind src/storage.ts, which is private: nobody reaches them except
 * through a signed URL this file decides to hand out.
 *
 * #79 builds the foundation and one endpoint, GET /files/:id. The uploads
 * themselves arrive per purpose — avatars in #80, need photos in #81, receipts
 * in #82 — and all of them call `storeFile`, so the rules below are written
 * once. Contract: docs/06-api-contract.md, "Files".
 */

/**
 * The largest file we accept. A phone photo is 2–4 MB; a scanned receipt as
 * PDF well under that. Checked before anything is stored, so an oversized
 * upload costs us nothing but reading it.
 */
export const MAX_FILE_BYTES = 5 * 1024 * 1024;

/**
 * What each purpose may be. Photos are images; a receipt may also be a PDF,
 * because that is what an online shop emails you.
 *
 * No GIF (animation is not a photo), no SVG (it is a document that can carry
 * script, and an image tag is the wrong place to discover that), no HEIC (no
 * browser outside Safari can show it).
 */
export const ALLOWED_TYPES: Record<FilePurpose, readonly string[]> = {
  AVATAR: ["image/jpeg", "image/png", "image/webp"],
  NEED_PHOTO: ["image/jpeg", "image/png", "image/webp"],
  PRODUCT_RECEIPT: ["image/jpeg", "image/png", "image/webp", "application/pdf"],
  SHIPPING_RECEIPT: [
    "image/jpeg",
    "image/png",
    "image/webp",
    "application/pdf",
  ],
};

/**
 * What a file IS, read from its first bytes — never what the browser says it
 * is. A `Content-Type` header and a file name are both the uploader's claim;
 * the leading bytes of a JPEG are the JPEG's. An HTML page renamed `cat.png`
 * and sent as `image/png` is still HTML, and this says so by answering
 * `undefined`.
 */
export function sniffMimeType(bytes: Buffer): string | undefined {
  const startsWith = (signature: number[], offset = 0) =>
    signature.every((byte, i) => bytes[offset + i] === byte);

  if (startsWith([0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return "image/png";
  }
  // "RIFF" <4 bytes of length> "WEBP"
  if (
    startsWith([0x52, 0x49, 0x46, 0x46]) &&
    startsWith([0x57, 0x45, 0x42, 0x50], 8)
  ) {
    return "image/webp";
  }
  if (startsWith([0x25, 0x50, 0x44, 0x46, 0x2d])) return "application/pdf"; // %PDF-
  return undefined;
}

/**
 * A storage key that says nothing. Not the file name (the uploader's words,
 * possibly a path, possibly someone's full name), not the owner's id (the
 * key would then tell anyone holding a signed URL whose file it is).
 */
export function newStorageKey(): string {
  return `files/${randomUUID()}`;
}

export interface StoreFileInput {
  ownerId: string;
  purpose: FilePurpose;
  bytes: Buffer;
  needId?: string;
  dealId?: string;
}

/** How each accepted type is named to a person reading a refusal. */
const TYPE_NAMES: Record<string, string> = {
  "image/jpeg": "JPEG",
  "image/png": "PNG",
  "image/webp": "WebP",
  "application/pdf": "PDF",
};

/** "a JPEG, PNG or WebP" — what this purpose accepts, in words. */
function acceptedTypesFor(purpose: FilePurpose): string {
  const names = ALLOWED_TYPES[purpose].map((type) => TYPE_NAMES[type] ?? type);
  const last = names.pop();
  return names.length > 0
    ? `${names.join(", ")} or ${last ?? ""}`
    : (last ?? "");
}

/**
 * Validates, stores the bytes, and writes the row — in that order.
 *
 * Bytes first, row second: a row without bytes is a broken file somebody can
 * see, bytes without a row are invisible garbage. Every failure below lands on
 * the invisible side (docs/10-decisions/0011-backblaze-b2-for-files.md).
 */
export async function storeFile(input: StoreFileInput): Promise<File> {
  // Size first: it is free to check, and there is no point sniffing five
  // megabytes we are going to refuse.
  if (input.bytes.length > MAX_FILE_BYTES) {
    throw HttpError.validationFailed(
      `File is too large. The limit is ${String(MAX_FILE_BYTES / 1024 / 1024)} MB`,
    );
  }

  // An empty file has no leading bytes, so it is refused here too.
  const mimeType = sniffMimeType(input.bytes);
  if (!mimeType || !ALLOWED_TYPES[input.purpose].includes(mimeType)) {
    throw HttpError.validationFailed(
      `File must be a ${acceptedTypesFor(input.purpose)}`,
    );
  }

  // If the store fails, nothing has been written to the database yet.
  const storageKey = newStorageKey();
  await storage.put(storageKey, input.bytes, mimeType);

  try {
    return await prisma.file.create({
      data: {
        ownerId: input.ownerId,
        purpose: input.purpose,
        storageKey,
        mimeType,
        sizeBytes: input.bytes.length,
        needId: input.needId ?? null,
        dealId: input.dealId ?? null,
      },
    });
  } catch (error) {
    // Bytes are already stored and nothing points at them: delete them, then
    // rethrow the ORIGINAL error — it is the one that explains what went
    // wrong. If the cleanup itself fails, the orphan is private and harmless.
    await storage.delete(storageKey).catch(() => undefined);
    throw error;
  }
}

/**
 * A signed URL for one file, if this viewer may see it.
 *
 * Who may see what: docs/06-api-contract.md, "Files", from the rule in
 * docs/02-roles-and-permissions.md. A missing file and a hidden one get the
 * same 404, so a receipt's id cannot be checked by a stranger (#26).
 *
 * The bytes are not checked before signing: that would be a request to the
 * store on every image shown, and a signed URL for vanished bytes is answered
 * 404 by the store — never 500 by us.
 */
export async function fileReadUrl(
  fileId: string,
  viewer: User | undefined,
): Promise<string> {
  const file = await prisma.file.findUnique({
    where: { id: fileId },
    include: {
      owner: { select: { status: true } },
      need: { select: { status: true, requesterId: true } },
      deal: { select: { requesterId: true, helperId: true } },
    },
  });

  if (!file) {
    throw HttpError.notFound("File not found");
  }

  const isModerator =
    viewer !== undefined && ROLE_RANK[viewer.role] >= ROLE_RANK.MODERATOR;

  const visible = (() => {
    switch (file.purpose) {
      // The rule of GET /users/:id. Named, not "anything but BANNED", so a
      // status added one day is hidden until somebody decides otherwise.
      case "AVATAR":
        return (
          file.owner.status === "ACTIVE" || file.owner.status === "SUSPENDED"
        );

      case "NEED_PHOTO": {
        if (!file.need) return false;
        const isOwner = viewer?.id === file.need.requesterId;
        return (
          isOwner ||
          file.need.status === "OPEN" ||
          file.need.status === "MATCHED"
        );
      }

      case "PRODUCT_RECEIPT":
      case "SHIPPING_RECEIPT": {
        if (!file.deal) return false;
        const isParticipant =
          viewer?.id === file.deal.requesterId ||
          viewer?.id === file.deal.helperId;
        return isParticipant || isModerator;
      }
    }
  })();

  if (!visible) {
    throw HttpError.notFound("File not found");
  }

  return storage.signedReadUrl(file.storageKey);
}

/**
 * The rows half of deleting an account (#66): runs INSIDE its transaction.
 *
 * Photos go, receipts stay. An avatar and a need photo are personal and
 * nobody else depends on them; a receipt is evidence in a deal the other
 * person is part of, kept for the reason #66 keeps the deal's messages.
 *
 * Returns the keys, so the bytes can be deleted AFTER the commit: a store is
 * not part of the transaction, and bytes deleted inside it would be gone for
 * rows a rollback brings back.
 */
export async function removeAccountFiles(
  tx: Prisma.TransactionClient,
  ownerId: string,
): Promise<string[]> {
  const where = {
    ownerId,
    purpose: { in: ["AVATAR", "NEED_PHOTO"] satisfies FilePurpose[] },
  };

  const rows = await tx.file.findMany({ where, select: { storageKey: true } });
  await tx.file.deleteMany({ where });

  return rows.map((row) => row.storageKey);
}

/**
 * Deletes bytes whose rows are already gone. Best effort, one key at a time.
 *
 * Never fails its caller: the account is deleted by now, and a person who
 * asked to leave is not told "error" because a photo lingered in a private
 * bucket. Each failure is logged with its key, to be removed by hand.
 */
export async function deleteStoredBytes(
  keys: string[],
  log: Logger,
): Promise<void> {
  for (const key of keys) {
    try {
      await storage.delete(key);
    } catch (err) {
      log.error({ err, key }, "Failed to delete stored file bytes");
    }
  }
}
