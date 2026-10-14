import type {
  DealStatus,
  File,
  FilePurpose,
  Prisma,
  User,
} from "@prisma/client";
import { prisma } from "../db.js";
import { HttpError } from "../errors.js";
import { normaliseReceipt } from "../images.js";
import { storage } from "../storage.js";
import { sideOf } from "./deals.js";
import { checkUpload, filePath, storeBytes, storeFileRow } from "./files.js";

/**
 * Receipts on a deal (#82).
 *
 * The most privacy-sensitive thing this product stores: a receipt carries a
 * real name, sometimes an address, and exactly what somebody bought. #79 built
 * the rule that keeps it private — the two people in the deal, and moderators,
 * and nobody else gets the same `404` as for a file that never existed. This
 * is the half that puts one there.
 *
 * It is NOT the need-photo code with different words. Three things differ, and
 * each is deliberate:
 *
 *   a receipt may be a PDF    so it is not always an image to be re-encoded
 *   a receipt is evidence     so nobody may delete one, including its owner
 *   a receipt has two kinds   what was bought, and what the postage cost
 *
 * Contract: docs/06-api-contract.md, "Deals". Who may see one:
 * docs/02-roles-and-permissions.md.
 */

/**
 * How many of each kind one deal may carry.
 *
 * Three rather than one because a purchase is not always one piece of paper: a
 * two-shop errand, or a till roll too long to photograph in a single frame.
 * Three rather than six because the ceiling is there to stop a deal becoming
 * an album, and six of one kind with none of the other is the shape of a
 * mistake (#82).
 */
export const MAX_RECEIPTS_PER_KIND = 3;

/**
 * When each kind may be added, as an allowlist of deal statuses.
 *
 * Read from docs/04-deal-lifecycle.md: the money for the product is sent at
 * `PRODUCT_PAID`, so that is the first moment a product receipt can exist; the
 * postage is paid when the parcel is sent, which is the move into `SHIPPED`,
 * and the helper is in `PURCHASED` when they do it.
 *
 * `DISPUTED` is in both lists on purpose. A dispute is exactly when somebody
 * wants to show what they paid, and refusing the evidence at the moment it
 * matters would be a strange rule to have written.
 *
 * `COMPLETED` and `CANCELLED` are in neither: the deal is over, reviews are
 * open, and a receipt arriving afterwards is attaching evidence to something
 * nobody can act on. Listed rather than written as "not COMPLETED and not
 * CANCELLED", so a status added one day is refused until somebody decides
 * otherwise — the habit from #79's review.
 */
/** The two purposes this file is about, out of `FilePurpose`'s four. */
type ReceiptPurpose = Extract<
  FilePurpose,
  "PRODUCT_RECEIPT" | "SHIPPING_RECEIPT"
>;

const WHEN_ALLOWED: Record<ReceiptPurpose, DealStatus[]> = {
  PRODUCT_RECEIPT: [
    "PRODUCT_PAID",
    "PURCHASED",
    "SHIPPED",
    "DELIVERED",
    "DISPUTED",
  ],
  SHIPPING_RECEIPT: ["PURCHASED", "SHIPPED", "DELIVERED", "DISPUTED"],
};

/** The two kinds, as the API names them in a path. */
export type ReceiptKind = "product" | "shipping";

/** What the path segment means in the database. */
const PURPOSE_OF: Record<ReceiptKind, ReceiptPurpose> = {
  product: "PRODUCT_RECEIPT",
  shipping: "SHIPPING_RECEIPT",
};

/** And back again, for an answer. */
const KIND_OF: Partial<Record<FilePurpose, ReceiptKind>> = {
  PRODUCT_RECEIPT: "product",
  SHIPPING_RECEIPT: "shipping",
};

/** What a receipt looks like in an answer. */
export interface ReceiptView {
  id: string;
  kind: ReceiptKind;
  /** The path that serves it — never a signed link (decision 0012). */
  url: string;
  /** Who attached it is always the helper, so only when matters. */
  uploadedAt: Date;
}

function receiptView(
  file: Pick<File, "id" | "purpose" | "createdAt">,
): ReceiptView {
  return {
    id: file.id,
    // The purpose comes from a query that already filtered to the two receipt
    // purposes, so the fallback is unreachable rather than meaningful.
    kind: KIND_OF[file.purpose] ?? "product",
    url: filePath(file.id),
    uploadedAt: file.createdAt,
  };
}

/**
 * The deal, if this caller may attach a receipt to it.
 *
 * Three different answers, and the difference between them is the whole
 * privacy argument:
 *
 *   a stranger          404 — a deal they are not in must not be confirmable
 *   the requester       403 — they are in this deal, so hiding it says nothing
 *   a moderator         403 — reading a dispute is judging it; writing is not
 *   the helper          the deal
 */
async function dealForReceipt(actor: User, dealId: string) {
  const deal = await prisma.deal.findUnique({
    where: { id: dealId },
    select: { id: true, status: true, requesterId: true, helperId: true },
  });

  // `sideOf` is the deal's own answer (services/deals.ts), not a second copy.
  const side = sideOf(actor, deal);

  if (!deal || side === null) {
    throw HttpError.notFound("Deal not found");
  }

  if (side !== "helper") {
    throw HttpError.forbidden("Only the helper can attach a receipt");
  }

  return deal;
}

/**
 * Refuses a fourth receipt of a kind, counting on whichever client it is given.
 *
 * Twice per upload, like the photo limit (#81): once cheaply before the file
 * is touched, and once inside the transaction, where the answer is the one
 * that can be trusted.
 */
async function assertUnderReceiptLimit(
  dealId: string,
  purpose: ReceiptPurpose,
  client: Prisma.TransactionClient,
): Promise<void> {
  const count = await client.file.count({ where: { dealId, purpose } });

  if (count >= MAX_RECEIPTS_PER_KIND) {
    throw HttpError.conflict(
      `This deal already has ${String(MAX_RECEIPTS_PER_KIND)} ` +
        `${KIND_OF[purpose] ?? "product"} receipts. ` +
        `Nothing can be removed, so there is no room for another.`,
    );
  }
}

/**
 * Stores one receipt against a deal.
 *
 * The same order and the same lock as #81's photos, for the same reason: the
 * count and the insert have to be one indivisible step, or two uploads at
 * three receipts both count three. The lock is on the DEAL row.
 *
 *   1. who and whether       dealForReceipt — 404, 403
 *   2. the status allowlist  409 if this kind cannot be added yet
 *   3. size and type         checkUpload — JPEG, PNG, WebP or PDF here
 *   4. the cheap count       so a fourth is never re-encoded
 *   5. normalise, or not     an image is re-encoded; a PDF is stored as it came
 *   6. bytes to the store    outside the transaction
 *   7. lock, count, insert   one indivisible step
 */
export async function addReceipt(
  dealId: string,
  kind: ReceiptKind,
  user: User,
  bytes: Buffer,
): Promise<ReceiptView> {
  const deal = await dealForReceipt(user, dealId);
  const purpose = PURPOSE_OF[kind];

  // Permission BEFORE status, and the order is load-bearing: it means the
  // refusal somebody is not allowed to make does not depend on what state the
  // deal is in. A moderator gets the same 403 whether the deal is disputed or
  // finished, and learns nothing from the difference. Shown by a variant run —
  // removing DISPUTED from the lists below changed only the test about
  // DISPUTED, and not the one about moderators.
  if (!WHEN_ALLOWED[purpose].includes(deal.status)) {
    throw HttpError.conflict(
      `A ${kind} receipt cannot be attached to a deal that is ${deal.status}`,
    );
  }

  // Before the image library, never after (#80). This is also the step that
  // decides what the bytes ARE: a receipt may be a PDF, which no decoder here
  // should ever be handed.
  const mimeType = checkUpload(bytes, purpose);
  await assertUnderReceiptLimit(deal.id, purpose, prisma);

  // A PDF goes in untouched. Rewriting one needs a library this project does
  // not have, and a receipt emailed by a shop carries no GPS position to
  // strip — unlike a photograph of one, taken where somebody lives.
  const stored = await storeBytes(
    mimeType === "application/pdf" ? bytes : await normaliseReceipt(bytes),
    purpose,
  );

  try {
    const file = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM "Deal"
                         WHERE id = ${deal.id} FOR UPDATE`;

      await assertUnderReceiptLimit(deal.id, purpose, tx);

      return storeFileRow(
        stored,
        { ownerId: user.id, purpose, dealId: deal.id },
        tx,
      );
    });

    return receiptView(file);
  } catch (error) {
    // Stored, and nothing points at it: invisible garbage, so remove it, best
    // effort (#79), and report the failure that actually happened.
    await storage.delete(stored.storageKey).catch(() => undefined);
    throw error;
  }
}

/**
 * The receipts of one deal, oldest first, both kinds together.
 *
 * No permission check of its own: the only caller is the deal's own answer,
 * which has already decided who may see the deal — and whoever may see the
 * deal may see its receipts. One rule, in one place (#15's argument).
 *
 * There is no `removeReceipt`, and that is the design rather than an omission.
 * A receipt is evidence in somebody else's dispute, so the person who uploaded
 * it cannot take it back; a wrong one is followed by a right one and both
 * stay. #66 already keeps receipts when an account is deleted, for the same
 * reason.
 */
export async function receiptsForDeal(dealId: string): Promise<ReceiptView[]> {
  const rows = await prisma.file.findMany({
    where: {
      dealId,
      purpose: { in: ["PRODUCT_RECEIPT", "SHIPPING_RECEIPT"] },
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true, purpose: true, createdAt: true },
  });

  return rows.map(receiptView);
}
