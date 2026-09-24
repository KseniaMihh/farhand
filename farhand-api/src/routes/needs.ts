import { Router } from "express";
import { z } from "zod";
import { countryCode, currencyCode } from "../schemas/common.js";
import {
  getAuth,
  optionalAuth,
  requireActive,
  requireAuth,
  requireVerified,
} from "../middleware/auth.js";
import {
  createNeed,
  deleteNeed,
  getVisibleNeed,
  listMyNeeds,
  listOpenNeeds,
  updateNeed,
} from "../services/needs.js";
import {
  decodeCursor,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
} from "../services/shared.js";

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
  /**
   * The three columns that may be empty use .nullable().default(null) rather
   * than .optional(). Both mean "you may leave this out", but they produce
   * different values: .optional() gives undefined, and a nullable database
   * column wants null. Settling it here means the service and Prisma agree,
   * instead of every caller converting.
   */
  productUrl: z.url().max(2000).nullable().default(null),
  storeName: z.string().trim().min(1).max(100).nullable().default(null),
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
  expiresAt: z.coerce.date().nullable().default(null),
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

/* ───────────────────────────── browsing (#16) ───────────────────────────── */

/**
 * The query string of a list request.
 *
 * Everything arrives as text, so numbers are coerced and blanks are treated as
 * absent — `?q=` should not narrow the list to needs containing an empty
 * string. `limit` is capped: an unbounded page size is a way to ask the
 * database for the entire table in one request.
 */
const listQuerySchema = z.object({
  cursor: z.string().trim().min(1).optional(),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_PAGE_SIZE)
    .default(DEFAULT_PAGE_SIZE),
  buyCountry: countryCode.optional(),
  deliverCountry: countryCode.optional(),
  categoryId: z.string().trim().min(1).optional(),
  q: z.string().trim().min(1).max(100).optional(),
});

needsRouter.get("/needs", async (req, res) => {
  const { cursor, limit, ...filters } = listQuerySchema.parse(req.query);
  const page = await listOpenNeeds(
    filters,
    cursor === undefined ? undefined : decodeCursor(cursor),
    limit,
  );

  res.json(page);
});

/**
 * Public, but "public" depends on the need: the owner sees their own drafts,
 * everyone else sees only what is on offer. The service decides.
 *
 * requireAuth is NOT used here, since anyone may look. The session cookie is
 * read only to know whether the caller happens to be the owner.
 */
needsRouter.get("/needs/:id", optionalAuth, async (req, res) => {
  const { id } = needParams.parse(req.params);
  const need = await getVisibleNeed(id, req.auth?.user.id);

  res.json({ need });
});

needsRouter.get("/me/needs", requireAuth, async (req, res) => {
  const { cursor, limit } = listQuerySchema.parse(req.query);
  const page = await listMyNeeds(
    getAuth(req).user,
    cursor === undefined ? undefined : decodeCursor(cursor),
    limit,
  );

  res.json(page);
});
