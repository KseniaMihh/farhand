import { execSync } from "node:child_process";
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

export async function setup(): Promise<void> {
  const url = testDatabaseUrl();

  await ensureDatabaseExists(url);
  applyMigrations(url);
  await ensureBucketExists();
}
