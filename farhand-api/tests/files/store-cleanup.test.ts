import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, inject, it } from "vitest";
import { env } from "../../src/env.js";
import {
  emptyBucket,
  objectExists,
  putObjectBehindTheApi,
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
 */

describe("emptyBucket", () => {
  it("removes what is there and says how much it removed", async () => {
    const first = `files/${randomUUID()}`;
    const second = `files/${randomUUID()}`;
    for (const key of [first, second]) await putObjectBehindTheApi(key);

    expect(await objectExists(first)).toBe(true);
    expect(await objectExists(second)).toBe(true);

    const removed = await emptyBucket();

    expect(removed).toBeGreaterThanOrEqual(2);
    expect(await objectExists(first)).toBe(false);
    expect(await objectExists(second)).toBe(false);
  });

  it("is happy to run against a store that is already empty", async () => {
    await emptyBucket();

    // Called twice in a row by anybody debugging, and by setup-then-teardown
    // on a suite that stored nothing. It must not throw, and it must say zero.
    expect(await emptyBucket()).toBe(0);
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
   */
  async function expectRefused(breakOneSetting: () => void) {
    const key = `files/${randomUUID()}`;
    await putObjectBehindTheApi(key);

    breakOneSetting();
    await expect(emptyBucket()).rejects.toThrow(/Refusing to empty/);

    // Not merely "it threw": a guard that threw halfway through the deleting
    // would also throw.
    Object.assign(env, settings);
    expect(await objectExists(key)).toBe(true);
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

  it("not when the bucket is not named like a test bucket", async () => {
    await expectRefused(() => {
      env.STORAGE_BUCKET = "farhand-files";
    });
  });

  it("but it does empty the real test store", async () => {
    const key = `files/${randomUUID()}`;
    await putObjectBehindTheApi(key);

    await emptyBucket();

    expect(await objectExists(key)).toBe(false);
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
