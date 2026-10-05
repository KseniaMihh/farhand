import type { Profile, User } from "@prisma/client";
import type { Logger } from "pino";
import { prisma } from "../db.js";
import { storage } from "../storage.js";
import { normaliseAvatar } from "../images.js";
import { checkUpload, storeFile, deleteStoredBytes } from "./files.js";

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
 * A profile points at its avatar File (`Profile.avatarFileId`). Replacing or
 * removing one deletes the old row AND its bytes, so ten changes of picture
 * leave one file behind, not ten.
 */

/**
 * Sets or replaces the caller's avatar. What is stored is the normalised
 * image (src/images.ts), never the upload.
 */
export async function setAvatar(
  user: User,
  bytes: Buffer,
  log: Logger,
): Promise<Profile> {
  checkUpload(bytes, "AVATAR");
  const normalised = await normaliseAvatar(bytes);

  const file = await storeFile({
    ownerId: user.id,
    purpose: "AVATAR",
    bytes: normalised,
  });

  let oldKeys: string[];
  let profile: Profile;

  try {
    const result = await prisma.$transaction(async (tx) => {
      // Two uploads at once (a double click, two tabs) would both read the
      // same "old avatar", and one new file would end up pointed at by
      // nothing. The lock makes the second wait and then find the first's file
      // as its old one. No test can make two requests reliably collide, so
      // this is argued here rather than proved (tests/profiles/avatar.test.ts).
      await tx.$queryRaw`SELECT 1 FROM "Profile"
                         WHERE "userId" = ${user.id} FOR UPDATE`;

      // Every other avatar file of this owner, not only the one the profile
      // points at: it also sweeps up anything an earlier failure left behind.
      const oldFiles = await tx.file.findMany({
        where: { ownerId: user.id, purpose: "AVATAR", id: { not: file.id } },
        select: { id: true, storageKey: true },
      });

      const updatedProfile = await tx.profile.update({
        where: { userId: user.id },
        data: { avatarFileId: file.id },
      });

      await tx.file.deleteMany({
        where: { id: { in: oldFiles.map((f) => f.id) } },
      });

      return { updatedProfile, oldKeys: oldFiles.map((f) => f.storageKey) };
    });

    profile = result.updatedProfile;
    oldKeys = result.oldKeys;
  } catch (error) {
    // The new file is stored and nothing points at it. Remove it, best effort
    // (#79), and report the failure that actually happened.
    await prisma.file.delete({ where: { id: file.id } }).catch(() => undefined);
    await storage.delete(file.storageKey).catch(() => undefined);
    throw error;
  }

  // After the commit, never inside it: a rollback would bring back rows for
  // bytes already gone (#79).
  await deleteStoredBytes(oldKeys, log);

  return profile;
}

/**
 * Removes the caller's avatar: the same lock and the same order as setAvatar.
 * Having none already is not an error — the person wanted no avatar, and now
 * they have none.
 */
export async function removeAvatar(user: User, log: Logger): Promise<Profile> {
  const { profile, oldKeys } = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1 FROM "Profile"
                       WHERE "userId" = ${user.id} FOR UPDATE`;

    const oldFiles = await tx.file.findMany({
      where: { ownerId: user.id, purpose: "AVATAR" },
      select: { id: true, storageKey: true },
    });

    const updatedProfile = await tx.profile.update({
      where: { userId: user.id },
      data: { avatarFileId: null },
    });

    await tx.file.deleteMany({
      where: { id: { in: oldFiles.map((f) => f.id) } },
    });

    return {
      profile: updatedProfile,
      oldKeys: oldFiles.map((f) => f.storageKey),
    };
  });

  await deleteStoredBytes(oldKeys, log);

  return profile;
}
