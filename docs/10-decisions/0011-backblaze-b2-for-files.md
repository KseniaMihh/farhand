# 0011 — Backblaze B2 for uploaded files

## Context

Version 2 opens with uploads (`08-scope.md`): avatars, photos on a need,
receipts in a deal. `File` has been in the schema since the first week —
metadata only, the bytes "in object storage" — and nothing wrote to it. #79
had to pick the storage, and the rule from decision 0010 applies to it as to
the hosting: nothing paid, and no card on file anywhere.

What the API must guarantee does not depend on the provider, and was settled
first:

- The bytes are never publicly readable. A file is reached through a signed
  URL that expires, handed out only after the API has decided who may see it.
- A size limit and an allowed-type list, refused with `422` before anything is
  stored.
- A failed upload leaves no row, and a row whose bytes vanish is not a crash.

## Decision

**Backblaze B2.** 10 GB free with no expiry and no card, and it speaks the S3
protocol, so the code is written against S3 and B2 is five settings
(`STORAGE_*`), not a dependency. One file, `src/storage.ts`, knows the
protocol at all — the same seam `src/observability.ts` is for Sentry.

- **The bucket is private.** Every read is `GET /files/:id`: the API checks
  who may see the file, then answers `302` to a signed URL valid for five
  minutes. Signing is computed locally, so it costs no request to B2.
- **Uploads go through the API.** It reads the type from the file's first
  bytes, not from its name or the `Content-Type` it claims, and refuses
  anything over 5 MB before storing a byte. At that size the API's 512 MB
  machine is not troubled by holding one in memory.
- **Bytes first, row second.** If the row cannot be written, the bytes are
  deleted again. A row without bytes would be a broken file people can see;
  bytes without a row are invisible.
- **Deleting an account deletes its photos and keeps its receipts.** A receipt
  is evidence in a deal the other person is part of.

Locally and in CI the store is **S3Proxy**, a container in
`docker-compose.yml`. It was chosen over the alternatives because it checks
signatures: an unsigned read, an expired link and a tampered one are all
refused with `403`. The test that says "bytes are never publicly readable" is
therefore run against something able to say no.

## Alternatives considered

**Cloudflare R2.** 10 GB free and no charge for downloads at all — but in
practice R2 asks for a card before it can be enabled, which is the one thing
this decision exists to avoid.

**Supabase Storage.** 1 GB free and no card. But a free Supabase project is
paused after a week without activity, and every image on the site would break
with it. A demo nobody visits for a week is exactly this project.

**Bytes in PostgreSQL.** No new vendor at all. But Neon's free tier is 0.5 GB,
which a few hundred phone photos would fill, and serving images out of the
database puts every image view on the connection pool the API needs for
everything else.

**Direct uploads to storage**, with a presigned upload URL per file. It scales
better, because the bytes never pass through the API. But then the API never
sees them: checking the type and size needs a third step after the upload,
and an upload whose third step never comes leaves bytes nobody owns. Through
the API, every rule is enforced in one place, in one request.

**MinIO as the local store.** The usual choice, until MinIO stopped publishing
its free images in 2025.

## Consequences

- Two things hold the truth about a file, the row and the bytes, and they can
  disagree. The order of writes keeps every failure on the invisible side, and
  the API never checks the bytes before redirecting: a vanished file is a
  `404` from the store, never a `500` from us.
- Every file read is a redirect. `<img src="/files/…">` follows it without the
  page knowing, but anything that caches the redirect would outlive the
  signature in it, so it is sent `no-store`.
- B2 charges nothing for requests, but data sent out is free only up to three
  times what is stored, then $0.01 per GB. It is not documented what happens
  on an account with no card. So the B2 account has its **spending cap set to
  $0** (`14-deployment.md`): the worst case is images failing to load until
  the next month, never a bill.
- What would justify paying: real users looking at real photos. A busy
  listings page is many image views per visit, and that is the moment to
  measure egress, put a CDN in front, or both.
