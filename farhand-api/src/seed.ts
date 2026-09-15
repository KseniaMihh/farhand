import { prisma } from "./db.js";
import { logger } from "./logger.js";

/**
 * Seeds the fixed category list. Run with `npm run seed`.
 *
 * Idempotent: it compares what's in the database with the list below and only
 * writes the difference, so running it twice — or on every deploy — is safe.
 *
 * `slug` is the permanent identifier: filters and URLs will use it, so never
 * change one. `name` is display text and can be renamed here freely; the next
 * run updates it.
 *
 * Removing an entry does NOT delete the category, because needs and helps may
 * already point at it. The script only warns, and removal becomes a deliberate
 * migration that decides what happens to those listings.
 *
 * The list avoids the prohibited items in docs/07-trust-and-safety.md, which is
 * why food is limited to non-perishable and there is no health category.
 */
const CATEGORIES = [
  { slug: "cosmetics", name: "Cosmetics & skincare" },
  { slug: "electronics", name: "Electronics & accessories" },
  { slug: "clothing", name: "Clothing & shoes" },
  { slug: "books", name: "Books & media" },
  { slug: "toys", name: "Toys & games" },
  { slug: "baby", name: "Baby & kids" },
  { slug: "home", name: "Home & kitchen" },
  { slug: "sports", name: "Sports & outdoors" },
  { slug: "hobbies", name: "Hobbies & crafts" },
  { slug: "food", name: "Packaged food (non-perishable)" },
  { slug: "other", name: "Other" },
] as const;

async function main(): Promise<void> {
  const existing = await prisma.category.findMany({
    select: { slug: true, name: true },
  });
  const nameBySlug = new Map(existing.map((c) => [c.slug, c.name]));
  const listedSlugs = new Set<string>(CATEGORIES.map((c) => c.slug));

  const toCreate = CATEGORIES.filter((c) => !nameBySlug.has(c.slug));
  const toRename = CATEGORIES.filter(
    (c) => nameBySlug.has(c.slug) && nameBySlug.get(c.slug) !== c.name,
  );
  const unlisted = existing.filter((c) => !listedSlugs.has(c.slug));

  // One transaction: a failure halfway leaves the table as it was, not half
  // seeded.
  await prisma.$transaction([
    prisma.category.createMany({ data: toCreate.map((c) => ({ ...c })) }),
    ...toRename.map((c) =>
      prisma.category.update({
        where: { slug: c.slug },
        data: { name: c.name },
      }),
    ),
  ]);

  logger.info(
    {
      created: toCreate.map((c) => c.slug),
      renamed: toRename.map((c) => c.slug),
      unchanged: CATEGORIES.length - toCreate.length - toRename.length,
    },
    "Categories seeded",
  );

  if (unlisted.length > 0) {
    logger.warn(
      { slugs: unlisted.map((c) => c.slug) },
      "Categories in the database but not in the seed list were left in place",
    );
  }
}

main()
  .catch((error: unknown) => {
    logger.fatal({ err: error }, "Seeding failed");
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
