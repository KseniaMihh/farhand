import { config as loadEnvFile } from "dotenv";
import { defineConfig } from "vitest/config";

/**
 * Test runner configuration.
 *
 * The critical job of this file is making sure the tests can only ever reach
 * the test database. `src/env.ts` reads `process.env` at import time, so the
 * right values have to be in place before any test file loads — which is what
 * `test.env` below does, in every worker.
 */

// `override: true` is deliberate. dotenv's default is to leave an existing
// process.env value alone, which would mean a DATABASE_URL exported in your
// shell silently wins and the suite truncates your development database.
const { parsed: testEnv = {} } = loadEnvFile({
  path: ".env.test",
  override: true,
  quiet: true,
});

export default defineConfig({
  test: {
    // Only files we wrote as tests. Without this, Vitest would also try to run
    // anything test-shaped inside node_modules or dist.
    include: ["tests/**/*.test.ts"],

    // Handed to the worker processes. The values dotenv put on this process
    // cover globalSetup, which runs here rather than in a worker.
    env: testEnv,

    // Creates the database if needed and applies migrations. Runs once for the
    // whole suite, not once per file.
    globalSetup: ["tests/setup/global-setup.ts"],

    // Runs inside every worker, before each test file.
    setupFiles: ["tests/setup/truncate.ts"],

    // One database, shared by every test, truncated between tests — so two
    // test files running at the same time would delete each other's rows
    // halfway through. Turning off file parallelism pins the suite to a single
    // worker, which makes it strictly sequential.
    //
    // This is the cost of testing against a real database, and it is the right
    // trade: the alternative is mocking Prisma, which tests our idea of what
    // Postgres does instead of what it actually does. If the suite ever gets
    // slow enough to hurt, the fix is a database per worker
    // (VITEST_POOL_ID in the connection string), not parallel tests sharing one.
    fileParallelism: false,

    // Migrating a cold database on the first run takes a moment.
    hookTimeout: 30_000,

    restoreMocks: true,
  },
});
