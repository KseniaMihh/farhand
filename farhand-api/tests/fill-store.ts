import { config as loadEnvFile } from "dotenv";

/**
 * Fills the test file store, so #110 can recreate the condition #109 removed.
 *
 *     npm run store:fill            # 6000 objects
 *     npm run store:fill -- 20000
 *
 * Why this exists. Until #109 the store was never emptied, so after a few
 * weeks of ordinary work it held thousands of objects — and that is the state
 * the unexplained five-second stall (#110) was last seen in. #109 makes every
 * run start empty, which is right, and which also means that state can no
 * longer happen by accident. It has to be reachable deliberately or the
 * question can never be asked again.
 *
 * The suite on this commit empties the store before it starts, so filling it
 * and then running `npm test` here proves nothing — the first thing the run
 * does is undo the fill. There is no flag to turn that off, deliberately: a
 * switch that disables the cleanup would live in the repository for ever for
 * the sake of one investigation.
 *
 * Run the suite from **before #109** instead, where nothing empties anything.
 * The fill is just objects in a bucket and does not care which commit the
 * suite comes from:
 *
 *     npm run store:fill -- 6000        # from here
 *     git worktree add --detach ../wt 2119c1b
 *     cd ../wt/farhand-api && npm test  # 10 times, counting stalls
 *
 * Point that worktree's .env.test at this same bucket, or fill its own.
 */

loadEnvFile({ path: ".env.test", override: true, quiet: true });

const { countObjects, fillBucket } = await import("./helpers/files.js");

const requested = Number(process.argv[2] ?? 6000);

if (!Number.isInteger(requested) || requested < 1) {
  console.error(`Not a count: "${String(process.argv[2])}"`);
  process.exit(1);
}

const before = await countObjects();
console.info(
  `[store] ${String(before)} objects, writing ${String(requested)}…`,
);

await fillBucket(requested);

const after = await countObjects();
console.info(
  `[store] ${String(after)} objects. A normal test run on this commit empties ` +
    `them again — see the comment at the top of this file.`,
);
