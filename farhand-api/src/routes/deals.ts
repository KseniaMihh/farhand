import express, { Router } from "express";
import { z } from "zod";
import {
  getAuth,
  requireActive,
  requireAuth,
  requireVerified,
} from "../middleware/auth.js";
import { limiters } from "../middleware/rate-limit.js";
import { currencyCode } from "../schemas/common.js";
import {
  getDeal,
  listDealEvents,
  listMyDeals,
  listQuotes,
  submitQuote,
  transitionDeal,
} from "../services/deals.js";
import { MAX_FILE_BYTES } from "../services/files.js";
import { addReceipt, receiptsForDeal } from "../services/receipts.js";
import {
  editReview,
  MAX_COMMENT_LENGTH,
  reviewsOnDeal,
  writeReview,
} from "../services/reviews.js";
import {
  decodeCursor,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
} from "../services/shared.js";

export const dealsRouter: Router = Router();

/**
 * Deals: quoting, and the first status change.
 *
 * Contract: docs/06-api-contract.md.
 *
 *   POST /deals/:id/quote       the helper says what it will cost
 *   GET  /deals/:id/quotes      every revision, newest first
 *   POST /deals/:id/transition  the requester agrees — `{ "to": "QUOTE_AGREED" }`
 *
 * One transition endpoint rather than one endpoint per status is settled in
 * docs/10-decisions/0008-single-transition-endpoint.md. #23 implements a
 * single transition behind it; #24 replaces the body with the whole table.
 * The URL and the request shape are already their final ones.
 */

const idParams = z.object({ id: z.string().min(1) });

/**
 * Whole cents, never decimals (docs/10-decisions/0006-money-as-integer-cents).
 * `int()` is what refuses 24.5 — and 24.5 here would mean somebody is thinking
 * in euros, which is the mistake the decision record exists to prevent.
 */
const quoteSchema = z.object({
  currency: currencyCode,
  productAmount: z.number().int().positive(),
  shippingEstimate: z.number().int().nonnegative(),
});

/** The nine statuses, for the two schemas that have to name them. */
const DEAL_STATUSES = [
  "MATCHED",
  "QUOTE_AGREED",
  "PRODUCT_PAID",
  "PURCHASED",
  "SHIPPED",
  "DELIVERED",
  "COMPLETED",
  "CANCELLED",
  "DISPUTED",
] as const;

/**
 * A transition request: the shape of it, and nothing about which fields this
 * particular move needs.
 *
 * #24 had a discriminated union here, one member per target, each demanding
 * exactly the fields that target uses. #25 showed that cannot work, because a
 * requirement belongs to the ROW and not to the target:
 *
 *   PURCHASED → SHIPPED    the helper posts it: tracking number, real postage
 *   DISPUTED  → SHIPPED    a moderator undoes a dispute: a note, and nothing
 *                          else — the parcel details are already on the deal
 *
 * Same target, different requirements, and the schema cannot tell them apart
 * because it does not know what status the deal is in. So this validates only
 * what a schema can decide on its own — is `to` a status, is the note short
 * enough, is the postage whole cents — and `requires` in the transition table
 * decides the rest, in the service, where the deal is known.
 *
 * `.strict()` still refuses a field nobody has heard of.
 */
const transitionSchema = z
  .object({
    to: z.enum(DEAL_STATUSES),
    note: z.string().trim().min(1).max(500).optional(),
    trackingNumber: z.string().trim().min(1).max(100).optional(),
    shippingActual: z.number().int().nonnegative().optional(),
  })
  .strict();

const listQuerySchema = z.object({
  status: z.enum(DEAL_STATUSES).optional(),
  cursor: z.string().trim().min(1).optional(),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_PAGE_SIZE)
    .default(DEFAULT_PAGE_SIZE),
});

dealsRouter.post(
  "/deals/:id/quote",
  requireAuth,
  requireVerified,
  requireActive,
  async (req, res) => {
    const { id } = idParams.parse(req.params);
    const input = quoteSchema.parse(req.body);
    const quote = await submitQuote(getAuth(req).user, id, input);

    res.status(201).json({ quote });
  },
);

dealsRouter.get(
  "/deals/:id/quotes",
  requireAuth,
  requireVerified,
  requireActive,
  async (req, res) => {
    const { id } = idParams.parse(req.params);
    const quotes = await listQuotes(getAuth(req).user, id);

    res.json({ quotes });
  },
);

dealsRouter.post(
  "/deals/:id/transition",
  requireAuth,
  requireVerified,
  requireActive,
  async (req, res) => {
    const { id } = idParams.parse(req.params);
    const { to, ...input } = transitionSchema.parse(req.body);
    const deal = await transitionDeal(getAuth(req).user, id, to, input);

    res.json({ deal });
  },
);

/**
 * Reading a deal. The contract has listed both of these since the beginning and
 * no issue had built them, so until now the two people in a deal could not see
 * the deal they were in — only the answer that created it.
 */
dealsRouter.get(
  "/me/deals",
  requireAuth,
  requireVerified,
  requireActive,
  async (req, res) => {
    const { status, cursor, limit } = listQuerySchema.parse(req.query);
    const page = await listMyDeals(
      getAuth(req).user,
      status,
      cursor === undefined ? undefined : decodeCursor(cursor),
      limit,
    );

    res.json(page);
  },
);

dealsRouter.get(
  "/deals/:id",
  requireAuth,
  requireVerified,
  requireActive,
  async (req, res) => {
    const { id } = idParams.parse(req.params);
    const deal = await getDeal(getAuth(req).user, id);

    // Whoever may see the deal may see its receipts: `getDeal` has already
    // decided who that is, and there is no second rule here (#82). Reviews
    // are not the same: a review inside its blind window is its author's
    // alone, so that answer is assembled per caller (#83).
    res.json({
      deal: {
        ...deal,
        receipts: await receiptsForDeal(deal.id),
        reviews: await reviewsOnDeal(getAuth(req).user, deal.id, new Date()),
      },
    });
  },
);

/* ─────────────────────────── reviews (#83) ─────────────────────────── */

/**
 * What a review may say. The target is NOT here: it is the other person in the
 * deal, derived by the service, because a client that could name the target
 * could name itself.
 *
 * The rating's bounds are the same 1–5 the database CHECK constraint enforces,
 * stated twice on purpose — a clean `422` naming the field here, and a rule
 * that holds even if this route is bypassed there.
 */
const reviewSchema = z.object({
  rating: z.number().int().min(1).max(5),
  comment: z
    .string()
    .trim()
    .min(1)
    .max(MAX_COMMENT_LENGTH)
    .nullable()
    .default(null),
});

/** AUTH. A participant of a completed deal, once, before the window closes. */
dealsRouter.post(
  "/deals/:id/review",
  requireAuth,
  requireVerified,
  requireActive,
  async (req, res) => {
    const { id } = idParams.parse(req.params);
    const input = reviewSchema.parse(req.body);
    const review = await writeReview(getAuth(req).user, id, input, new Date());

    res.status(201).json({ review });
  },
);

/** AUTH. The caller's own, and only while nobody else can read it. */
dealsRouter.patch(
  "/deals/:id/review",
  requireAuth,
  requireVerified,
  requireActive,
  async (req, res) => {
    const { id } = idParams.parse(req.params);
    const input = reviewSchema.parse(req.body);
    const review = await editReview(getAuth(req).user, id, input, new Date());

    res.json({ review });
  },
);

/* ─────────────────────────── receipts (#82) ─────────────────────────── */

/**
 * The body of a receipt upload is the file itself, read raw — the same shape
 * as `PUT /me/avatar` (#80) and `POST /needs/:id/photos` (#81). A receipt may
 * be a PDF as well as a photograph, which changes what happens to the bytes
 * later and nothing about how they arrive.
 */
const receiptBody = express.raw({
  type: () => true,
  limit: MAX_FILE_BYTES * 2,
});

/** `product` or `shipping`, parsed rather than trusted like every param. */
const receiptParams = idParams.extend({
  kind: z.enum(["product", "shipping"]),
});

/**
 * AUTH, and limited per user: a photographed receipt is decoded, resized and
 * re-encoded, the most expensive thing this API does.
 *
 * Who may attach one — the helper, and only the helper — is decided in
 * ../services/receipts.js. There is deliberately no endpoint for removing one.
 */
dealsRouter.post(
  "/deals/:id/receipts/:kind",
  requireAuth,
  requireVerified,
  requireActive,
  limiters.receiptByUser,
  receiptBody,
  async (req, res) => {
    const { id, kind } = receiptParams.parse(req.params);
    // With no body at all the raw parser leaves `{}` behind, not a Buffer.
    const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const receipt = await addReceipt(id, kind, getAuth(req).user, bytes);

    res.status(201).json({ receipt });
  },
);

/* ─────────────────── the event log on its own (#67) ─────────────────── */

/** Paging for the event log. No filters: a history is read, not browsed. */
const eventsQuerySchema = z.object({
  cursor: z.string().trim().min(1).optional(),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_PAGE_SIZE)
    .default(DEFAULT_PAGE_SIZE),
});

/**
 * A deal's history on its own, oldest first.
 *
 * `GET /deals/:id` already carries the same events, embedded. This one adds
 * the thing that makes a history readable — who did each step, by name — and
 * pages, so a long-running deal is not one enormous answer
 * (docs/06-api-contract.md).
 */
dealsRouter.get(
  "/deals/:id/events",
  requireAuth,
  requireVerified,
  requireActive,
  async (req, res) => {
    const { id } = idParams.parse(req.params);
    const { cursor, limit } = eventsQuerySchema.parse(req.query);
    const page = await listDealEvents(
      getAuth(req).user,
      id,
      cursor === undefined ? undefined : decodeCursor(cursor),
      limit,
    );

    res.json(page);
  },
);
