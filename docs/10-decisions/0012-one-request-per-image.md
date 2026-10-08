# 0012 — `GET /files/:id` stays the way to read a file

## Context

Decision 0011 made every file reachable through one endpoint: the API decides
who may see it, then answers `302` to a signed URL that lasts five minutes.
That is one API request and one B2 request **per image, per view**.

#100 noticed what that costs on a page made of images, and #102 measured it
(`farhand-api/tests/files/cost.test.ts`). For a need with thirty photos — the
page #81 and #93 will build:

| | Measured |
|---|---|
| API requests | 30 |
| Database statements | 120, four per image |
| B2 requests | 30 |
| Share of the global 300-a-minute ceiling | 10% per page view |
| Page views before a `429` | **10** |

The four statements per image were not intended by anybody. `fileReadUrl`
loaded `owner`, `need` and `deal` in one `include`, which Prisma issues as
three separate sequential SELECTs — and a file is an avatar *or* a need photo
*or* a receipt, so three of the four were for rows the rule would never read.

The `429` is the sharp edge: a limit written for "a person clicking links"
applied to an endpoint called once per image, so a visitor's own photos could
refuse to load.

The question behind all of it: **is the indirection worth keeping?** The fast
answer is to make the bytes public and put a CDN in front, and then none of
the above is a cost at all.

## Decision

**Keep it.** The API stays the only way to reach a file, and the cost of one
request per image is accepted rather than designed away. Three things reduce
it, none of which changes who may read what:

- **One relation, not three.** The row is read first, and then only the
  relation its `purpose` makes relevant — `owner` for an avatar, `need` for a
  photo, `deal` for a receipt. Two statements instead of four. A `NEED_PHOTO`
  with no `needId`, or a receipt with no `dealId`, is refused without a second
  statement at all: it belongs to nobody.
- **Its own rate limit.** `RATE_LIMITS.file`, 600 a minute per address, and
  the global ceiling steps around this one path. Still a ceiling — twenty
  thirty-image page views a minute, which no person reaches — but shaped for
  an endpoint counted per image rather than per click.
- **A redirect the browser may keep for a minute.** `private, max-age=60`
  against a signature that lasts five. One person's avatar on twenty cards is
  one request rather than twenty.

**This supersedes one consequence of decision 0011**, which said the redirect
"would outlive the signature in it, so it is sent `no-store`". The reasoning
was right and the conclusion was stronger than the reasoning required: the
cached copy carries *that same signature*, so reusing it for less time than
the signature lasts cannot reach past an expiry it already has. The exposure
window is the signature's life either way. `REDIRECT_CACHE_SECONDS` is kept
next to `READ_URL_SECONDS` in `src/storage.ts` and a test pins
`REDIRECT_CACHE_SECONDS * 2 <= READ_URL_SECONDS`, so the invariant is enforced
rather than remembered.

**What a response contains is still a path.** `avatarUrl` is `/files/cm1f…`,
not a signed URL, for the reason #80 gave: a signed URL dies in five minutes
and anything that stored one would die with it. That stays true.

## What #81 and #93 have to decide

One API request per image remains, and exactly one thing removes it: **a list
response that carries its own signed links**, so a page of thirty images
arrives with thirty URLs already in it and makes no further calls. Signing is
local arithmetic; thirty of them cost nothing.

#102 did not build it, because **no list response carries an image today** —
`avatarUrl` is returned by the three profile endpoints and nowhere else, so it
would have been built for a caller that does not exist. The issue that creates
the caller should build it, and these are the constraints it inherits:

- A signed URL in a response makes that response **good for five minutes**. A
  tab left open and then scrolled shows broken images unless the client
  refetches the list or the field is accompanied by the path it can fall back
  to.
- It must be an **addition**, not a replacement. The path is what a client may
  store; the signed URL is what it may use now.
- It does not widen anything. A URL handed out at `t` works until
  `t + 300` whether it came from `/files/:id` or from a list, which is the
  window decision 0011 already accepted.

## Alternatives rejected

**Public bytes behind a CDN.** The fastest, and a different privacy model
rather than a faster version of this one. A banned account's avatar has to
answer `404` and a suspended account's must not; public bytes cannot enforce
either unless they are deleted on ban, which means a moderation action now
destroys data irreversibly. Receipts could never be public at all, so the
project would hold two kinds of file with two sets of rules.

**Signed URLs in place of paths.** Removes the API hop everywhere, and breaks
the moment anything stores a response — a client cache, a saved draft, a test
fixture. The five-minute signature is a property of the link, and a link with
a property that short should not be the one with a name.

**Taking `/files/:id` out of rate limiting entirely.** It is cheap, not free:
two statements and a signature per call. Nothing here is allowed to be
unlimited, so it got a bigger budget rather than none.

**Letting it stay in the global ceiling and raising that instead.** Raising
300 to 600 for every endpoint gives the same relief to password guessing and
message flooding, which is the opposite of what those numbers are for.

## Consequences

- There are now two reasons a request can be refused `429`, and which limit
  bit is visible in `RateLimit-Policy`. A client seeing it on `/files/:id` is
  loading images faster than any person does.
- The global ceiling has an exception, which is a thing that can rot: a second
  route under `/files/` would join the file budget without deciding to. The
  predicate `isFileRead` names the prefix it matches and the test for it names
  the path, so the next route there has to look.
- A file's visibility rule is three independent branches that each load their
  own row. Adding a fourth `FilePurpose` means adding a branch — and the
  `switch` is exhaustive, so TypeScript refuses to compile until somebody
  does.
- B2 egress is unchanged: the bytes are fetched either way. The free allowance
  is three times what is stored, with the spending cap at `$0`, and the
  trigger for revisiting that is still real users looking at real photos
  (`11-risks.md`).
