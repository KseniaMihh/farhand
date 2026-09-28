import { Router } from "express";
import { z } from "zod";
import {
  getAuth,
  requireActive,
  requireAuth,
  requireVerified,
} from "../middleware/auth.js";
import { currencyCode } from "../schemas/common.js";
import { listQuotes, submitQuote, transitionDeal } from "../services/deals.js";

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
 * The only transition #23 knows. #24 widens this to the full DealStatus list
 * and validates the fields each target needs; until then, anything else is a
 * 422 rather than a route that quietly accepts it and does nothing.
 */
const transitionSchema = z.object({
  to: z.literal("QUOTE_AGREED"),
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
    const { to } = transitionSchema.parse(req.body);
    const deal = await transitionDeal(getAuth(req).user, id, to);

    res.json({ deal });
  },
);
