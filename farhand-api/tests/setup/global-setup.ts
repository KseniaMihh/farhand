import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Client } from "pg";

/**
 * Runs once, before the whole suite, in the main Vitest process.
 *
 * Two jobs: make sure the test database exists, and make sure its schema
 * matches the migrations. After this, every test can assume a real database
 * with the current tables in it.
 */

/** The connection string for the test database, as vitest.config.ts loaded it. */
function testDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;

  if (!url) {
    throw new Error(
      "DATABASE_URL is not set. vitest.config.ts loads it from .env.test — " +
        "check that the file exists.",
    );
  }

  return url;
}

/**
 * Creates the test database if it is not there yet.
 *
 * `docker-compose.yml` mounts an init script that does the same thing, but that
 * only runs on a fresh volume — so on any machine that already had the stack
 * running, this is what actually creates it. Cheap to check, and it means
 * `npm test` works from a cold start without anyone reading a setup guide.
 *
 * CREATE DATABASE cannot run inside a transaction and cannot target the
 * database you are connected to, so this connects to the built-in `postgres`
 * database to issue it.
 */
async function ensureDatabaseExists(url: string): Promise<void> {
  const parsed = new URL(url);
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ""));

  const adminUrl = new URL(url);
  adminUrl.pathname = "/postgres";

  const admin = new Client({ connectionString: adminUrl.toString() });
  await admin.connect();

  try {
    const existing = await admin.query(
      "SELECT 1 FROM pg_database WHERE datname = $1",
      [databaseName],
    );

    if (existing.rowCount === 0) {
      // The name cannot be a bound parameter in DDL. It comes from our own
      // .env.test rather than user input, and the identifier is quoted with
      // doubled quotes, which is the escape Postgres expects.
      await admin.query(
        `CREATE DATABASE "${databaseName.replace(/"/g, '""')}"`,
      );
      console.info(`[test setup] created database ${databaseName}`);
    }
  } finally {
    await admin.end();
  }
}

/**
 * Brings the test database's schema up to date.
 *
 * `migrate deploy` rather than `migrate dev`: deploy applies the existing
 * migration files and nothing else. `dev` would compare the schema and offer to
 * generate a new migration, which is an interactive prompt in a place that must
 * never prompt — and would invent migrations nobody reviewed.
 */
function applyMigrations(url: string): void {
  // A single command string rather than a program plus an argument array:
  // npx resolves through a shell either way, and Node deprecates passing an
  // array alongside `shell: true` because the arguments would not be escaped.
  // Nothing here comes from outside the repository, but the deprecation-free
  // form is also the simpler one.
  execSync("npx prisma migrate deploy", {
    // prisma.config.ts calls dotenv, which does not overwrite a variable that
    // is already set — so this one wins over .env.
    env: { ...process.env, DATABASE_URL: url },
    // Prisma's progress chatter is noise in test output; its errors are not.
    stdio: ["ignore", "ignore", "inherit"],
  });
}

/**
 * Creates the test bucket in the local S3 store (S3Proxy, docker-compose.yml).
 *
 * Retried, because S3Proxy is a Java process that takes several seconds to
 * start listening after its container is "up" — in CI especially, where the
 * suite begins the moment the runner is ready. Imported here rather than at
 * the top: src/storage.ts reads src/env.ts, which must not load before
 * vitest.config.ts has put .env.test in place.
 */
async function ensureBucketExists(): Promise<void> {
  const { storage } = await import("../../src/storage.js");
  const deadline = Date.now() + 60_000;

  for (;;) {
    try {
      await storage.ensureBucket();
      return;
    } catch (error) {
      if (Date.now() > deadline) {
        throw new Error(
          "The local file store is not answering. Is the `storage` service " +
            "from docker-compose.yml running? (docker compose up -d storage)",
          { cause: error },
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}

/**
 * Empties the store before the suite runs, and reports what is left (#109).
 *
 * Nothing used to empty it, so every file test the project had ever run left
 * its bytes behind — 5,230 objects by the morning this was written, growing by
 * about 460 a run. Listing a bucket that size takes 563 ms, and four tests
 * listed it twice each.
 *
 * The number this returns is what `tests/files/store-cleanup.test.ts` asserts
 * is zero. For that assertion to mean anything on a machine whose store is
 * empty already — a fresh clone, every CI run — there has to have been
 * something to remove. Hence the object written first, on purpose: without it
 * the test would pass whether or not this function did anything at all, which
 * is the definition of a test that cannot fail.
 */
async function startWithAnEmptyStore(): Promise<number> {
  const {
    CLEANUP_STORE,
    countObjects,
    emptyBucket,
    ensureBucket,
    putObjectBehindTheApi,
  } = await import("../helpers/files.js");

  // The second store is derived rather than configured, so nothing else
  // creates it (#111). Emptying a bucket that does not exist is an error,
  // not a no-op.
  //
  // Unfalsifiable on a warm machine: S3Proxy keeps the bucket inside its
  // container, so once any run has made it, a version of this line that does
  // nothing looks identical. It bites on a fresh container and in CI, where
  // the service starts empty every time.
  await ensureBucket(CLEANUP_STORE);

  await putObjectBehindTheApi(`files/cleanup-sentinel-${randomUUID()}`);
  const removed = (await emptyBucket()) + (await emptyBucket(CLEANUP_STORE));
  console.info(`[test setup] emptied the file stores (${String(removed)})`);

  // Counted, not inferred from `removed`. An `emptyBucket` that quietly did
  // nothing would report removing nothing and look exactly like an empty
  // store; only a fresh listing can tell those apart, and the sentinel above
  // guarantees the listing has something to find if the emptying failed.
  //
  // Both stores, summed: either one left holding anything is a failure, and
  // the test that reads this asserts zero.
  //
  // Belt and braces, and unfalsifiable: both stores have just been emptied,
  // so a version counting only the first still answers zero. It would earn
  // its place the day emptying the second one silently stopped working —
  // which is the only scenario it exists for (#111).
  return (await countObjects()) + (await countObjects(CLEANUP_STORE));
}

export async function setup({
  provide,
}: {
  provide: (key: "storeObjectsAfterCleanup", value: number) => void;
}): Promise<void> {
  const url = testDatabaseUrl();

  await ensureDatabaseExists(url);
  applyMigrations(url);
  await ensureBucketExists();
  provide("storeObjectsAfterCleanup", await startWithAnEmptyStore());
}

/**
 * Runs once after the whole suite.
 *
 * Emptying at the start is what keeps the suite fast. Emptying at the end is
 * what makes "a full run leaves the store no larger than it found it" true for
 * somebody who looks afterwards rather than before — including whoever next
 * runs `docker compose ps` and wonders why the container has grown.
 *
 * Both stores since #111, for the same reason: a second bucket that nobody
 * empties is the first bucket's problem all over again.
 */
export async function teardown(): Promise<void> {
  const { CLEANUP_STORE, emptyBucket } = await import("../helpers/files.js");
  await emptyBucket();
  await emptyBucket(CLEANUP_STORE);
}

declare module "vitest" {
  interface ProvidedContext {
    /** 0 when the store was emptied before the suite began (#109). */
    storeObjectsAfterCleanup: number;
  }
}
