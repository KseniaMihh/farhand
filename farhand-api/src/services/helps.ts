/* eslint-disable @typescript-eslint/no-unused-vars --
   The three functions below are stubs and do not use their arguments or
   imports yet. DELETE THIS LINE once they are implemented. */
import { Prisma } from "@prisma/client";
import type { Help, HelpStatus, User } from "@prisma/client";
import { prisma } from "../db.js";
import { HttpError } from "../errors.js";
import { onlyProvided } from "./shared.js";

/**
 * Helps: what someone offers to carry.
 *
 * The mirror of a need. Somebody in Japan says "I live here, I can buy things
 * and post them to Estonia and Finland" — and the same rules as needs apply
 * about who may touch it (docs/02-roles-and-permissions.md).
 *
 * Two things work differently from needs, and both are in issue #17:
 *
 *   CATEGORIES ARE MANY-TO-MANY. A need is filed under one category; a helper
 *   offers to shop across several, so a help has a list. Prisma calls the
 *   operations `connect` (add these) and `set` (replace with exactly these).
 *
 *   shipsTo IS A LIST OF COUNTRIES, AND EMPTY MEANS ANYWHERE. Not "nowhere" —
 *   the schema says so (prisma/schema.prisma) and the browse filter in #18
 *   depends on it.
 */

/** The most categories one offer may claim. */
export const MAX_HELP_CATEGORIES = 10;

/** The most countries one offer may list. Empty still means anywhere. */
export const MAX_SHIPS_TO = 50;

/** The fields a caller may set when creating an offer. */
export interface CreateHelpInput {
  country: string;
  shipsTo: string[];
  description: string;
  categoryIds: string[];
  status: Extract<HelpStatus, "ACTIVE" | "PAUSED">;
}

/** The fields a caller may change afterwards. All optional. */
export type UpdateHelpInput = {
  [K in keyof CreateHelpInput]?: CreateHelpInput[K] | undefined;
};

/** An offer with its categories, which is how callers want to read one. */
export type HelpWithCategories = Help & {
  categories: { id: string; slug: string; name: string }[];
};

/** Always return categories with an offer: an offer without them is half a listing. */
const withCategories = {
  categories: { select: { id: true, slug: true, name: true } },
} as const;

/**
 * Loads an offer this user is allowed to change, or explains why not.
 *
 * The same shape as loadOwnNeed in ./needs.js, and the same reasoning: the
 * ownership rule belongs in one place per service, not in each function.
 */
async function loadOwnHelp(
  actor: User,
  helpId: string,
): Promise<HelpWithCategories> {
  const help = await prisma.help.findUnique({
    where: { id: helpId },
    include: withCategories,
  });

  if (!help) {
    throw HttpError.notFound("Help not found");
  }

  if (help.helperId !== actor.id) {
    throw HttpError.forbidden("This offer belongs to someone else");
  }

  return help;
}

/**
 * Posts an offer.
 *
 * TODO(#17):
 *
 *   1. prisma.help.create, with helperId: actor.id, the plain fields from
 *      input, `include: withCategories`, and the categories attached:
 *
 *        categories: { connect: input.categoryIds.map((id) => ({ id })) }
 *
 *      `connect` links rows that already exist. This is the many-to-many part
 *      of the issue: Prisma writes the join table rows for you.
 *
 *   2. A categoryId that matches nothing makes `connect` fail with Prisma's
 *      code "P2025" — note that it is NOT the "P2003" a need gets. A need
 *      stores a categoryId in its own column, so the database rejects it as a
 *      foreign key; a help asks Prisma to find rows and link them, and Prisma
 *      refuses before that. isMissingRelated() below recognises it. Turn it
 *      into HttpError.badRequest("Unknown category") rather than a 500.
 *
 * There is no limit on how many offers one account may post. A need takes a
 * place in a queue someone must answer; an offer just sits there. If that
 * turns out to be wrong, the limit belongs here, beside the needs one.
 */
export async function createHelp(
  actor: User,
  input: CreateHelpInput,
): Promise<HelpWithCategories> {
  // TODO(#17): replace this whole body.
  return Promise.reject(new Error("createHelp is not implemented yet"));
}

/**
 * Changes an offer the user owns.
 *
 * TODO(#17):
 *
 *   1. loadOwnHelp — that is the ownership rule, already written.
 *
 *   2. A REMOVED offer cannot be edited → HttpError.conflict(...). PAUSED can:
 *      pausing is how a helper says "not this month", and they should be able
 *      to fix a typo while paused.
 *
 *   3. Update with onlyProvided(...) for the plain fields, and — only when
 *      input.categoryIds was given — replace the categories:
 *
 *        categories: { set: input.categoryIds.map((id) => ({ id })) }
 *
 *      `set` REPLACES the list, where `connect` adds to it. That is what a
 *      PATCH means here: the categories you send are the categories it has.
 *      Leaving categoryIds out must change nothing.
 *
 *   4. Catch P2025 for an unknown category, as in createHelp.
 */
export async function updateHelp(
  actor: User,
  helpId: string,
  input: UpdateHelpInput,
): Promise<HelpWithCategories> {
  // TODO(#17): replace this whole body.
  return Promise.reject(new Error("updateHelp is not implemented yet"));
}

/**
 * Takes an offer down.
 *
 * TODO(#17):
 *
 *   1. loadOwnHelp. Already REMOVED → return quietly, as deleting a closed
 *      need does.
 *
 *   2. Set status to "REMOVED". Do not delete the row: proposals point at a
 *      help (`Proposal.helpId`), and deleting it would either fail or tear a
 *      hole in somebody's deal history.
 *
 * HelpStatus has no CLOSED, so REMOVED covers both a helper taking their offer
 * down and a moderator hiding it (#27). The two stay distinguishable because a
 * moderator's action is recorded in AdminAction — the audit log is what says
 * who did it and why.
 */
export async function deleteHelp(actor: User, helpId: string): Promise<void> {
  // TODO(#17): replace this whole body.
  return Promise.reject(new Error("deleteHelp is not implemented yet"));
}

/**
 * Prisma's "the rows you asked me to connect are not there" error.
 *
 * Different from the foreign key error a need gets for the same mistake, which
 * is why needs and helps each recognise their own.
 */
function isMissingRelated(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2025"
  );
}
