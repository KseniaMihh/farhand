import type { Deal, DealStatus, Need } from "@prisma/client";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/app.js";
import { prisma } from "../../src/db.js";
import { env } from "../../src/env.js";
import { MIN_RECEIPT_SIDE, RECEIPT_LONG_EDGE } from "../../src/images.js";
import { logger } from "../../src/logger.js";
import { RATE_LIMITS } from "../../src/middleware/rate-limit.js";
import { MAX_RECEIPTS_PER_KIND } from "../../src/services/receipts.js";
import { READ_URL_SECONDS } from "../../src/storage.js";
import { storage } from "../../src/storage.js";
import { signUpVerifiedAndLogIn, type TestUser } from "../helpers/auth.js";
import { fileFixture, objectExists, sample } from "../helpers/files.js";
import { withoutRequestId } from "../helpers/http.js";
import {
  describe as describeImage,
  photoWithMetadata,
  SECRET_ARTIST,
  sidewaysPhoto,
  solidImage,
} from "../helpers/images.js";
import { createCategory, createDealFor, needBody } from "../helpers/needs.js";

/**
 * Receipts on a deal (#82).
 *
 *   POST /deals/:id/receipts/product
 *   POST /deals/:id/receipts/shipping
 *
 * and `GET /deals/:id`, which now carries them.
 *
 * This is the most private thing the product stores — a real name, sometimes
 * an address, and what somebody bought — so the tests about who may NOT see
 * one matter as much as the ones about who may. What is checked is what was
 * STORED, downloaded back through the path the API handed out.
 *
 * There is no test for removing a receipt because there is no way to remove
 * one, which is the design and not an omission; "nothing deletes a receipt"
 * below is what holds that in place.
 */

const app = createApp();

let kadri: TestUser; // requester — pays, does not buy
let yuki: TestUser; // helper — buys, and so holds the receipts
let stranger: TestUser;
let moderator: TestUser;
let categoryId: string;

beforeEach(async () => {
  kadri = await signUpVerifiedAndLogIn(app, "kadri@example.com", "Kadri");
  yuki = await signUpVerifiedAndLogIn(app, "yuki@example.com", "Yuki");
  stranger = await signUpVerifiedAndLogIn(app, "sam@example.com", "Sam");
  moderator = await signUpVerifiedAndLogIn(app, "mo@example.com", "Mo");
  await prisma.user.update({
    where: { id: moderator.id },
    data: { role: "MODERATOR" },
  });
  categoryId = (await createCategory()).id;
});

afterEach(() => {
  env.RATE_LIMIT_ENABLED = false;
  vi.restoreAllMocks();
});

interface ReceiptView {
  id: string;
  kind: "product" | "shipping";
  url: string;
  uploadedAt: string;
}
interface ReceiptBody {
  receipt: ReceiptView;
}
interface DealBody {
  deal: { id: string; status: DealStatus; receipts: ReceiptView[] };
}
interface ErrorBody {
  error: { code: string; message: string };
}

/** A need of Kadri's, and a deal on it with Yuki, at `status`. */
async function dealAt(status: DealStatus): Promise<Deal> {
  const created = await request(app)
    .post("/needs")
    .set("Cookie", kadri.cookie)
    .send(await needBody(categoryId));
  expect(created.status).toBe(201);
  const need = (created.body as { need: Need }).need;

  return createDealFor(need, yuki.id, status);
}

function upload(
  dealId: string,
  kind: "product" | "shipping",
  user: TestUser,
  bytes: Buffer,
) {
  return request(app)
    .post(`/deals/${dealId}/receipts/${kind}`)
    .set("Cookie", user.cookie)
    .set("Content-Type", "application/octet-stream")
    .send(bytes);
}

/** A receipt attached by the helper. Fails the test if it is refused. */
async function receipt(
  dealId: string,
  kind: "product" | "shipping" = "product",
  bytes?: Buffer,
): Promise<ReceiptView> {
  const file = bytes ?? (await solidImage(900, 1400));
  const response = await upload(dealId, kind, yuki, file);

  expect(response.status).toBe(201);
  return (response.body as ReceiptBody).receipt;
}

async function dealAsSeenBy(dealId: string, viewer: TestUser) {
  const response = await request(app)
    .get(`/deals/${dealId}`)
    .set("Cookie", viewer.cookie);

  expect(response.status).toBe(200);
  return (response.body as DealBody).deal;
}

/** Follows a receipt's path the way a browser would, and returns the bytes. */
async function download(url: string, viewer: TestUser): Promise<Buffer> {
  const redirect = await request(app).get(url).set("Cookie", viewer.cookie);
  expect(redirect.status).toBe(302);

  const location = redirect.headers.location;
  if (!location) throw new Error("expected a redirect to the signed URL");

  const served = await fetch(location);
  expect(served.status).toBe(200);
  return Buffer.from(await served.arrayBuffer());
}

function receiptRows(dealId: string) {
  return prisma.file.findMany({
    where: { dealId },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
}

/** What `src/services/files.ts` writes when a moderator opens something. */
const MODERATOR_READ = "moderator read a file";

/**
 * Only the moderator-read lines a logger spy recorded.
 *
 * Deliberately not "everything the logger saw, as a string". Two earlier
 * versions of this were wrong in ways worth remembering: `JSON.stringify` of
 * the calls throws, because the request-completion line carries a socket that
 * carries a parser that carries the socket — and even with that fixed, the
 * same line carries the URL, so `/files/<id>` appears in the log of EVERY
 * request to it. "No line mentions this file" can never be true, and a test
 * asking for it is asking the wrong question.
 */
function moderatorReads(spy: {
  mock: { calls: unknown[][] };
}): { moderatorId?: string; fileId?: string; purpose?: string }[] {
  return spy.mock.calls
    .filter((call) => call[1] === MODERATOR_READ)
    .map((call) => call[0] as { moderatorId?: string; fileId?: string });
}

describe("attaching a receipt", () => {
  it("is the helper's to do, once the product money is sent", async () => {
    const deal = await dealAt("PRODUCT_PAID");

    const response = await upload(
      deal.id,
      "product",
      yuki,
      await solidImage(900, 1400),
    );

    expect(response.status).toBe(201);
    const added = (response.body as ReceiptBody).receipt;
    expect(added).toMatchObject({ kind: "product", url: `/files/${added.id}` });

    const [row] = await receiptRows(deal.id);
    expect(row).toMatchObject({
      id: added.id,
      ownerId: yuki.id,
      purpose: "PRODUCT_RECEIPT",
      dealId: deal.id,
      mimeType: "image/webp",
    });
    // Attached to the deal, not to the need: a receipt belongs to the trade,
    // and the need may be closed or removed while the deal runs on.
    expect(row?.needId).toBeNull();
  });

  it("shows on the deal, to both of the people in it", async () => {
    const deal = await dealAt("PRODUCT_PAID");
    const added = await receipt(deal.id);

    for (const viewer of [kadri, yuki]) {
      expect((await dealAsSeenBy(deal.id, viewer)).receipts).toEqual([added]);
    }
  });

  it("and to a moderator, who may have to judge what was paid", async () => {
    const deal = await dealAt("PRODUCT_PAID");
    const added = await receipt(deal.id);

    expect((await dealAsSeenBy(deal.id, moderator)).receipts).toEqual([added]);
  });

  it("carries a shipping receipt only once the item has been bought", async () => {
    const tooEarly = await dealAt("PRODUCT_PAID");
    const image = await solidImage(900, 1400);

    // The postage is paid when the parcel is sent, and the helper is in
    // PURCHASED when they do it (docs/04-deal-lifecycle.md).
    expect((await upload(tooEarly.id, "shipping", yuki, image)).status).toBe(
      409,
    );

    const bought = await dealAt("PURCHASED");
    expect((await upload(bought.id, "shipping", yuki, image)).status).toBe(201);
  });

  it("keeps both kinds on one deal, oldest first", async () => {
    const deal = await dealAt("PURCHASED");

    const first = await receipt(deal.id, "product");
    const second = await receipt(deal.id, "shipping");
    const third = await receipt(deal.id, "product");

    expect((await dealAsSeenBy(deal.id, yuki)).receipts).toEqual([
      first,
      second,
      third,
    ]);
  });
});

describe("what is stored", () => {
  it(`is a WebP no longer than ${String(RECEIPT_LONG_EDGE)} on its long edge`, async () => {
    const deal = await dealAt("PRODUCT_PAID");

    const added = await receipt(
      deal.id,
      "product",
      await solidImage(3000, 2000),
    );

    expect(await describeImage(await download(added.url, yuki))).toMatchObject({
      format: "webp",
      width: RECEIPT_LONG_EDGE,
      height: 1333,
    });
    // Bigger than a need's photo on purpose: a receipt is nothing but small
    // print, and 1280 loses the line items (#82).
    expect(RECEIPT_LONG_EDGE).toBeGreaterThan(1280);
  });

  it("keeps a long thin till roll, which a need's photo would refuse", async () => {
    const deal = await dealAt("PRODUCT_PAID");

    // Six times longer than it is wide. #81 refuses anything past three,
    // because a product photographed that way has been cropped by accident.
    // A receipt really is that shape, so here there is no such rule.
    const added = await receipt(
      deal.id,
      "product",
      await solidImage(600, 3600),
    );

    expect(await describeImage(await download(added.url, yuki))).toMatchObject({
      width: 333,
      height: RECEIPT_LONG_EDGE,
    });
  });

  it("carries no metadata: a receipt is photographed where somebody lives", async () => {
    const deal = await dealAt("PRODUCT_PAID");
    const photo = await photoWithMetadata();
    expect(photo.includes(SECRET_ARTIST)).toBe(true);

    const stored = await download(
      (await receipt(deal.id, "product", photo)).url,
      yuki,
    );

    expect(await describeImage(stored)).toMatchObject({
      hasExif: false,
      hasXmp: false,
    });
    expect(stored.includes(SECRET_ARTIST)).toBe(false);
  });

  it("is turned the right way up before the note saying how is thrown away", async () => {
    const deal = await dealAt("PRODUCT_PAID");

    // Three times the fixture's usual size: a receipt under 300px on its
    // shorter side is refused, and this one is 200 at scale 1.
    const stored = await download(
      (await receipt(deal.id, "product", await sidewaysPhoto(3))).url,
      yuki,
    );

    expect(await describeImage(stored)).toMatchObject({
      width: 600,
      height: 1200,
    });
  });

  it("is a PDF exactly as it arrived, because we cannot safely rewrite one", async () => {
    const deal = await dealAt("PRODUCT_PAID");
    const pdf = sample.pdf(4096);

    const added = await receipt(deal.id, "product", pdf);

    // Byte for byte: no library here can rewrite a PDF, and a receipt emailed
    // by a shop carries no GPS position to strip (#82).
    expect(await download(added.url, yuki)).toEqual(pdf);
    const [row] = await receiptRows(deal.id);
    expect(row?.mimeType).toBe("application/pdf");
  });

  it(`refuses an image under ${String(MIN_RECEIPT_SIDE)}px on its shorter side`, async () => {
    const deal = await dealAt("PRODUCT_PAID");

    const response = await upload(
      deal.id,
      "product",
      yuki,
      await solidImage(MIN_RECEIPT_SIDE - 1, 900),
    );

    expect(response.status).toBe(422);
    expect((response.body as ErrorBody).error.message).toContain(
      String(MIN_RECEIPT_SIDE),
    );
    expect(await receiptRows(deal.id)).toEqual([]);
  });

  it("refuses what is not a receipt at all, and stores nothing", async () => {
    const deal = await dealAt("PRODUCT_PAID");
    const put = vi.spyOn(storage, "put");

    expect((await upload(deal.id, "product", yuki, sample.html())).status).toBe(
      422,
    );
    expect((await upload(deal.id, "product", yuki, sample.gif())).status).toBe(
      422,
    );

    expect(put).not.toHaveBeenCalled();
    expect(await receiptRows(deal.id)).toEqual([]);
  });
});

describe("who may attach one", () => {
  it("not the requester: it is the helper who buys the thing", async () => {
    const deal = await dealAt("PRODUCT_PAID");

    const response = await upload(
      deal.id,
      "product",
      kadri,
      await solidImage(900, 1400),
    );

    // 403 rather than 404: Kadri is in this deal and can read it, so refusing
    // tells them nothing they could not already see.
    expect(response.status).toBe(403);
    expect(await receiptRows(deal.id)).toEqual([]);
  });

  it("not a moderator, who may read a dispute and not add to it", async () => {
    const deal = await dealAt("DISPUTED");

    expect(
      (await upload(deal.id, "product", moderator, await solidImage(900, 1400)))
        .status,
    ).toBe(403);
  });

  it("not a stranger, who cannot even tell the deal exists", async () => {
    const deal = await dealAt("PRODUCT_PAID");
    const image = await solidImage(900, 1400);

    const refused = await upload(deal.id, "product", stranger, image);
    const missing = await upload(
      "cm0doesnotexist000000000",
      "product",
      stranger,
      image,
    );

    // The same answer for "not yours" and "not there", or the id of a deal
    // becomes a thing a stranger can test for.
    expect(refused.status).toBe(404);
    expect(withoutRequestId(refused.body)).toEqual(
      withoutRequestId(missing.body),
    );
  });

  it("not without signing in", async () => {
    const deal = await dealAt("PRODUCT_PAID");

    const response = await request(app)
      .post(`/deals/${deal.id}/receipts/product`)
      .set("Content-Type", "application/octet-stream")
      .send(await solidImage(900, 1400));

    expect(response.status).toBe(401);
  });

  it(`not more than ${String(RATE_LIMITS.receipt.perUser)} uploads an hour`, async () => {
    env.RATE_LIMIT_ENABLED = true;
    const deal = await dealAt("PURCHASED");
    const tiny = await solidImage(MIN_RECEIPT_SIDE, MIN_RECEIPT_SIDE);

    for (let i = 0; i < RATE_LIMITS.receipt.perUser; i++) {
      // Six get in — three of each kind — and the rest are refused by the
      // limit. A refused upload still spends budget: the limiter runs before
      // the handler, as it does for messages and photos.
      const response = await upload(deal.id, "product", yuki, tiny);
      expect([201, 409]).toContain(response.status);
    }

    expect((await upload(deal.id, "shipping", yuki, tiny)).status).toBe(429);
  });
});

describe("the limit of three per kind", () => {
  it("allows three and refuses the fourth, naming the kind", async () => {
    const deal = await dealAt("PRODUCT_PAID");
    for (let i = 0; i < MAX_RECEIPTS_PER_KIND; i++) {
      await receipt(deal.id, "product");
    }

    const fourth = await upload(
      deal.id,
      "product",
      yuki,
      await solidImage(900, 1400),
    );

    expect(fourth.status).toBe(409);
    expect((fourth.body as ErrorBody).error.message).toContain(
      String(MAX_RECEIPTS_PER_KIND),
    );
    expect(await receiptRows(deal.id)).toHaveLength(MAX_RECEIPTS_PER_KIND);
    expect(MAX_RECEIPTS_PER_KIND).toBe(3);
  });

  it("gives each kind its own budget", async () => {
    const deal = await dealAt("PURCHASED");
    for (let i = 0; i < MAX_RECEIPTS_PER_KIND; i++) {
      await receipt(deal.id, "product");
    }

    // A deal with three product receipts and no proof of postage is exactly
    // the shape the per-kind rule exists to prevent.
    expect(
      (await upload(deal.id, "shipping", yuki, await solidImage(900, 1400)))
        .status,
    ).toBe(201);
  });

  it("refuses the fourth before paying to re-encode it", async () => {
    const deal = await dealAt("PRODUCT_PAID");
    for (let i = 0; i < MAX_RECEIPTS_PER_KIND; i++) {
      await receipt(deal.id, "product");
    }
    const put = vi.spyOn(storage, "put");

    expect(
      (await upload(deal.id, "product", yuki, await solidImage(900, 1400)))
        .status,
    ).toBe(409);

    expect(put).not.toHaveBeenCalled();
  });

  it("cannot be beaten by two uploads at the same moment", async () => {
    const deal = await dealAt("PRODUCT_PAID");
    for (let i = 0; i < MAX_RECEIPTS_PER_KIND - 1; i++) {
      await receipt(deal.id, "product");
    }
    const image = await solidImage(900, 1400);
    const { arrived, letGo, put } = holdNextWriteToStore();

    // The first upload is parked at the store, past a count that said two.
    const first = upload(deal.id, "product", yuki, image).then((r) => r);
    await arrived;

    // The second takes the third place while it waits.
    expect((await upload(deal.id, "product", yuki, image)).status).toBe(201);

    letGo();
    const refused = await first;

    expect(refused.status).toBe(409);
    expect(await receiptRows(deal.id)).toHaveLength(MAX_RECEIPTS_PER_KIND);
    const heldKey = put.mock.calls[0]?.[0];
    if (!heldKey) throw new Error("expected the held upload to store bytes");
    expect(await objectExists(heldKey)).toBe(false);
  });

  it("counts inside a lock on the deal, so a second count cannot overlap", async () => {
    const deal = await dealAt("PRODUCT_PAID");
    const image = await solidImage(900, 1400);
    let settled = false;
    let inFlight: Promise<{ status: number }> | undefined;

    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM "Deal" WHERE id = ${deal.id} FOR UPDATE`;

      inFlight = upload(deal.id, "product", yuki, image).then((response) => {
        settled = true;
        return response;
      });

      await waitForABackendBlockedOnTheDeal(() => settled);
    });

    expect((await inFlight)?.status).toBe(201);
  });
});

/**
 * Holds the next write to the store until the test lets it go.
 *
 * The same arrangement as #81's photo limit, and for the same reason: two real
 * requests fired together do not reliably overlap, so the overlap is staged —
 * one upload is stopped in the one place a second can get past it.
 */
function holdNextWriteToStore() {
  let letGo!: () => void;
  let itArrived!: () => void;
  const held = new Promise<void>((resolve) => (letGo = resolve));
  const arrived = new Promise<void>((resolve) => (itArrived = resolve));

  const real = storage.put.bind(storage);
  const put = vi.spyOn(storage, "put");
  put.mockImplementationOnce(async (key, bytes, contentType) => {
    itArrived();
    await held;
    return real(key, bytes, contentType);
  });

  return { arrived, letGo, put };
}

/**
 * Waits until Postgres says a connection is blocked on a lock against a Deal,
 * and fails the moment it is clear none ever will be.
 *
 * A clock cannot tell "blocked" from "slow"; `pg_stat_activity` can. #81's
 * first attempt at this waited 400ms and would have passed on a CI runner
 * with the lock removed.
 */
async function waitForABackendBlockedOnTheDeal(
  finishedWithoutWaiting: () => boolean,
  timeoutMs = 3000,
): Promise<void> {
  const until = Date.now() + timeoutMs;

  for (;;) {
    if (finishedWithoutWaiting()) {
      throw new Error(
        "the upload finished while this transaction held the deal's row: " +
          "nothing locked it, so counting and inserting are not one step",
      );
    }

    const [waiting] = await prisma.$queryRaw<{ blocked: bigint }[]>`
      SELECT count(*) AS blocked FROM pg_stat_activity
      WHERE datname = current_database()
        AND wait_event_type = 'Lock'
        AND query ILIKE '%"Deal"%FOR UPDATE%'`;

    if (Number(waiting?.blocked ?? 0) > 0) return;

    if (Date.now() > until) {
      throw new Error("no connection ever waited for a lock on the deal");
    }

    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe("when the deal is over, or frozen", () => {
  describe.each<DealStatus>(["COMPLETED", "CANCELLED"])(
    "a %s deal",
    (status) => {
      it("takes no more receipts, of either kind", async () => {
        const deal = await dealAt(status);
        const image = await solidImage(900, 1400);

        expect((await upload(deal.id, "product", yuki, image)).status).toBe(
          409,
        );
        expect((await upload(deal.id, "shipping", yuki, image)).status).toBe(
          409,
        );
      });
    },
  );

  it("a disputed deal still takes evidence, which is when it matters most", async () => {
    const deal = await dealAt("DISPUTED");
    const image = await solidImage(900, 1400);

    expect((await upload(deal.id, "product", yuki, image)).status).toBe(201);
    expect((await upload(deal.id, "shipping", yuki, image)).status).toBe(201);
  });

  it("is refused before the money is sent at all", async () => {
    for (const status of ["MATCHED", "QUOTE_AGREED"] satisfies DealStatus[]) {
      const deal = await dealAt(status);

      expect(
        (await upload(deal.id, "product", yuki, await solidImage(900, 1400)))
          .status,
      ).toBe(409);
    }
  });
});

describe("reading one", () => {
  it("is refused to a stranger exactly as a file that never existed is", async () => {
    const deal = await dealAt("PRODUCT_PAID");
    const added = await receipt(deal.id);

    const refused = await request(app)
      .get(added.url)
      .set("Cookie", stranger.cookie);
    const missing = await request(app)
      .get("/files/cm0doesnotexist000000000")
      .set("Cookie", stranger.cookie);

    expect(refused.status).toBe(404);
    expect(withoutRequestId(refused.body)).toEqual(
      withoutRequestId(missing.body),
    );
  });

  it("hands out a link that stops working, and says how soon", async () => {
    const deal = await dealAt("PRODUCT_PAID");
    const added = await receipt(deal.id);

    const redirect = await request(app)
      .get(added.url)
      .set("Cookie", yuki.cookie);
    const location = new URL(redirect.headers.location ?? "");

    // Forwarding the address in a chat does not hand somebody a receipt: it
    // hands them five minutes of one.
    expect(location.searchParams.get("X-Amz-Expires")).toBe(
      String(READ_URL_SECONDS),
    );
    expect(READ_URL_SECONDS).toBe(300);
  });

  it("writes a line when a moderator reads one", async () => {
    const deal = await dealAt("PRODUCT_PAID");
    const added = await receipt(deal.id);
    const written = vi.spyOn(logger, "info");

    expect(
      (await request(app).get(added.url).set("Cookie", moderator.cookie))
        .status,
    ).toBe(302);

    // Reading is not a decision, so it writes no AdminAction — but a power
    // that leaves no trace at all is one nobody can ask about afterwards
    // (services/deals.ts, #27).
    expect(moderatorReads(written)).toEqual([
      expect.objectContaining({
        moderatorId: moderator.id,
        fileId: added.id,
        purpose: "PRODUCT_RECEIPT",
      }),
    ]);
  });

  it("writes nothing when the deal's own people read it", async () => {
    const deal = await dealAt("PRODUCT_PAID");
    const added = await receipt(deal.id);
    const written = vi.spyOn(logger, "info");

    for (const viewer of [kadri, yuki]) {
      await request(app).get(added.url).set("Cookie", viewer.cookie);
    }

    // It is their deal. Logging them would be surveillance of the people the
    // feature is for.
    expect(moderatorReads(written)).toEqual([]);
  });

  it("writes a line for a need's photo too, which #81 did not", async () => {
    const need = await prisma.need.create({
      data: {
        requesterId: kadri.id,
        categoryId,
        title: "Japanese sunscreen",
        description: "The one not sold in Europe",
        buyCountry: "JP",
        deliverCountry: "EE",
        currency: "EUR",
        estimatedPrice: 2400,
        status: "REMOVED",
      },
    });
    const photo = await fileFixture({
      ownerId: kadri.id,
      purpose: "NEED_PHOTO",
      needId: need.id,
    });
    const written = vi.spyOn(logger, "info");

    expect(
      (
        await request(app)
          .get(`/files/${photo.id}`)
          .set("Cookie", moderator.cookie)
      ).status,
    ).toBe(302);

    // #81 gave moderators this access and recorded nothing. The argument for
    // logging a receipt read is the argument for logging this one.
    expect(moderatorReads(written)).toEqual([
      expect.objectContaining({ fileId: photo.id, purpose: "NEED_PHOTO" }),
    ]);
  });
});

describe("nothing deletes a receipt", () => {
  it("there is no endpoint for it, deliberately", async () => {
    const deal = await dealAt("PRODUCT_PAID");
    const added = await receipt(deal.id);

    const response = await request(app)
      .delete(`/deals/${deal.id}/receipts/${added.id}`)
      .set("Cookie", yuki.cookie);

    // A receipt is evidence in somebody else's dispute. The person who
    // uploaded it may not take it back, so the route does not exist — and
    // this test is what will notice the day somebody adds one.
    expect(response.status).toBe(404);
    expect(await receiptRows(deal.id)).toHaveLength(1);
  });
});
