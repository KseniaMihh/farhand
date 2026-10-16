import { afterAll, beforeEach } from "vitest";
import { prisma } from "../../src/db.js";
import { env } from "../../src/env.js";

/**
 * Empties the database before every test.
 *
 * Registered as a Vitest `setupFile`, so it runs inside each worker and applies
 * to every test file without them importing anything.
 *
 * Why truncation rather than wrapping each test in a transaction and rolling
 * back: a rollback never lets you observe what a COMMIT inside the code under
 * test actually did, and the interesting rules in this project — accepting a
 * proposal, the deal state machine — are transactions. Testing them from inside
 * an outer transaction would test a situation that never happens in production.
 * Truncation is slower and honest.
 */

/**
 * Refuses to run against anything that is not obviously a test database.
 *
 * This file's whole purpose is deleting every row it can reach, so it is worth
 * a few lines to make a misconfiguration impossible rather than merely unlikely.
 * Both conditions have to hold, so neither a stale NODE_ENV nor a copy-pasted
 * connection string is enough on its own.
 */
function assertTestDatabase(): void {
  const databaseName = decodeURIComponent(
    new URL(env.DATABASE_URL).pathname.replace(/^\//, ""),
  );

  if (env.NODE_ENV !== "test" || !databaseName.endsWith("_test")) {
    throw new Error(
      `Refusing to truncate: NODE_ENV is "${env.NODE_ENV}" and the database is ` +
        `"${databaseName}". The test suite only runs with NODE_ENV=test against ` +
        `a database whose name ends in "_test". Check .env.test.`,
    );
  }
}

assertTestDatabase();

/**
 * Every table Prisma owns, discovered from the database rather than listed by
 * hand — a hand-written list goes stale the first time someone adds a model and
 * leaves rows leaking between tests.
 *
 * `_prisma_migrations` is excluded: it is Prisma's own bookkeeping, and
 * emptying it would make the next `migrate deploy` replay every migration.
 */
async function tablesToTruncate(): Promise<string[]> {
  const rows = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename
    FROM pg_tables
    WHERE schemaname = 'public'
      AND tablename <> '_prisma_migrations'
  `;

  return rows.map((row) => row.tablename);
}

// Discovered once per worker. The schema cannot change mid-run.
let cachedTables: string[] | undefined;

beforeEach(async () => {
  cachedTables ??= await tablesToTruncate();

  if (cachedTables.length === 0) return;

  const tableList = cachedTables
    .map((name) => `"public"."${name.replace(/"/g, '""')}"`)
    .join(", ");

  // One statement for all tables, because TRUNCATE takes an exclusive lock and
  // separate statements would deadlock against each other's foreign keys.
  //
  // CASCADE follows foreign keys, which here only reaches tables already in the
  // list. RESTART IDENTITY resets the sequences too, so a test that expects the
  // first row to have id 1 gets the same answer whether it runs alone or last.
  //
  // Note this also clears the seeded categories from issue #6. That is
  // deliberate: a test that needs a category should create the one it needs,
  // rather than quietly depending on seed data that may change.
  await prisma.$executeRawUnsafe(
    `TRUNCATE TABLE ${tableList} RESTART IDENTITY CASCADE`,
  );

  await seedProhibited();
});

/**
 * Puts the prohibited list back after each truncation (#87).
 *
 * THE ONE EXCEPTION to the paragraph above, and the reason it is one: since
 * #87 nothing can be posted publicly without ticking the current list, so an
 * empty table does not mean "no list to bother with", it means every need and
 * every help in the suite is refused. That is not a fixture a test chooses,
 * like a category; it is a site-wide rule, nearer to "the bucket exists" than
 * to "there is a category called electronics".
 *
 * The wording here is deliberately NOT the production list from
 * `src/seed.ts` — three short lines, so a test that asserts on the list reads
 * as a test rather than as a transcription, and so that rewording a real
 * clause never breaks the suite.
 *
 * `tests/prohibited/acknowledgement.test.ts` replaces this list with its own
 * and deletes it outright, which is what keeps the harness honest: the rule is
 * tested against lists this file knows nothing about.
 */
async function seedProhibited(): Promise<void> {
  await prisma.prohibitedItem.createMany({ data: PROHIBITED_FIXTURE });
}

export const PROHIBITED_FIXTURE = [
  { slug: "weapons", text: "Weapons, ammunition and parts", position: 1 },
  { slug: "drugs", text: "Drugs of every kind", position: 2 },
  { slug: "live-animals", text: "Live animals", position: 3 },
];

// Without this the pool keeps connections open and Vitest hangs at the end
// waiting for a process that will not exit.
afterAll(async () => {
  await prisma.$disconnect();
});
