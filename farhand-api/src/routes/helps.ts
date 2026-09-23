import { Router } from "express";
import { z } from "zod";
import {
  getAuth,
  requireActive,
  requireAuth,
  requireVerified,
} from "../middleware/auth.js";
import { countryCode } from "../schemas/common.js";
import {
  createHelp,
  deleteHelp,
  MAX_HELP_CATEGORIES,
  MAX_SHIPS_TO,
  updateHelp,
} from "../services/helps.js";

export const helpsRouter: Router = Router();

/**
 * Helps: offers to buy something and send it on.
 *
 * Contract: docs/06-api-contract.md. Browsing arrives in #18; this file is
 * create, edit and delete. Thin handlers, as in ./needs.js — the rules live in
 * ../services/helps.js.
 */

/**
 * The countries an offer will post to.
 *
 * An EMPTY list means "anywhere", which is the schema's own rule
 * (prisma/schema.prisma) and what #18's filter relies on — so it is a default,
 * not a validation failure. Duplicates are removed: "EE, ee, EE" is one
 * country, and letting it through would make the filter and the display both
 * look silly.
 */
const shipsTo = z
  .array(countryCode)
  .max(MAX_SHIPS_TO)
  .default([])
  .transform((codes) => [...new Set(codes)]);

/**
 * Which categories this helper will shop in. At least one: an offer in no
 * category cannot be found by anyone browsing.
 */
const categoryIds = z
  .array(z.string().trim().min(1))
  .min(1)
  .max(MAX_HELP_CATEGORIES)
  .transform((ids) => [...new Set(ids)]);

export const createHelpSchema = z.object({
  country: countryCode,
  shipsTo,
  description: z.string().trim().min(1).max(1000),
  categoryIds,
  /**
   * ACTIVE or PAUSED only. REMOVED is what taking the offer down does, and
   * what a moderator does (#27) — never something a caller asks for directly.
   */
  status: z.enum(["ACTIVE", "PAUSED"]).default("ACTIVE"),
});

/** Every field optional: a PATCH changes only what it mentions. */
export const updateHelpSchema = createHelpSchema.partial();

/** The :id in the path, parsed rather than trusted. */
const helpParams = z.object({ id: z.string().min(1) });

helpsRouter.post(
  "/helps",
  requireAuth,
  requireVerified,
  requireActive,
  async (req, res) => {
    const input = createHelpSchema.parse(req.body);
    const help = await createHelp(getAuth(req).user, input);

    res.status(201).json({ help });
  },
);

helpsRouter.patch(
  "/helps/:id",
  requireAuth,
  requireVerified,
  requireActive,
  async (req, res) => {
    const { id } = helpParams.parse(req.params);
    const input = updateHelpSchema.parse(req.body);
    const help = await updateHelp(getAuth(req).user, id, input);

    res.json({ help });
  },
);

helpsRouter.delete(
  "/helps/:id",
  requireAuth,
  requireVerified,
  requireActive,
  async (req, res) => {
    const { id } = helpParams.parse(req.params);
    await deleteHelp(getAuth(req).user, id);

    res.status(204).end();
  },
);
