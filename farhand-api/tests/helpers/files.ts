import {
  DeleteObjectCommand,
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

const bucket = required("STORAGE_BUCKET", env.STORAGE_BUCKET);

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
export async function objectExists(key: string): Promise<boolean> {
  try {
    await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  } catch {
    return false;
  }
}

/** Every key in the test bucket. Keys are random, so "did the count change?" */
export async function allKeys(): Promise<string[]> {
  const keys: string[] = [];
  let token: string | undefined;
  do {
    const page = await client.send(
      new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: token }),
    );
    for (const object of page.Contents ?? []) {
      if (object.Key) keys.push(object.Key);
    }
    token = page.NextContinuationToken;
  } while (token);
  return keys;
}

/** Removes bytes behind the API's back — the "bytes vanished" situation. */
export async function deleteObjectBehindTheApi(key: string): Promise<void> {
  await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
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
      Bucket: bucket,
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
