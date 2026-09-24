/* eslint-disable @typescript-eslint/no-unused-vars --
   The browsing stubs at the bottom do not use their arguments or the paging
   imports yet. DELETE THIS LINE once they are implemented. */
import { Prisma } from "@prisma/client";
import type { Help, HelpStatus, User } from "@prisma/client";
import { prisma } from "../db.js";
import { HttpError } from "../errors.js";
import {
  afterCursor,
  type CursorPosition,
  onlyProvided,
  type Page,
  toPage,
} from "./shared.js";

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
 */
export async function createHelp(
  actor: User,
  input: CreateHelpInput,
): Promise<HelpWithCategories> {
  try {
    return await prisma.help.create({
      data: {
        helperId: actor.id,
        country: input.country,
        shipsTo: input.shipsTo,
        description: input.description,
        status: input.status,
        categories: {
          connect: input.categoryIds.map((id) => ({ id })),
        },
      },
      include: withCategories,
    });
  } catch (error) {
    if (isMissingRelated(error)) {
      throw HttpError.badRequest("Unknown category");
    }
    throw error;
  }
}

/**
 * Changes an offer the user owns.
 */
export async function updateHelp(
  actor: User,
  helpId: string,
  input: UpdateHelpInput,
): Promise<HelpWithCategories> {
  const help = await loadOwnHelp(actor, helpId);

  if (help.status === "REMOVED") {
    throw HttpError.conflict("This offer can no longer be edited");
  }

  const { categoryIds, ...rest } = input;

  try {
    return await prisma.help.update({
      where: { id: helpId },
      data: {
        ...onlyProvided(rest),
        ...(categoryIds
          ? { categories: { set: categoryIds.map((id) => ({ id })) } }
          : {}),
      },
      include: withCategories,
    });
  } catch (error) {
    if (isMissingRelated(error)) {
      throw HttpError.badRequest("Unknown category");
    }
    throw error;
  }
}

/**
 * Takes an offer down.
 */
export async function deleteHelp(actor: User, helpId: string): Promise<void> {
  const help = await loadOwnHelp(actor, helpId);

  if (help.status === "REMOVED") {
    return;
  }

  await prisma.help.update({
    where: { id: helpId },
    data: { status: "REMOVED" },
  });
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

/* ───────────────────────────── browsing (#18) ───────────────────────────── */

/** What a caller may narrow the public list of offers by. */
export interface HelpFilters {
  /** Where the helper is: an exact match. */
  country?: string | undefined;
  /** "I need it sent to EE" — see the note in listActiveHelps. */
  shipsTo?: string | undefined;
  categoryId?: string | undefined;
}

/**
 * The public list: active offers, newest first.
 *
 * TODO(#18):
 *
 *   1. where: status "ACTIVE", plus the filters that were given, plus the
 *      cursor condition. Paused and removed offers are not on show — a paused
 *      offer is a helper saying "not this month".
 *
 *      - country, categoryId are ordinary matches. A help has MANY categories,
 *        so the category filter is `categories: { some: { id: … } }`: "at
 *        least one of its categories is this one".
 *
 *      - shipsTo is the interesting one. An EMPTY shipsTo means the helper
 *        posts anywhere, so a search for "EE" must match both the offers
 *        listing EE and the offers listing nothing at all:
 *
 *          OR: [
 *            { shipsTo: { isEmpty: true } },
 *            { shipsTo: { has: filters.shipsTo } },
 *          ]
 *
 *        `has` asks "does this array contain that value", which is the
 *        question the GIN index on shipsTo exists to answer
 *        (prisma/schema.prisma). Miss the isEmpty half and every
 *        ships-anywhere helper quietly disappears from every search — the
 *        most useful helpers, invisible.
 *
 *      Both that OR and afterCursor's OR go in the same AND array, for the
 *      reason listOpenNeeds spells out: two ORs in one object, and the second
 *      silently replaces the first.
 *
 *   2. include: withCategories, orderBy [{ createdAt: "desc" }, { id: "desc" }],
 *      take limit + 1, then return toPage(rows, limit) — the same shape as
 *      needs, from ./shared.js.
 */
export async function listActiveHelps(
  filters: HelpFilters,
  position: CursorPosition | undefined,
  limit: number,
): Promise<Page<HelpWithCategories>> {
  // TODO(#18): replace this whole body.
  return Promise.reject(new Error("listActiveHelps is not implemented yet"));
}

/**
 * One offer, if this caller may see it.
 *
 * TODO(#18): the same shape as getVisibleNeed:
 *
 *   1. Load it with `include: withCategories`. Missing → 404.
 *   2. The helper sees their own offer whatever its status, which is how they
 *      find a paused one to restart.
 *   3. Everyone else sees it only while it is ACTIVE. Paused and removed
 *      answer the same 404 as an offer that never existed.
 */
export async function getVisibleHelp(
  helpId: string,
  viewerId: string | undefined,
): Promise<HelpWithCategories> {
  // TODO(#18): replace this whole body.
  return Promise.reject(new Error("getVisibleHelp is not implemented yet"));
}
