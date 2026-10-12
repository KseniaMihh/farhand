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

const { CLEANUP_STORE, countObjects, SHARED_STORE } =
  await import("./helpers/files.js");

// Both stores since #111. The cleanup one is derived rather than
// configured, which makes it exactly the sort of thing that grows for years
// because nobody remembers it is there.
const stores = [SHARED_STORE, CLEANUP_STORE];
const counts = await Promise.all(stores.map((name) => countObjects(name)));
const left = counts.reduce((sum, n) => sum + n, 0);

if (left !== 0) {
  const detail = stores
    .map((name, i) => `${name}: ${String(counts[i])}`)
    .join(", ");
  console.error(
    `The file stores still hold ${String(left)} object(s) after the suite ` +
      `(${detail}). The teardown in tests/setup/global-setup.ts did not run, ` +
      `or did not finish. Left alone this grows every run until listing a ` +
      `bucket times a test out (#109).`,
  );
  process.exit(1);
}

console.info("[store] both stores empty after the suite, as they should be");
