import { Router } from "express";
import { z } from "zod";
import {
  getAuth,
  optionalAuth,
  requireActive,
  requireAuth,
  requireVerified,
} from "../middleware/auth.js";
import { countryCode } from "../schemas/common.js";
import {
  createHelp,
  deleteHelp,
  getVisibleHelp,
  listActiveHelps,
  MAX_HELP_CATEGORIES,
  MAX_SHIPS_TO,
  updateHelp,
} from "../services/helps.js";
import {
  decodeCursor,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
} from "../services/shared.js";

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

/* ───────────────────────────── browsing (#18) ───────────────────────────── */

/**
 * The query string of a list request. The same shape as needs', minus the
 * text search — an offer is a sentence about a person, not a product listing,
 * so there is nothing useful to match yet.
 */
const listQuerySchema = z.object({
  cursor: z.string().trim().min(1).optional(),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_PAGE_SIZE)
    .default(DEFAULT_PAGE_SIZE),
  country: countryCode.optional(),
  shipsTo: countryCode.optional(),
  categoryId: z.string().trim().min(1).optional(),
});

helpsRouter.get("/helps", async (req, res) => {
  const { cursor, limit, ...filters } = listQuerySchema.parse(req.query);
  const page = await listActiveHelps(
    filters,
    cursor === undefined ? undefined : decodeCursor(cursor),
    limit,
  );

  res.json(page);
});

/** Public, but the helper sees their own paused offer. As with a need. */
helpsRouter.get("/helps/:id", optionalAuth, async (req, res) => {
  const { id } = helpParams.parse(req.params);
  const help = await getVisibleHelp(id, req.auth?.user.id);

  res.json({ help });
});
