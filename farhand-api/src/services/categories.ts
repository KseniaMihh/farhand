import type { Prisma } from "@prisma/client";
import { prisma } from "../db.js";

/**
 * The categories a need or an offer must have (#159).
 *
 * `Category` has been a real table since #6 and seeded since then, and until
 * now nothing handed the list over: `POST /needs` demands a `categoryId`,
 * `POST /helps` demands `categoryIds`, and the only published mention of a
 * category was as a FILTER on the two browse endpoints — which presumes the
 * caller already has an id from somewhere. The only somewhere was the
 * database, by hand. A terminal can do that; a form cannot.
 *
 * Found while seeding data for #158's screenshots, and filed before the
 * screen that needs it rather than discovered halfway through building it.
 */

/**
 * The shape a category is read in, and the ONE place it is written down.
 *
 * `src/services/helps.ts` has returned exactly this inside every offer since
 * #17 — "an offer always comes back with its categories". A second copy of a
 * three-field select looks harmless and is how one of them grows a field.
 * That file imports this rather than repeating it.
 *
 * `helps.ts` keeps its own `withCategories` wrapper, which is a different
 * thing: this says what a category looks like, that says "an offer carries
 * them". Only the inner select is shared.
 */
export const CATEGORY_FACTS = {
  id: true,
  slug: true,
  name: true,
} as const;

/** One category, as every caller reads it. */
export interface CategoryView {
  id: string;
  slug: string;
  name: string;
}

/**
 * Every category, in the order a person would expect to see them.
 *
 * BY NAME RATHER THAN BY SLUG. The two are close enough to look
 * interchangeable — "beauty-care" and "Beauty & care" — and a slug sorts on
 * its punctuation, which is not a thing a reader can see.
 *
 * Postgres sorts by byte under the default collation, so this is not the
 * locale-aware order `Intl.Collator` gives the country list in the frontend.
 * For eleven English names it makes no difference. Worth knowing before
 * somebody adds a category beginning with a diacritic and wonders why it is
 * last.
 *
 * NO PAGING, and docs/06-api-contract.md says why rather than leaving it as
 * an inconsistency. Every other list here is paged because it grows with
 * use; this one has eleven rows and cannot grow without a migration, so a
 * cursor would be furniture with nothing behind it.
 *
 * An empty table answers `[]`, not a failure. A database nobody has seeded
 * is a deployment that is not finished, and the shape of the answer should
 * not be the thing that says so.
 */
export function listCategories(
  client: Prisma.TransactionClient = prisma,
): Promise<CategoryView[]> {
  return client.category.findMany({
    orderBy: { name: "asc" },
    select: CATEGORY_FACTS,
  });
}
