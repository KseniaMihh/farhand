import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { env } from "./env.js";

/**
 * Where the bytes of uploaded files live.
 *
 * ONE FILE KNOWS ABOUT S3, for the same reason one file knows about Sentry
 * (src/observability.ts): a service that imports a vendor's SDK cannot be
 * tested without mocking it, and a project that names its provider in ten
 * files will never change it. Backblaze B2 in production and S3Proxy locally
 * both speak the S3 protocol, so the difference between them is five settings
 * and no code (docs/10-decisions/0011-backblaze-b2-for-files.md).
 *
 * The bucket is PRIVATE. Nothing here ever makes an object public: the only
 * way to read one is a signed URL from `signedReadUrl`, which expires.
 *
 * Everything is a method on one exported object rather than separate
 * functions, so a test can make exactly one operation fail with
 * `vi.spyOn(storage, "put")` — which is how "an upload that fails leaves no
 * row" is proved without a broken network.
 */

/** How long a signed read URL works. Long enough to load an image, no more. */
export const READ_URL_SECONDS = 300;

let client: S3Client | undefined;

function configured() {
  const {
    STORAGE_ENDPOINT: endpoint,
    STORAGE_REGION: region,
    STORAGE_BUCKET: bucket,
    STORAGE_ACCESS_KEY_ID: accessKeyId,
    STORAGE_SECRET_ACCESS_KEY: secretAccessKey,
  } = env;

  if (!endpoint || !region || !bucket || !accessKeyId || !secretAccessKey) {
    // Not an HttpError: an upload reaching a server with no storage is our
    // misconfiguration, not the caller's mistake, so it is a 500 and reported.
    throw new Error("File storage is not configured (STORAGE_* variables)");
  }

  client ??= new S3Client({
    endpoint,
    region,
    credentials: { accessKeyId, secretAccessKey },
    // Path-style addressing (`endpoint/bucket/key`). S3Proxy needs it, B2
    // accepts it, and it keeps the bucket name out of DNS.
    forcePathStyle: true,
  });

  return { client, bucket };
}

export const storage = {
  /** Stores bytes under `key`. Overwrites silently; keys are never reused. */
  async put(key: string, bytes: Buffer, contentType: string): Promise<void> {
    const { client, bucket } = configured();
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: bytes,
        ContentType: contentType,
        ContentLength: bytes.length,
      }),
    );
  },

  /**
   * Removes bytes. Deleting a key that is already gone succeeds — S3 says so,
   * and it is what lets a half-finished cleanup simply be run again.
   */
  async delete(key: string): Promise<void> {
    const { client, bucket } = configured();
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  },

  /**
   * A URL that reads one object and stops working after READ_URL_SECONDS.
   *
   * Computed locally — no request to the store — so it does not know whether
   * the bytes still exist. A URL for vanished bytes is still a URL; the store
   * answers it with 404. That is the "row whose bytes vanish is not a crash"
   * half of #79.
   */
  async signedReadUrl(key: string): Promise<string> {
    const { client, bucket } = configured();
    return getSignedUrl(
      client,
      new GetObjectCommand({ Bucket: bucket, Key: key }),
      { expiresIn: READ_URL_SECONDS },
    );
  },

  /**
   * Creates the bucket if it is not there. For local development and the test
   * suite, where the store starts empty; production's bucket is made once, by
   * hand, private (docs/14-deployment.md).
   */
  async ensureBucket(): Promise<void> {
    const { client, bucket } = configured();
    try {
      await client.send(new HeadBucketCommand({ Bucket: bucket }));
    } catch {
      await client.send(new CreateBucketCommand({ Bucket: bucket }));
    }
  },
};
