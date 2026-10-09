import { config as loadEnvFile } from "dotenv";

/**
 * Fails if the file store is not empty. Run AFTER the suite (#109).
 *
 * `tests/setup/global-setup.ts` empties the store before the suite and again
 * when it finishes. The first half is proved from inside — a test asserts the
 * count the setup provides. The second half is not: nothing running inside the
 * suite can see what happens after the last test, so without this the teardown
 * would be a line nobody could tell had stopped working.
 *
 * So CI runs this straight after `npm test`, and anybody can run it by hand:
 *
 *     npm run test:store-empty
 *
 * It is not a test file on purpose. Vitest would run it with everything else,
 * which is exactly when the answer is not yet known.
 */

// Same as vitest.config.ts: the test settings win over whatever is in the
// shell, so this can never be pointed at a real store by accident.
loadEnvFile({ path: ".env.test", override: true, quiet: true });

const { countObjects } = await import("./helpers/files.js");

const left = await countObjects();

if (left !== 0) {
  console.error(
    `The file store still holds ${String(left)} object(s) after the suite. ` +
      `The teardown in tests/setup/global-setup.ts did not run, or did not ` +
      `finish. Left alone this grows every run until listing the bucket times ` +
      `a test out (#109).`,
  );
  process.exit(1);
}

console.info("[store] empty after the suite, as it should be");
