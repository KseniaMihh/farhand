# 0011 — Backblaze B2 for uploaded files

## Context

TODO(#79): version 2 opens with uploads (docs/08-scope.md) and `File` has been
in the schema since the first week, metadata only. The bytes need a home. The
constraint from decision 0010 applies: nothing paid, no card on file. What the
API must guarantee regardless of provider: bytes never public, signed URLs
that expire, a size and type limit.

## Decision

TODO(#79): Backblaze B2 — 10 GB free for good, no card, S3-compatible. The
bucket is private; every read is a signed URL valid for five minutes, handed
out by `GET /files/:id` after the API has decided who may see it. Uploads go
through the API, which reads the type from the bytes and enforces the limit
before anything is stored. One file, `src/storage.ts`, knows the provider.

Locally and in CI: S3Proxy in docker-compose.yml — chosen because it checks
signatures, so "never publicly readable" is tested against a store able to
refuse.

## Alternatives considered

TODO(#79):
- Cloudflare R2 — 10 GB free, no egress fees, but a card is required in
  practice to enable it
- Supabase Storage — 1 GB free, no card, but a free project pauses after a
  week without activity, and every image link breaks with it
- Bytes in PostgreSQL — no new vendor, but Neon's free tier is 0.5 GB, and a
  database is the wrong place to serve images from
- Direct-to-storage uploads with presigned PUT URLs — scales better, but the
  API never sees the bytes, so type and size need a confirm step, and an
  unconfirmed upload leaves orphans
- MinIO as the local store — stopped publishing images in 2025

## Consequences

TODO(#79):
- Two places hold files' truth: the row and the bytes. The order (bytes first,
  row second, delete bytes if the row fails) is what keeps a failure on the
  invisible side
- The API does not check that bytes exist before redirecting; a vanished file
  is a 404 from the store, never a 500 from us
- Deleting an account deletes photos and keeps receipts
- B2's free tier has daily limits on API calls; signing a URL is not one of
  them (it is computed locally), but every view is a download — what would
  make a paid plan worth it
