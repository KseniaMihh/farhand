import { randomBytes } from "node:crypto";
import type { User } from "@prisma/client";
import { ROLE_RANK } from "../middleware/auth.js";
import { prisma } from "../db.js";
import { HttpError } from "../errors.js";
import { logger } from "../logger.js";
import { hashPassword } from "../password.js";
import { deleteStoredBytes, removeAccountFiles } from "./files.js";

/**
 * Erasing an account — the one somebody asks for themselves (#66), and the
 * one a moderator does on their behalf (#88).
 *
 * THE HOLE #88 CLOSES, recorded in docs/11-risks.md since #66: `DELETE /me`
 * needs a session, and a ban stops sign-in. So the people most likely to want
 * erasure are exactly the ones who cannot ask for it, and version 1 has no
 * support inbox either.
 *
 * ONE ANONYMISATION, TWO DOORS, and that is the whole architecture of this
 * file. The alternative — a second routine that also "deletes an account" —
 * is how a receipt gets destroyed or an email survives: two paths that differ
 * by one forgotten line, with nothing comparing them. So the body below is
 * #66's, moved here unchanged, and both callers run it.
 * `tests/admin/erasure.test.ts` runs both paths and compares the rows they
 * leave behind, which is the test that would notice a drift.
 *
 * erasure rules: see docs/10-decisions/0022-erasing-an-account-somebody-cannot-reach.md
 */

/**
 * The deal statuses that are over. Everything else is a deal still running,
 * with somebody on the other side of it.
 */
const SETTLED = ["COMPLETED", "CANCELLED"] as const;

/**
 * The name a deleted account wears afterwards.
 *
 * The profile row stays and is blanked rather than deleted, so a deal's
 * history still says who did each step (#67). The alternative — no profile at
 * all — makes every event that person ever caused read as an actor we cannot
 * label, which is true but says the wrong thing: this is not somebody unknown,
 * it is somebody who left.
 */
export const DELETED_DISPLAY_NAME = "Deleted account";

/**
 * The address a deleted account keeps.
 *
 * `.invalid` is reserved by RFC 2606 and can never be a real domain, so this
 * can never collide with a living account or be mistaken for a way to reach
 * anybody. The id keeps it unique, because `email` is a unique column and two
 * deletions must not fight over one value.
 */
export function deletedEmailFor(userId: string): string {
  return `deleted-${userId}@farhand.invalid`;
}

/**
 * Refuses an erasure while a deal is still running.
 *
 * There is somebody on the other side of a live deal who is owed either the
 * thing or their money, and erasing one of the two people in it leaves them
 * with neither. The same refusal whoever asks (#66, #88).
 *
 * IT USED TO DEADLOCK, and #134 is why it no longer does. A banned account
 * cannot move a deal; before #134 a moderator's only row started at
 * `DISPUTED`, so an erasure waited on one of the deal's own two people
 * choosing to press something — and if both were gone, it waited forever.
 * A moderator can now end a deal nobody has paid for outright, and freeze
 * then end one somebody has (docs/04-deal-lifecycle.md, decision 0030). So
 * this refusal is a "do that first", and `whoIsAsking` is what makes it say
 * which "that".
 */
export async function assertNoRunningDeals(
  userId: string,
  whoIsAsking: "owner" | "moderator" = "owner",
): Promise<void> {
  const unsettledDeals = await prisma.deal.count({
    where: {
      OR: [{ requesterId: userId }, { helperId: userId }],
      status: { notIn: [...SETTLED] },
    },
  });

  if (unsettledDeals === 0) return;

  // The owner can act on their own deals; a moderator cannot act on somebody
  // else's except through the two rows #134 gave them. One sentence each,
  // because an error that names the wrong remedy wastes somebody's afternoon.
  const remedy =
    whoIsAsking === "moderator"
      ? "End them first: a deal nobody has paid for can be cancelled, and one somebody has paid for can be frozen and then ended with a note."
      : "Settle or cancel them first.";

  throw HttpError.conflict(
    `This account has ${String(unsettledDeals)} deal(s) still in progress. ${remedy}`,
  );
}

/**
 * The anonymisation itself: the account is kept, and stops being anybody.
 *
 * Moved here from `deleteMyAccount` by #88, line for line. Every one of these
 * is a decision somebody argued about in #66, and two of them are
 * load-bearing in ways a reimplementation would miss — the password hash has
 * to be a REAL argon2 hash, and `countryCode` stays.
 */
export async function eraseAccount(userId: string): Promise<void> {
  const orphanedKeys = await prisma.$transaction(async (tx) => {
    await tx.need.updateMany({
      where: { requesterId: userId, status: { in: ["DRAFT", "OPEN"] } },
      data: { status: "CLOSED" },
    });

    await tx.help.updateMany({
      where: { helperId: userId, status: { in: ["ACTIVE", "PAUSED"] } },
      data: { status: "REMOVED" },
    });

    // Their own pending offers to help elsewhere.
    await tx.proposal.updateMany({
      where: { helperId: userId, status: "PENDING" },
      data: { status: "WITHDRAWN", respondedAt: new Date() },
    });

    // Pending offers FROM other people, on needs that are about to close.
    // Otherwise a requester could still accept one from an account that can
    // no longer log in, creating a deal that can never move.
    await tx.proposal.updateMany({
      where: { need: { requesterId: userId }, status: "PENDING" },
      data: { status: "DECLINED", respondedAt: new Date() },
    });

    await tx.user.update({
      where: { id: userId },
      data: {
        email: deletedEmailFor(userId),
        // A REAL hash of 32 random bytes nobody kept. It has to be a real
        // one: argon2 reads its parameters and salt out of the stored value,
        // so a string that is not a hash makes verification THROW rather than
        // return false — and login would answer 500 where an unknown address
        // answers 401, which tells anyone who can guess this address that the
        // account was deleted rather than never existing (src/routes/auth.ts
        // explains why those two must be indistinguishable).
        passwordHash: await hashPassword(randomBytes(32).toString("hex")),
        status: "DELETED",
        deletedAt: new Date(),
      },
    });

    await tx.profile.update({
      where: { userId },
      data: {
        displayName: DELETED_DISPLAY_NAME,
        bio: null,
        city: null,
        // Belt and braces, and unfalsifiable: `removeAccountFiles` below
        // deletes the avatar's File row in this same transaction, and the
        // relation is onDelete: SetNull, so the database empties this column
        // whether or not the line is here — a broken variant that deletes it
        // changes nothing a test can see (#103). It stays because the erasure
        // should be legible at the point of erasure, rather than depending on
        // a foreign-key action written forty lines away in another file.
        avatarFileId: null,
        // countryCode stays: on its own it identifies nobody, and it keeps
        // a deal's history readable.
      },
    });

    await tx.session.deleteMany({ where: { userId } });
    await tx.verificationToken.deleteMany({ where: { userId } });

    // Standing queries go with the account (#90). The foreign key cascades,
    // but nothing deletes this User row — #66 keeps it and empties it — so
    // the cascade would never fire. A search left behind would be a search
    // emailing an address at a domain nobody owns.
    await tx.savedSearch.deleteMany({ where: { userId } });

    // Photos go, receipts stay (#79). The rows here, inside the transaction;
    // the bytes below, once it has committed.
    return removeAccountFiles(tx, userId);
  });

  // After the commit, never inside it: a store is not part of a database
  // transaction, and bytes deleted before a rollback would be gone for rows
  // that came back. Best effort — the account is deleted whatever happens here.
  await deleteStoredBytes(orphanedKeys, logger);
}

/**
 * A moderator erases a banned account, because its owner cannot ask (#88).
 *
 * **Banned only**, and that is deliberate: the power should be exactly as big
 * as the hole. Anybody who can sign in — including a suspended account, since
 * `DELETE /me` is marked `SESSION` for this very reason — can erase
 * themselves, and a moderator who can erase anybody at all is a larger thing
 * than this issue asked for.
 *
 * How somebody asks, with no support inbox: since #86 a ban is emailed to the
 * person it is about, and that email ends by inviting a reply. The contact
 * route is the one that already exists.
 */
export async function eraseAccountAsModerator(
  actor: User,
  targetUserId: string,
  reason: string,
): Promise<void> {
  const target = await prisma.user.findUnique({ where: { id: targetUserId } });
  if (!target) {
    throw HttpError.notFound("User not found");
  }

  // Nobody moderates upwards, sideways, or themselves — the rule `actOnUser`
  // applies to a ban, and this is the stronger case: a ban can be lifted.
  if (
    target.id === actor.id ||
    ROLE_RANK[target.role] >= ROLE_RANK[actor.role]
  ) {
    throw HttpError.forbidden("You may not take this action on this user");
  }

  // Already erased. The caller asked for a state and that is the state, so
  // `204` — and no second audit row, because nothing happened: a log that
  // records non-events is one nobody can read.
  if (target.status === "DELETED") {
    return;
  }

  if (target.status !== "BANNED") {
    throw HttpError.conflict(
      "Only a banned account can be erased by a moderator. An account that can sign in closes itself with DELETE /me",
    );
  }

  await assertNoRunningDeals(target.id, "moderator");

  // The audit row first, in its own statement, and then the erasure — both
  // before anything is answered. #27 exists so that a power leaves a trace,
  // and this is the one power whose subject cannot be asked about afterwards.
  await prisma.adminAction.create({
    data: {
      adminId: actor.id,
      targetUserId: target.id,
      type: "ERASE_ACCOUNT",
      reason,
    },
  });

  // NOT in one transaction with the audit row, and that is a trade worth
  // stating: `eraseAccount` opens its own transaction and then deletes bytes
  // from object storage after it commits, which cannot be undone by anything.
  // If the erasure fails, the audit row is left claiming an erasure that did
  // not happen — a lie a human can read and correct. The other order risks an
  // erasure nobody can account for, which is the one this log exists to
  // prevent.
  await eraseAccount(target.id);

  // No notification (#86). There is nowhere to send one: the address is
  // anonymised by the line above, and the queue would read the row a second
  // later, find `status = DELETED`, and skip it anyway. The audit row is the
  // record, and the person asked for this.
}
