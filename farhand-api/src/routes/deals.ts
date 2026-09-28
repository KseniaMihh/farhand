import { Router } from "express";
import { z } from "zod";
import {
  getAuth,
  requireActive,
  requireAuth,
  requireVerified,
} from "../middleware/auth.js";
import { currencyCode } from "../schemas/common.js";
import {
  getDeal,
  listMyDeals,
  listQuotes,
  submitQuote,
  transitionDeal,
} from "../services/deals.js";
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

/**
 * A transition, validated against what its target needs.
 *
 * A discriminated union on `to` rather than one loose object: it is the fifth
 * acceptance criterion of #24 — "transition-specific fields validated per
 * target status" — and it is the difference between the API refusing a shipping
 * announcement with no tracking number and the API accepting one, shrugging,
 * and leaving a deal that says SHIPPED with nothing to track.
 *
 * `.strict()` on every member, so a field that does not belong to the target is
 * a 422 rather than silently dropped. Sending a tracking number along with
 * "delivered" means the caller believes something that is not true, and saying
 * so is kinder than ignoring it.
 *
 * What each target requires comes from docs/04-deal-lifecycle.md, the same
 * table src/services/transitions.ts holds.
 */
const transitionSchema = z.discriminatedUnion("to", [
  z.object({ to: z.literal("QUOTE_AGREED") }).strict(),
  z.object({ to: z.literal("PRODUCT_PAID") }).strict(),
  z.object({ to: z.literal("PURCHASED") }).strict(),
  z
    .object({
      to: z.literal("SHIPPED"),
      trackingNumber: z.string().trim().min(1).max(100),
      shippingActual: z.number().int().nonnegative(),
    })
    .strict(),
  z.object({ to: z.literal("DELIVERED") }).strict(),
  z.object({ to: z.literal("COMPLETED") }).strict(),
  // A reason, because somebody will have to read this later and "cancelled"
  // on its own explains nothing.
  z
    .object({
      to: z.literal("CANCELLED"),
      note: z.string().trim().min(1).max(500),
    })
    .strict(),
  z
    .object({
      to: z.literal("DISPUTED"),
      note: z.string().trim().min(1).max(500),
    })
    .strict(),
]);

const listQuerySchema = z.object({
  status: z
    .enum([
      "MATCHED",
      "QUOTE_AGREED",
      "PRODUCT_PAID",
      "PURCHASED",
      "SHIPPED",
      "DELIVERED",
      "COMPLETED",
      "CANCELLED",
      "DISPUTED",
    ])
    .optional(),
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

    res.json({ deal });
  },
);
