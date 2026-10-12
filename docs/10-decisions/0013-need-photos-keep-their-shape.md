# 0013 — A need's photos keep their shape, and lopsided ones are refused

## Context

#80 settled what happens to an uploaded avatar: rotate it upright, crop it
square from the middle, scale it to 512 px, re-encode as WebP, keep no
metadata. Three of those five steps exist for safety and apply to any image
anybody uploads. The square crop exists because every avatar being the same
shape is worth more than the corners of any one of them.

#81 puts photos on a need, and the crop is the step that does not carry over.
A photo of a need is a photo of a **product**: a tall bottle, a wide box, the
ingredient list on the back. Cropping it square throws away the thing being
asked for, which is the entire content of the picture.

So a need's photo keeps its aspect ratio and only its long edge is capped. That
raises a question the avatar rule never had to answer: what about an image that
is extremely long and thin?

| Upload | Long edge capped at 1280 |
|---|---|
| 4:3 phone photo, 4032 × 3024 | 1280 × 960 |
| Portrait photo of a bottle, 3024 × 4032 | 960 × 1280 |
| Whole phone screen, 1080 × 2340 | 591 × 1280 |
| **Scrolling screenshot, 1080 × 6000** | **230 × 1280** |

The last row is the problem. A scrolling screenshot of an ingredient list or a
shop page is a picture somebody sends *because of the text in it*, and 230 px
wide is text nobody can read. The rule would quietly destroy exactly the
pictures whose purpose is detail.

## Decision

**Keep the shape, cap the long edge at 1280, and refuse anything more than 3
times longer than it is wide** (`MAX_NEED_PHOTO_ASPECT` in
`farhand-api/src/images.ts`), with a message that says to crop it first.

Three to one is wider than anything a camera or a single screen produces — 4:3
is 1.33, 16:9 is 1.78, a whole tall phone screen about 2.17 — so what it turns
away is stitched and scrolling captures, where there is a specific part the
person means and they are the one who knows which. Together with the long-edge
cap it is also a promise about legibility: nothing accepted is ever stored
narrower than 1280 ÷ 3 ≈ 426 px, whatever shape it arrived in.

Also decided here, and both the opposite of the avatar rule for the same
reason: a photo smaller than the cap is **left at its own size** rather than
enlarged into a blur, and the minimum is **200 px on the shorter side** rather
than 64 — a photo is read, not glanced at in a circle.

Everything the avatar rule does for safety is unchanged and shared: the
decompression-bomb limit, rotating upright *before* the metadata that says
which way up is discarded, re-encoding rather than passing bytes through, and
WebP with no metadata at all — which is what removes the GPS position a phone
writes into a photo of somebody's kitchen table.

## Alternatives

**Accept the shrunken screenshot.** One rule, no refusals, and the picture is
still *there* — just unreadable. The upload succeeds and the person finds out
later, or never. A refusal that says why is kinder than a success that silently
fails.

**Scale by the short edge instead for very tall images.** Keeps them readable:
1080 × 6000 would become 640 × 3556. But that is 2.3 megapixels against the
1.2 a 4:3 photo costs — the budget doubled for the rarest kind of upload, and
#102's arithmetic about what a page of images costs undone from the side. It
also means two resize rules, so "how big is a photo" stops having one answer.

**Cap total pixels rather than edges.** Elegant, and it does not solve the
problem: a pixel budget still shrinks 1080 × 6000 to about 470 × 2600, which is
the same unreadable text with harder arithmetic.

**Crop the long screenshot ourselves, to the top.** Guessing which part of a
picture somebody meant, and usually guessing wrong.

## Consequences

- Some uploads are refused that a person believes are photos. The message
  names the reason and the remedy ("crop it to the part you mean first"),
  which is the only thing that makes a refusal acceptable.
- Stored sizes vary by shape rather than being uniform, so storage per need is
  a range (roughly 100–300 KB per photo) and not a constant. Six per need
  keeps the range narrow enough to reason about.
- A client cannot assume a photo's dimensions, the way it can for an avatar.
  It gets `width`/`height`-agnostic paths and has to lay out whatever arrives —
  which is what a product gallery does anyway.
- The two constants are a pair: raising `MAX_NEED_PHOTO_ASPECT` without
  raising `NEED_PHOTO_LONG_EDGE` lowers the narrowest thing that can be
  stored. A test pins that floor (`tests/needs/photos.test.ts`), so the pair
  cannot be separated silently.
- If people turn out to send long screenshots often, the answer is a cropping
  tool in the client, not a looser rule here — the crop has to be made by
  somebody who knows what the picture is for.
