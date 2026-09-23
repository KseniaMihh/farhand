import { Router } from "express";
import { z } from "zod";
import {
  getAuth,
  requireActive,
  requireAuth,
  requireVerified,
} from "../middleware/auth.js";
import { createNeed, deleteNeed, updateNeed } from "../services/needs.js";

export const needsRouter: Router = Router();

/**
 * Needs: what someone wants bought and brought.
 *
 * Contract: docs/06-api-contract.md. Browsing and reading (GET /needs,
 * /needs/:id, /me/needs) arrive in #16 — this file is create, edit and delete.
 *
 * The handlers are deliberately thin. Who may do what lives in
 * ../services/needs.js, for the reason at the top of that file.
 *
 * Every route here is AUTH: signed in, email confirmed, not suspended. That is
 * the three guards in the order docs/06-api-contract.md defines for the marker.
 */

/** Two letters, as in the Profile's country. */
const countryCode = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{2}$/, "Must be a two-letter country code");

/** ISO 4217, as stored on Need.currency. */
const currencyCode = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{3}$/, "Must be a three-letter currency code");

/**
 * What a new need must contain. The lengths match the columns in
 * prisma/schema.prisma, so an over-long title is a clean 422 rather than an
 * error from Postgres.
 *
 * Money is in whole cents — docs/06-api-contract.md, "all money in integer
 * cents". A price of 12.50 EUR arrives as 1250. Never a float: 0.1 + 0.2 is
 * not 0.3 in floating point, and that is not a property anyone wants in a
 * price.
 */
export const createNeedSchema = z.object({
  categoryId: z.string().trim().min(1),
  title: z.string().trim().min(1).max(120),
  description: z.string().trim().min(1).max(2000),
  productUrl: z.url().max(2000).optional(),
  storeName: z.string().trim().min(1).max(100).optional(),
  buyCountry: countryCode,
  deliverCountry: countryCode,
  currency: currencyCode,
  estimatedPrice: z.number().int().positive(),
  thankYouAmount: z.number().int().nonnegative().default(0),
  /**
   * A need is public the moment it is created, unless it is saved as a draft.
   * The other statuses (MATCHED, CLOSED, EXPIRED, REMOVED) are reached by
   * something happening, never by asking for them here.
   */
  status: z.enum(["DRAFT", "OPEN"]).default("OPEN"),
  expiresAt: z.coerce.date().optional(),
});

/** Every field optional: a PATCH changes only what it mentions. */
export const updateNeedSchema = createNeedSchema.partial();

/**
 * The :id in the path. Express 5 types route parameters as
 * "string | string[] | undefined", so they get parsed like any other input
 * rather than trusted.
 */
const needParams = z.object({ id: z.string().min(1) });

needsRouter.post(
  "/needs",
  requireAuth,
  requireVerified,
  requireActive,
  async (req, res) => {
    const input = createNeedSchema.parse(req.body);
    const need = await createNeed(getAuth(req).user, input);

    res.status(201).json({ need });
  },
);

needsRouter.patch(
  "/needs/:id",
  requireAuth,
  requireVerified,
  requireActive,
  async (req, res) => {
    const { id } = needParams.parse(req.params);
    const input = updateNeedSchema.parse(req.body);
    const need = await updateNeed(getAuth(req).user, id, input);

    res.json({ need });
  },
);

needsRouter.delete(
  "/needs/:id",
  requireAuth,
  requireVerified,
  requireActive,
  async (req, res) => {
    const { id } = needParams.parse(req.params);
    await deleteNeed(getAuth(req).user, id);

    res.status(204).end();
  },
);
