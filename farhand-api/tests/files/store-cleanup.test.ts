import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, inject, it } from "vitest";
import { env } from "../../src/env.js";
import {
  CLEANUP_STORE,
  emptyBucket,
  objectExists,
  putObjectBehindTheApi,
  SHARED_STORE,
} from "../helpers/files.js";

/**
 * The test store does not grow for ever (#109).
 *
 * The database is truncated before every test. The object store never was, so
 * every file test the project had ever run left its bytes behind: 3,364 one
 * afternoon, 5,230 the next morning, ~460 added per full run. That is a cost
 * that grows with the project's own history, and it had already crossed a hard
 * limit — at 14,489 objects, five tests in store.test.ts blew Vitest's
 * five-second timeout and took a whole mutation-testing run down with them.
 *
 * Two halves, and both are tested here:
 *
 *   1. `emptyBucket` really empties it.
 *   2. `global-setup.ts` really calls it, before the suite starts.
 *
 * The second is the one worth being careful about, because it is a wiring
 * check and those are the easy ones to fake. See the comment on the test.
 *
 * Everything that empties a store here empties `CLEANUP_STORE`, not the one
 * the rest of the suite uses (#111). These tests prove emptying works by
 * emptying, so on the shared store they wiped it partway through every run.
 * Nothing depended on that — but it cost an afternoon once, when 6,000
 * objects seeded to reproduce #110 came back as 434.
 */

describe("emptyBucket", () => {
  it("removes what is there and says how much it removed", async () => {
    const first = `files/${randomUUID()}`;
    const second = `files/${randomUUID()}`;
    for (const key of [first, second]) {
      await putObjectBehindTheApi(key, CLEANUP_STORE);
    }

    expect(await objectExists(first, CLEANUP_STORE)).toBe(true);
    expect(await objectExists(second, CLEANUP_STORE)).toBe(true);

    const removed = await emptyBucket(CLEANUP_STORE);

    expect(removed).toBeGreaterThanOrEqual(2);
    expect(await objectExists(first, CLEANUP_STORE)).toBe(false);
    expect(await objectExists(second, CLEANUP_STORE)).toBe(false);
  });

  it("is happy to run against a store that is already empty", async () => {
    await emptyBucket(CLEANUP_STORE);

    // Called twice in a row by anybody debugging, and by setup-then-teardown
    // on a suite that stored nothing. It must not throw, and it must say zero.
    expect(await emptyBucket(CLEANUP_STORE)).toBe(0);
  });

  /**
   * The reason #111 exists, stated as an assertion rather than a comment.
   * Everything above empties a store; none of it may touch the one the rest
   * of the suite is using.
   */
  it("never touches the store the rest of the suite shares", async () => {
    const theirs = `files/${randomUUID()}`;
    await putObjectBehindTheApi(theirs);

    await emptyBucket(CLEANUP_STORE);

    expect(await objectExists(theirs)).toBe(true);
    expect(CLEANUP_STORE).not.toBe(SHARED_STORE);
  });
});

describe("emptyBucket refuses anything that is not the test store", () => {
  /**
   * The point of these four. `emptyBucket` deletes everything it can reach,
   * and it is called automatically at the start and end of every run — so the
   * day somebody has production's STORAGE_* exported in their shell, the only
   * thing between that and an empty B2 bucket is this guard. `.env.test`
   * winning is a convention; this is the enforcement.
   *
   * Each test changes ONE condition, so a guard that checks only two of the
   * three cannot pass all of them.
   */
  const settings = { ...env };

  afterEach(() => {
    Object.assign(env, settings);
  });

  /**
   * Puts an object with the real settings, THEN breaks one of them, and
   * insists the object is still there afterwards. The client is built once
   * from the environment, so changing `env` steers the guard without moving
   * the store — which is what makes "it refused before deleting anything"
   * checkable at all.
   *
   * The witness object always goes in a bucket that exists, while `target` is
   * what `emptyBucket` is asked to empty and may be a name with nothing behind
   * it. Writing the witness into `target` was the first version, and it failed
   * for the wrong reason: the put itself got `NoSuchBucket` and the guard was
   * never reached, so the test passed nothing and proved nothing.
   */
  async function expectRefused(
    breakOneSetting: () => void,
    target: string = CLEANUP_STORE,
  ) {
    const key = `files/${randomUUID()}`;
    await putObjectBehindTheApi(key, CLEANUP_STORE);

    breakOneSetting();
    await expect(emptyBucket(target)).rejects.toThrow(/Refusing to empty/);

    // Not merely "it threw": a guard that threw halfway through the deleting
    // would also throw. And nothing anywhere else may have gone either.
    Object.assign(env, settings);
    expect(await objectExists(key, CLEANUP_STORE)).toBe(true);
  }

  it("not when NODE_ENV says this is not a test run", async () => {
    await expectRefused(() => {
      env.NODE_ENV = "production";
    });
  });

  it("not when the store is somewhere other than this machine", async () => {
    await expectRefused(() => {
      env.STORAGE_ENDPOINT = "https://s3.eu-central-003.backblazeb2.com";
    });
  });

  /**
   * The guard parses the URL and compares the **hostname**, which is not the
   * same as looking for "localhost" in the string. These three all contain it
   * and none of them is this machine; a substring check would have accepted
   * every one, and the first is a domain anybody can register.
   */
  it.each([
    "https://localhost.example.com",
    "http://127.0.0.1.evil.com",
    "http://evil.example.com/?host=localhost",
  ])("not when the host only looks local: %s", async (endpoint) => {
    await expectRefused(() => {
      env.STORAGE_ENDPOINT = endpoint;
    });
  });

  /**
   * These two are #111's whole point, and they pin it from both sides.
   *
   * With two buckets in play the guard has to judge **the one it is handed**.
   * A guard that went back to reading `env.STORAGE_BUCKET` would approve a
   * perfectly good configured name and then delete from whatever it was
   * actually given — a worse version of the bug the guard exists to prevent,
   * and one that would pass every other test in this file.
   */
  it("not when the bucket it is handed is not a test bucket", async () => {
    // The configured bucket stays perfectly valid throughout. Only the
    // argument is wrong, so only a guard reading the argument refuses.
    expect(env.STORAGE_BUCKET).toMatch(/-test$/);
    await expectRefused(() => undefined, "farhand-files");
  });

  it("and it does not refuse a good bucket because the settings name a bad one", async () => {
    // The mirror image: the configured name is nonsense, the argument is
    // fine. A guard reading the settings would refuse this, and emptying
    // the cleanup store would stop working for a reason nobody could see.
    const key = `files/${randomUUID()}`;
    await putObjectBehindTheApi(key, CLEANUP_STORE);

    env.STORAGE_BUCKET = "farhand-files";
    await emptyBucket(CLEANUP_STORE);

    Object.assign(env, settings);
    expect(await objectExists(key, CLEANUP_STORE)).toBe(false);
  });

  it("but it does empty a real test store", async () => {
    const key = `files/${randomUUID()}`;
    await putObjectBehindTheApi(key, CLEANUP_STORE);

    await emptyBucket(CLEANUP_STORE);

    expect(await objectExists(key, CLEANUP_STORE)).toBe(false);

    // And one object left behind ON PURPOSE, as the last thing this file does
    // to the cleanup store. Without it these tests end with that store empty
    // by coincidence, and then `teardown` emptying it is unobservable — a
    // broken version that forgets the second store passes everything. With
    // it, `npm run test:store-empty` fails. The equivalent of the sentinel
    // `global-setup.ts` writes before emptying, at the other end of the run.
    await putObjectBehindTheApi(
      `files/teardown-sentinel-${randomUUID()}`,
      CLEANUP_STORE,
    );
  });
});

describe("the suite starts with an empty store", () => {
  /**
   * `global-setup.ts` writes one object, empties the store, and provides what
   * was left. Zero means the emptying ran.
   *
   * The written object is the whole point. Without it this test would pass on
   * any machine whose store happened to be empty already — including a fresh
   * clone, including CI, every time — whether or not the setup did anything at
   * all. With it, the count is zero only if something removed it.
   */
  it("and global-setup is what made it empty", () => {
    expect(inject("storeObjectsAfterCleanup")).toBe(0);
  });
});
