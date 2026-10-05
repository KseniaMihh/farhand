import type { Profile, User } from "@prisma/client";
import type { Logger } from "pino";

/**
 * Avatars (#80): the first upload a person can make.
 *
 *   PUT    /me/avatar   set or replace your own
 *   DELETE /me/avatar   back to none
 *
 * There is no id in either address, so nobody can set somebody else's — the
 * same trick as PATCH /me/profile (#65): the rule cannot be forgotten, because
 * there is nothing to remember. Contract: docs/06-api-contract.md, "Profile".
 *
 * A profile points at its avatar File (`Profile.avatarFileId`). Replacing one
 * leaves the old row AND the old bytes deleted — a person changing their
 * picture ten times leaves one file behind, not ten.
 *
 * The TODOs below need: `checkUpload`, `storeFile`, `deleteStoredBytes`
 * (./files.js); `normaliseAvatar` (../images.js); `prisma` (../db.js);
 * `storage` (../storage.js). Parameters are underscored only so the skeleton
 * passes lint.
 */

/**
 * Sets or replaces the caller's avatar.
 *
 * TODO(#80), in order:
 *
 * 1. `checkUpload(bytes, "AVATAR")` — size and type, BEFORE the image library
 *    sees a byte. An SVG or an HTML page never reaches a decoder.
 *
 * 2. `normaliseAvatar(bytes)` — square, small, WebP, no metadata.
 *
 * 3. `storeFile({ ownerId: user.id, purpose: "AVATAR", bytes: normalised })`.
 *    What is stored is the normalised image, never the upload.
 *
 * 4. In ONE transaction:
 *    a. Lock this person's profile row:
 *         await tx.$queryRaw`SELECT 1 FROM "Profile"
 *                            WHERE "userId" = ${user.id} FOR UPDATE`
 *       Two uploads at once from the same person (a double click, two tabs)
 *       would otherwise both read "the old avatar is X", and one of the two
 *       new files would end up pointed at by nothing. With the lock, the
 *       second waits for the first, then finds the first's file as its old one.
 *    b. Find every AVATAR file of this owner except the new one, and keep
 *       their storage keys. "Every", not "the one the profile points at": it
 *       also sweeps up anything an earlier failure left behind.
 *    c. Point the profile at the new file (`avatarFileId`).
 *    d. Delete those other rows.
 *
 * 5. If the transaction fails, the new file is stored and nothing points at
 *    it. Delete its row and its bytes (best effort, as in #79), then rethrow.
 *
 * 6. After the commit, `deleteStoredBytes(oldKeys, log)` — never inside the
 *    transaction, for #79's reason: a rollback would bring rows back for bytes
 *    already gone.
 *
 * 7. Return the updated profile.
 */
export function setAvatar(
  _user: User,
  _bytes: Buffer,
  _log: Logger,
): Promise<Profile> {
  throw new Error("TODO(#80): setAvatar");
}

/**
 * Removes the caller's avatar. Having none already is not an error: the
 * person wanted no avatar, and now they have none.
 *
 * TODO(#80): the same shape as step 4 and 6 above — lock the profile row,
 * collect the keys of every AVATAR file of this owner, set `avatarFileId` to
 * null, delete the rows, and after the commit delete the bytes. Return the
 * updated profile.
 */
export function removeAvatar(_user: User, _log: Logger): Promise<Profile> {
  throw new Error("TODO(#80): removeAvatar");
}
