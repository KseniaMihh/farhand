import {
  CreateBucketCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import type { FilePurpose } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { prisma } from "../../src/db.js";
import { env } from "../../src/env.js";

/**
 * Fixtures for file tests, and a second way into the store.
 *
 * The helpers here talk to the local S3 store directly, with their own client,
 * rather than through src/storage.ts. That is deliberate: a test asking "are
 * the bytes really gone?" through the module under test is asking the module
 * to mark its own homework. This is the independent witness.
 */

function required(name: string, value: string | undefined): string {
  if (!value) {
    throw new Error(
      `${name} is not set — .env.test should name the local store`,
    );
  }
  return value;
}

const client = new S3Client({
  endpoint: required("STORAGE_ENDPOINT", env.STORAGE_ENDPOINT),
  region: required("STORAGE_REGION", env.STORAGE_REGION),
  credentials: {
    accessKeyId: required("STORAGE_ACCESS_KEY_ID", env.STORAGE_ACCESS_KEY_ID),
    secretAccessKey: required(
      "STORAGE_SECRET_ACCESS_KEY",
      env.STORAGE_SECRET_ACCESS_KEY,
    ),
  },
  forcePathStyle: true,
});

/**
 * The store the application uses, and the one almost every test means.
 */
export const SHARED_STORE = required("STORAGE_BUCKET", env.STORAGE_BUCKET);

/**
 * A second store, for the tests that prove emptying works (#111).
 *
 * Those tests empty a bucket, because that is the thing they are testing. On
 * the shared one that meant every test file ordered after them started from an
 * empty store — harmless, since #109 left every test asserting on keys it
 * created itself, and exactly the kind of coupling that is free to remove
 * while nothing relies on it.
 *
 * It also cost real time once already: #109 seeded 6,000 objects to recreate
 * #110's conditions, ran the suite, and found 434 — these tests had emptied
 * the lot. That produced a `KEEP_TEST_STORE` flag which was rightly thrown
 * away. With a second bucket, nobody needs the flag.
 *
 * Derived rather than configured, so there is no second thing to set in
 * `.env.test`, and the `-test` suffix the guard insists on survives:
 * `farhand-test` becomes `farhand-cleanup-test`.
 */
export const CLEANUP_STORE = `${SHARED_STORE.replace(/-test$/, "")}-cleanup-test`;

/** Real leading bytes of each type, padded to `size`. Enough to sniff. */
function withHeader(header: number[], size: number): Buffer {
  const bytes = Buffer.alloc(Math.max(size, header.length + 16), 0x20);
  Buffer.from(header).copy(bytes);
  return bytes;
}

export const sample = {
  jpeg: (size = 2048) => withHeader([0xff, 0xd8, 0xff, 0xe0], size),
  png: (size = 2048) =>
    withHeader([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], size),
  webp: (size = 2048) =>
    withHeader(
      [0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50],
      size,
    ),
  pdf: (size = 2048) => withHeader([...Buffer.from("%PDF-1.7\n")], size),
  gif: (size = 2048) => withHeader([...Buffer.from("GIF89a")], size),
  /** An HTML page. What somebody renames to `cat.png` and hopes. */
  html: () => Buffer.from("<!doctype html><script>alert(1)</script>"),
};

/** Does an object exist under this key, according to the store itself? */
export async function objectExists(
  key: string,
  store: string = SHARED_STORE,
): Promise<boolean> {
  try {
    await client.send(new HeadObjectCommand({ Bucket: store, Key: key }));
    return true;
  } catch {
    return false;
  }
}

/**
 * Every key in the test bucket.
 *
 * NOT exported any more, and not for tests to assert on (#109). It used to be,
 * and four tests compared the whole listing before and after — which made them
 * cost more every time anybody ran the suite, because nothing emptied the
 * store between runs. At 14,489 leftover objects five of them crossed Vitest's
 * five-second limit; at 5,690 one listing takes 563 ms and each of those tests
 * did two.
 *
 * A test should name the key it cares about (`objectExists`), and the ones
 * that did not now do. This stays only for `emptyBucket` below, which has to
 * list the bucket by definition and runs twice a run rather than twice a test.
 */
async function allKeys(store: string = SHARED_STORE): Promise<string[]> {
  const keys: string[] = [];
  let token: string | undefined;
  do {
    const page = await client.send(
      new ListObjectsV2Command({ Bucket: store, ContinuationToken: token }),
    );
    for (const object of page.Contents ?? []) {
      if (object.Key) keys.push(object.Key);
    }
    token = page.NextContinuationToken;
  } while (token);
  return keys;
}

/**
 * Removes every object in the test bucket, and says how many there were.
 *
 * TODO(#109): the database is truncated before every test and the store never
 * was, so every file test ever run left its bytes behind. This is the other
 * half of that: `tests/setup/global-setup.ts` calls it at the start of a run
 * and again at the end, so a run begins clean and leaves the store as it found
 * it.
 *
 * Deliberately NOT per test: a list-and-delete for each of 774 tests would
 * cost far more than it saves, and no test needs an empty store — they need
 * their own keys to behave, which is a different thing.
 */
/**
 * Refuses to empty anything that is not obviously the local test store.
 *
 * `emptyBucket` deletes every object it can reach, so it gets what
 * `tests/setup/truncate.ts` gives the database: several conditions, **all** of
 * which must hold, so that no single stale environment variable is enough. A
 * copy of production's `STORAGE_*` in somebody's shell must not be able to
 * empty the real B2 bucket, and `.env.test` winning is a convention rather
 * than a guarantee (#109).
 *
 * Read from `env` at call time rather than from the module-level constants, so
 * each condition can be proved by a test that changes one of them.
 */
function assertTestStore(name: string): void {
  // The name being acted on is an ARGUMENT, not `env.STORAGE_BUCKET`, and
  // that is the point of #111: with two buckets in play, a guard reading the
  // configured one would approve `farhand-test` and then delete from whatever
  // it was actually handed. The other two conditions still come from `env`,
  // because there is only ever one endpoint and one NODE_ENV.
  const endpoint = env.STORAGE_ENDPOINT ?? "";
  const host = URL.canParse(endpoint) ? new URL(endpoint).hostname : "";
  const isLocal =
    host === "localhost" || host === "127.0.0.1" || host === "[::1]";

  if (env.NODE_ENV !== "test" || !isLocal || !name.endsWith("-test")) {
    throw new Error(
      `Refusing to empty the file store: NODE_ENV is "${env.NODE_ENV}", the ` +
        `endpoint is "${endpoint}" and the bucket is "${name}". This only ` +
        `runs with NODE_ENV=test, against a store on localhost, in a bucket ` +
        `whose name ends in "-test". Check .env.test.`,
    );
  }
}

/**
 * Creates a bucket if it is not there.
 *
 * `src/storage.ts` has an `ensureBucket` of its own, and it only knows the
 * configured bucket. The cleanup store is not configured anywhere — it is
 * derived — so the independent witness has to be able to make it too (#111).
 *
 * Guarded like the rest: this one creates rather than destroys, but a bucket
 * conjured on somebody's real storage account is still litter on a service
 * the rule here says we never pay for.
 */
export async function ensureBucket(name: string): Promise<void> {
  assertTestStore(name);

  try {
    await client.send(new HeadBucketCommand({ Bucket: name }));
  } catch {
    await client.send(new CreateBucketCommand({ Bucket: name }));
  }
}

export async function emptyBucket(
  store: string = SHARED_STORE,
): Promise<number> {
  assertTestStore(store);

  let removed = 0;

  // Listed and deleted in turn rather than listing everything first: the
  // bucket can hold tens of thousands of objects by the time anybody notices,
  // and a delete request takes at most 1000 keys anyway.
  for (;;) {
    const page = await client.send(
      new ListObjectsV2Command({ Bucket: store, MaxKeys: 1000 }),
    );
    const objects = (page.Contents ?? [])
      .map((object) => object.Key)
      .filter((key): key is string => key !== undefined)
      .map((Key) => ({ Key }));

    if (objects.length === 0) return removed;

    await client.send(
      new DeleteObjectsCommand({
        Bucket: store,
        Delete: { Objects: objects, Quiet: true },
      }),
    );
    removed += objects.length;
  }
}

/**
 * How many objects the bucket holds. For `tests/setup/global-setup.ts` only:
 * a test that wants to know about one object should ask about that object
 * with `objectExists`, which is the whole point of #109.
 */
export async function countObjects(
  store: string = SHARED_STORE,
): Promise<number> {
  return (await allKeys(store)).length;
}

/**
 * Fills the bucket with `count` small objects, for #110.
 *
 * The suite now starts empty, which is the point of #109 — and it also means
 * the condition the five-second stall was last seen under (a bucket with
 * thousands of objects in it) no longer happens by accident. So it has to be
 * possible on purpose. How #110 uses it is in `tests/fill-store.ts`: fill from
 * here, run the suite from a worktree on the commit before #109. There is no
 * flag to switch the cleanup off, deliberately.
 *
 * Guarded like `emptyBucket`. This one does not destroy anything, but a few
 * thousand objects written to a real bucket is still somebody's egress bill
 * and the rule here is that nothing costs money.
 */
export async function fillBucket(
  count: number,
  store: string = SHARED_STORE,
): Promise<number> {
  assertTestStore(store);

  const bytes = sample.png(512);
  const batch = 100;
  let written = 0;

  while (written < count) {
    const size = Math.min(batch, count - written);
    await Promise.all(
      Array.from({ length: size }, async () => {
        await client.send(
          new PutObjectCommand({
            Bucket: store,
            Key: `files/fill-${randomUUID()}`,
            Body: bytes,
            ContentType: "image/png",
          }),
        );
      }),
    );
    written += size;
  }

  return written;
}

/** Puts bytes under a key without going near the API. The other witness. */
export async function putObjectBehindTheApi(
  key: string,
  store: string = SHARED_STORE,
): Promise<void> {
  await client.send(
    new PutObjectCommand({
      Bucket: store,
      Key: key,
      Body: sample.png(),
      ContentType: "image/png",
    }),
  );
}

/** Removes bytes behind the API's back — the "bytes vanished" situation. */
export async function deleteObjectBehindTheApi(key: string): Promise<void> {
  // No store argument on purpose: this removes bytes the API wrote, and the
  // API only ever writes to the shared store.
  await client.send(
    new DeleteObjectCommand({ Bucket: SHARED_STORE, Key: key }),
  );
}

/**
 * A stored file, made WITHOUT storeFile: bytes put straight into the store and
 * a row written straight into the database. So the tests of reading a file do
 * not depend on the code that writes one being right — each half of #79 is
 * tested on its own.
 */
export async function fileFixture(input: {
  ownerId: string;
  purpose: FilePurpose;
  needId?: string;
  dealId?: string;
  bytes?: Buffer;
}) {
  const bytes = input.bytes ?? sample.png();
  const storageKey = `files/fixture-${randomUUID()}`;

  await client.send(
    new PutObjectCommand({
      // The shared store, always: this writes a row the API will read, and the
      // API knows only one bucket.
      Bucket: SHARED_STORE,
      Key: storageKey,
      Body: bytes,
      ContentType: "image/png",
    }),
  );

  return prisma.file.create({
    data: {
      ownerId: input.ownerId,
      purpose: input.purpose,
      storageKey,
      mimeType: "image/png",
      sizeBytes: bytes.length,
      needId: input.needId ?? null,
      dealId: input.dealId ?? null,
    },
  });
}
