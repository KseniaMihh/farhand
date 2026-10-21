import type { Prisma, SavedSearch, SearchKind, User } from "@prisma/client";
import { prisma } from "../db.js";
import { HttpError } from "../errors.js";
import { isForeignKeyError } from "./shared.js";
import { enqueue } from "./jobs.js";
import { notify } from "./notifications.js";

/**
 * Saved searches (#90): a standing query, and being told when it matches.
 *
 * Three decisions, and each one is somewhere else in this project already:
 *
 *   WHAT IS STORED   columns, not a blob — prisma/schema.prisma says why, and
 *                    the two country columns are shared by both kinds because
 *                    they are the same two facts under different names
 *   WHO IS TOLD      a match writes a Notification (#86) and the queue sends
 *                    one email. This is the one exception decision 0020's
 *                    rule allows itself, and it is narrow: the person asked
 *                    for this thing by name
 *                    (docs/10-decisions/0026-the-one-email-somebody-asked-for.md)
 *   WHEN IT RUNS     never inside the request that published the listing. The
 *                    publish enqueues, the worker matches (#85)
 *
 * The matching is the interesting half, and it reads backwards from every
 * other query in this codebase. Browsing asks "which listings match this
 * filter"; this asks "which filters match this listing". `NULL means any` is
 * what lets that be one query rather than a loop.
 */

/**
 * How many standing queries one account may have.
 *
 * Ten, for the reason the issue gives: this must not become a way to run a
 * hundred standing queries, each of them a scan on every publish and an email
 * to somebody who has stopped reading them.
 */
export const MAX_SAVED_SEARCHES = 10;

/** What a person may save, in the names the browse endpoints use (#16, #18). */
export type SavedSearchInput =
  | {
      kind: "NEED";
      name: string;
      notify: boolean;
      filters: {
        buyCountry?: string | undefined;
        deliverCountry?: string | undefined;
        categoryId?: string | undefined;
        q?: string | undefined;
      };
    }
  | {
      kind: "HELP";
      name: string;
      notify: boolean;
      filters: {
        country?: string | undefined;
        shipsTo?: string | undefined;
        categoryId?: string | undefined;
      };
    };

/**
 * A saved search as its owner sees it: the stored row read back in the words
 * they sent, so what you POST is what you GET.
 */
export interface SavedSearchView {
  id: string;
  kind: SearchKind;
  name: string;
  notify: boolean;
  filters: Record<string, string>;
  createdAt: Date;
}

/**
 * The row, in the caller's words.
 *
 * A filter that was not set is ABSENT rather than null. The object is "what I
 * asked for", and a list of nulls is a list of questions nobody asked — the
 * same argument `PublicProfile` makes for leaving a rating out until there is
 * one to show (src/services/profiles.ts).
 */
export function savedSearchView(row: SavedSearch): SavedSearchView {
  const filters: Record<string, string> =
    row.kind === "NEED"
      ? {
          ...(row.fromCountry ? { buyCountry: row.fromCountry } : {}),
          ...(row.toCountry ? { deliverCountry: row.toCountry } : {}),
          ...(row.categoryId ? { categoryId: row.categoryId } : {}),
          ...(row.q ? { q: row.q } : {}),
        }
      : {
          ...(row.fromCountry ? { country: row.fromCountry } : {}),
          ...(row.toCountry ? { shipsTo: row.toCountry } : {}),
          ...(row.categoryId ? { categoryId: row.categoryId } : {}),
        };

  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    notify: row.notify,
    filters,
    createdAt: row.createdAt,
  };
}

/** The caller's words, as columns. The mapping schema.prisma explains. */
function columnsFor(input: SavedSearchInput): {
  fromCountry: string | null;
  toCountry: string | null;
  categoryId: string | null;
  q: string | null;
} {
  if (input.kind === "NEED") {
    return {
      fromCountry: input.filters.buyCountry ?? null,
      toCountry: input.filters.deliverCountry ?? null,
      categoryId: input.filters.categoryId ?? null,
      q: input.filters.q ?? null,
    };
  }

  return {
    fromCountry: input.filters.country ?? null,
    toCountry: input.filters.shipsTo ?? null,
    categoryId: input.filters.categoryId ?? null,
    // The offers list has no text filter to save (#18), so there is nothing
    // that could put a word in this column for a HELP search.
    q: null,
  };
}

/**
 * Saves one, or refuses because there are already MAX_SAVED_SEARCHES.
 *
 * The count and the insert are one transaction with the user row locked,
 * the same shape as the receipt limit (src/services/receipts.ts): a
 * count-then-insert that two requests can both pass is a limit that is only
 * true when nobody is in a hurry.
 */
export async function saveSearch(
  actor: User,
  input: SavedSearchInput,
): Promise<SavedSearchView> {
  try {
    const row = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM "User" WHERE id = ${actor.id} FOR UPDATE`;

      const saved = await tx.savedSearch.count({ where: { userId: actor.id } });
      if (saved >= MAX_SAVED_SEARCHES) {
        throw HttpError.conflict(
          `You already have ${String(MAX_SAVED_SEARCHES)} saved searches. Delete one first.`,
        );
      }

      return tx.savedSearch.create({
        data: {
          userId: actor.id,
          kind: input.kind,
          name: input.name,
          notify: input.notify,
          ...columnsFor(input),
        },
      });
    });

    return savedSearchView(row);
  } catch (error) {
    // The category is a foreign key, so an unknown one is the database's
    // answer rather than a lookup of our own — the same handling as a need
    // filed under a category that is not there (src/services/needs.ts).
    if (isForeignKeyError(error)) {
      throw HttpError.badRequest("Unknown category");
    }
    throw error;
  }
}

/** This person's searches, newest first. No cursor: there are ten at most. */
export async function listMySearches(actor: User): Promise<SavedSearchView[]> {
  const rows = await prisma.savedSearch.findMany({
    where: { userId: actor.id },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });

  return rows.map(savedSearchView);
}

/**
 * Deletes one of the caller's own.
 *
 * Somebody else's is a 404 rather than a 403, the rule #79 set for files: a
 * row you may not read is one you may not know exists. `deleteMany` with the
 * owner in the `where` is how that is said in one statement — there is no
 * window between reading the row and deleting it in which it could become
 * somebody else's.
 */
export async function deleteMySearch(
  actor: User,
  searchId: string,
): Promise<void> {
  const { count } = await prisma.savedSearch.deleteMany({
    where: { id: searchId, userId: actor.id },
  });

  if (count === 0) {
    throw HttpError.notFound("Saved search not found");
  }
}

/**
 * Queues the matching, inside the transaction that published the listing.
 *
 * Called from the four places a listing becomes public — the same four places
 * #87 asks for the tick, because it is the same event (`needsAcknowledgement`,
 * src/services/prohibited.ts). Inside the transaction for #85's reason: a job
 * for a row that was rolled back is a job that fails forever.
 */
export async function queueMatching(
  client: Prisma.TransactionClient,
  kind: SearchKind,
  listingId: string,
): Promise<void> {
  await enqueue("search-match", { kind, listingId }, client);
}

/**
 * Everything that matches a listing which has just gone public.
 *
 * Runs in the worker (#85). Two halves, and the split is not arbitrary:
 *
 *   the columns   one query, because `NULL means any` can be written as
 *                 `fromCountry IS NULL OR fromCountry = $1`
 *   the words     `q` in JavaScript, because the comparison is the wrong way
 *                 round for the database to help with — it is the LISTING
 *                 that has to contain the saved word, not the other way about
 *
 * Safe to run twice, which #85's queue requires of every handler: the second
 * run finds the same searches and calls `notify` again, and the unique index
 * on (userId, kind, subjectId) turns the second call into nothing.
 */
export async function matchListing(
  kind: SearchKind,
  listingId: string,
): Promise<void> {
  const matched =
    kind === "NEED"
      ? await searchesMatchingNeed(listingId)
      : await searchesMatchingHelp(listingId);

  // One person, one email, however many of their searches caught it. The
  // index would stop the second anyway; this stops the second query.
  const people = [...new Set(matched.map((search) => search.userId))];

  for (const userId of people) {
    await notify(userId, "saved-search-match", {
      type: kind === "NEED" ? "need" : "help",
      id: listingId,
    });
  }
}

/** The NEED half: the columns in SQL, the words in JavaScript. */
async function searchesMatchingNeed(
  needId: string,
): Promise<{ userId: string }[]> {
  const need = await prisma.need.findUnique({
    where: { id: needId },
    select: {
      status: true,
      requesterId: true,
      categoryId: true,
      buyCountry: true,
      deliverCountry: true,
      title: true,
      description: true,
    },
  });

  // Not public any more, or not there at all. A listing nobody can see is
  // nothing to tell anybody about, and the composer would refuse it a second
  // time anyway (src/services/notifications.ts).
  if (need?.status !== "OPEN") return [];

  const candidates = await prisma.savedSearch.findMany({
    where: {
      kind: "NEED",
      notify: true,
      // Nobody is told about their own listing: 0020's "anything you did
      // yourself", which half the deal table is already silent for.
      userId: { not: need.requesterId },
      AND: [
        anyOr("fromCountry", need.buyCountry),
        anyOr("toCountry", need.deliverCountry),
        anyOr("categoryId", need.categoryId),
      ],
    },
    select: { userId: true, q: true },
  });

  const words = `${need.title}\n${need.description}`.toLowerCase();

  return candidates.filter(
    (search) => search.q === null || words.includes(search.q.toLowerCase()),
  );
}

/** The HELP half. Two columns are lists here, which is the whole difference. */
async function searchesMatchingHelp(
  helpId: string,
): Promise<{ userId: string }[]> {
  const help = await prisma.help.findUnique({
    where: { id: helpId },
    select: {
      status: true,
      helperId: true,
      country: true,
      shipsTo: true,
      categories: { select: { id: true } },
    },
  });

  if (help?.status !== "ACTIVE") return [];

  return prisma.savedSearch.findMany({
    where: {
      kind: "HELP",
      notify: true,
      userId: { not: help.helperId },
      AND: [
        anyOr("fromCountry", help.country),
        // An empty `shipsTo` means no restriction, so the offer goes
        // everywhere and every saved destination matches — the same rule
        // `GET /helps` applies from the other side (#18).
        help.shipsTo.length === 0
          ? {}
          : {
              OR: [{ toCountry: null }, { toCountry: { in: help.shipsTo } }],
            },
        {
          OR: [
            { categoryId: null },
            { categoryId: { in: help.categories.map((row) => row.id) } },
          ],
        },
      ],
    },
    select: { userId: true },
  });
}

/** `NULL means any`, as one clause: this column is unset, or it is this. */
function anyOr(
  column: "fromCountry" | "toCountry" | "categoryId",
  value: string,
): Prisma.SavedSearchWhereInput {
  return { OR: [{ [column]: null }, { [column]: value }] };
}
