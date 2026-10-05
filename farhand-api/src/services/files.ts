import { randomUUID } from "node:crypto";
import type { File, FilePurpose, Prisma, User } from "@prisma/client";
import type { Logger } from "pino";

/**
 * Uploaded files: the rules, not the bytes.
 *
 * The TODOs below will need `HttpError` (../errors.js) and `storage`
 * (../storage.js), plus `prisma` (../db.js) and `ROLE_RANK`
 * (../middleware/auth.js). The parameters are underscored only so the
 * skeleton passes lint; drop the underscores as you use them.
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

/**
 * Validates, stores the bytes, and writes the row — in that order.
 *
 * TODO(#79), in order:
 *
 * 1. Refuse anything over MAX_FILE_BYTES with `HttpError.validationFailed`.
 *    Size first: it is free to check, and there is no point sniffing five
 *    megabytes we are going to refuse. (An EMPTY file needs no rule of its
 *    own: it has no leading bytes, so step 2 refuses it.)
 *
 * 2. Sniff the type with `sniffMimeType`. Refuse with `validationFailed` if
 *    it is unrecognised or not in ALLOWED_TYPES[purpose]. The sniffed type is
 *    what gets stored — nothing the caller claimed is ever written down.
 *
 * 3. Make a key with `newStorageKey()` and `await storage.put(...)`. If this
 *    throws, let it: nothing has been written to the database yet, so a
 *    failed upload leaves no row by construction.
 *
 * 4. Create the `File` row (`prisma.file.create`). If THAT throws, the bytes
 *    are already stored and nothing points at them. Delete them
 *    (`storage.delete`) and rethrow the original error. If the delete itself
 *    fails, the orphan is private and harmless — rethrow the ORIGINAL error
 *    anyway, not the cleanup's, because that is the one that explains what
 *    went wrong.
 *
 *    Why bytes first and row second, rather than the other way round: a row
 *    without bytes is a broken file somebody can see; bytes without a row are
 *    invisible garbage. Fail towards the invisible one.
 *
 * 5. Return the row.
 */
export function storeFile(_input: StoreFileInput): Promise<File> {
  throw new Error("TODO(#79): storeFile");
}

/**
 * A signed URL for one file, if this viewer may see it.
 *
 * Who may see what (docs/02-roles-and-permissions.md, "See a receipt file"):
 *
 *   AVATAR            anyone, while the owner's profile is visible — the same
 *                     rule as GET /users/:id: ACTIVE and SUSPENDED yes, BANNED
 *                     no. (DELETED never gets here: the rows are gone.)
 *   NEED_PHOTO        whoever may see the need — the rule in getVisibleNeed:
 *                     OPEN and MATCHED for anyone, any status for its owner
 *   PRODUCT_RECEIPT   the two people in the deal, and moderators
 *   SHIPPING_RECEIPT  the same
 *
 * TODO(#79):
 *
 * 1. Load the row with what the rules need: the owner's status, the need, the
 *    deal. One query with `include`.
 *
 * 2. Apply the rule for its purpose. Moderators: `ROLE_RANK[viewer.role] >=
 *    ROLE_RANK.MODERATOR` (src/middleware/auth.ts), so the ranking is not
 *    copied a second time.
 *
 * 3. A file that does not exist and a file this viewer may not see answer
 *    the SAME `HttpError.notFound("File not found")`. Different answers would
 *    tell a stranger which receipt ids are real — the reasoning of #26.
 *
 * 4. Return `storage.signedReadUrl(file.storageKey)`. Do not check that the
 *    bytes still exist first: that is a request to the store on every image
 *    view, and the signed URL already answers 404 when they do not.
 */
export function fileReadUrl(
  _fileId: string,
  _viewer: User | undefined,
): Promise<string> {
  throw new Error("TODO(#79): fileReadUrl");
}

/**
 * The rows half of deleting an account (#66): runs INSIDE its transaction.
 *
 * Decided in #79: photos go, receipts stay. An avatar and a need photo are
 * personal and nobody else depends on them. A receipt is evidence in a deal
 * the other person is also part of — kept for the same reason #66 keeps the
 * deal's messages and history.
 *
 * TODO(#79):
 *
 * 1. Find this owner's AVATAR and NEED_PHOTO rows, and remember their keys.
 * 2. Delete those rows with `tx.file.deleteMany`.
 * 3. Return the keys. The bytes are deleted AFTER the transaction commits
 *    (`deleteStoredBytes`): storage is not part of a database transaction, so
 *    deleting bytes inside it would leave rows pointing at nothing if the
 *    transaction then rolled back.
 */
export function removeAccountFiles(
  _tx: Prisma.TransactionClient,
  _ownerId: string,
): Promise<string[]> {
  throw new Error("TODO(#79): removeAccountFiles");
}

/**
 * Deletes bytes whose rows are already gone. Best effort, one key at a time.
 *
 * TODO(#79): call `storage.delete` for each key. A failure must not stop the
 * others, and must not fail the caller — the account IS deleted by now, and a
 * person who asked to leave should not be told "error" because a photo lingered
 * in a private bucket. Log each failure with `log.error({ err, key }, ...)` so
 * it can be cleaned up by hand.
 */
export function deleteStoredBytes(
  _keys: string[],
  _log: Logger,
): Promise<void> {
  throw new Error("TODO(#79): deleteStoredBytes");
}
