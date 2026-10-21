import { Router } from "express";
import { z } from "zod";
import {
  getAuth,
  requireActive,
  requireAuth,
  requireVerified,
} from "../middleware/auth.js";
import {
  deleteMySearch,
  listMySearches,
  saveSearch,
} from "../services/saved-searches.js";

export const searchesRouter: Router = Router();

/**
 * Saved searches (#90).
 *
 *   POST   /me/searches      save one
 *   GET    /me/searches      the caller's own
 *   DELETE /me/searches/:id  remove one
 *
 * `AUTH`, not `SESSION`: posting a need needs a verified address and so does
 * standing in line for one. What a saved search does is send email, and an
 * unverified address is one nobody has proved they own (#12).
 *
 * There is no PATCH. Renaming a standing query or switching its email is a
 * delete and a save, which is two requests for something nobody has asked
 * for yet — and v2 scope does not grow either (docs/README.md, rule 4).
 */

const countryCode = z
  .string()
  .trim()
  .length(2)
  .transform((code) => code.toUpperCase());

const searchParams = z.object({ id: z.string().min(1) });

/**
 * The filters, per kind, in the browse endpoints' own query names — so a
 * client can save the query string it is already running (#16, #18).
 *
 * `.strict()` on both, and that is the half worth reading twice: a `country`
 * sent for a need search is a 422 rather than a search that quietly ignores
 * half of what was asked for. Somebody waiting on a filter that was dropped
 * is waiting for a narrower search than the one that exists.
 */
const needFilters = z
  .object({
    buyCountry: countryCode.optional(),
    deliverCountry: countryCode.optional(),
    categoryId: z.string().trim().min(1).optional(),
    q: z.string().trim().min(1).max(100).optional(),
  })
  .strict();

const helpFilters = z
  .object({
    country: countryCode.optional(),
    shipsTo: countryCode.optional(),
    categoryId: z.string().trim().min(1).optional(),
  })
  .strict();

const name = z.string().trim().min(1).max(80);
const notify = z.boolean().default(true);

const saveSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("NEED"),
      name,
      notify,
      filters: needFilters.default({}),
    })
    .strict(),
  z
    .object({
      kind: z.literal("HELP"),
      name,
      notify,
      filters: helpFilters.default({}),
    })
    .strict(),
]);

searchesRouter.post(
  "/me/searches",
  requireAuth,
  requireVerified,
  requireActive,
  async (req, res) => {
    const input = saveSchema.parse(req.body);
    const saved = await saveSearch(getAuth(req).user, input);

    res.status(201).json({ search: saved });
  },
);

searchesRouter.get(
  "/me/searches",
  requireAuth,
  requireVerified,
  requireActive,
  async (req, res) => {
    // No cursor: MAX_SAVED_SEARCHES is ten, and a page of ten with a cursor
    // nobody can use is machinery pretending to be a rule.
    res.json({ items: await listMySearches(getAuth(req).user) });
  },
);

searchesRouter.delete(
  "/me/searches/:id",
  requireAuth,
  requireVerified,
  requireActive,
  async (req, res) => {
    const { id } = searchParams.parse(req.params);
    await deleteMySearch(getAuth(req).user, id);

    res.status(204).end();
  },
);
