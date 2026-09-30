import { Router } from "express";
import { z } from "zod";
import {
  getAuth,
  requireActive,
  requireAuth,
  requireRole,
  requireVerified,
} from "../middleware/auth.js";
import {
  actOnUser,
  getReportWithTarget,
  removeContent,
  resolveReport,
  searchUsers,
} from "../services/moderation.js";
import { listReportQueue } from "../services/reports.js";
import {
  decodeCursor,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
} from "../services/shared.js";

export const adminRouter: Router = Router();

/**
 * Everything a moderator can do.
 *
 *   GET  /admin/reports            the queue (#26)
 *   GET  /admin/reports/:id        one report, with the thing it is about
 *   POST /admin/reports/:id/resolve
 *   POST /admin/users/:id/actions  warn, suspend, ban, reactivate
 *   POST /admin/content/:type/:id/remove
 *
 * One file for the whole `/admin` surface, and one guard stack repeated on
 * every route in it. That repetition is deliberate: a route that quietly lacks
 * `requireRole` is the kind of mistake that does not announce itself, and
 * having them side by side makes a missing line visible
 * (docs/02-roles-and-permissions.md).
 */

const idParams = z.object({ id: z.string().min(1) });

const TARGET_TYPES = ["USER", "NEED", "HELP", "MESSAGE"] as const;
const REASONS = [
  "PROHIBITED_ITEM",
  "SCAM",
  "HARASSMENT",
  "SEXUAL_CONTENT",
  "SPAM",
  "OTHER",
] as const;
const STATUSES = ["OPEN", "RESOLVED", "DISMISSED"] as const;

const queueSchema = z.object({
  status: z.enum(STATUSES).optional(),
  targetType: z.enum(TARGET_TYPES).optional(),
  reason: z.enum(REASONS).optional(),
  cursor: z.string().trim().min(1).optional(),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_PAGE_SIZE)
    .default(DEFAULT_PAGE_SIZE),
});

/**
 * A reason on every action, and a long one allowed: this is the sentence
 * somebody reads months later when they ask why an account was banned.
 */
const actionSchema = z
  .object({
    type: z.enum(["WARN", "SUSPEND", "BAN", "REACTIVATE"]),
    reason: z.string().trim().min(1).max(1000),
    until: z.coerce.date().optional(),
  })
  .strict()
  .refine((input) => input.until === undefined || input.type === "SUSPEND", {
    message: "Only a suspension can have an end date",
    path: ["until"],
  });

const removalSchema = z
  .object({ reason: z.string().trim().min(1).max(1000) })
  .strict();

const contentParams = z.object({
  type: z.enum(TARGET_TYPES),
  id: z.string().min(1),
});

const resolutionSchema = z
  .object({
    outcome: z.enum(["RESOLVED", "DISMISSED"]),
    resolutionNote: z.string().trim().min(1).max(1000),
  })
  .strict();

adminRouter.get(
  "/admin/reports",
  requireAuth,
  requireVerified,
  requireActive,
  requireRole("MODERATOR"),
  async (req, res) => {
    const { cursor, limit, ...filters } = queueSchema.parse(req.query);
    const page = await listReportQueue(
      filters,
      cursor === undefined ? undefined : decodeCursor(cursor),
      limit,
    );

    res.json(page);
  },
);

adminRouter.get(
  "/admin/reports/:id",
  requireAuth,
  requireVerified,
  requireActive,
  requireRole("MODERATOR"),
  async (req, res) => {
    const { id } = idParams.parse(req.params);
    const found = await getReportWithTarget(getAuth(req).user, id);

    res.json(found);
  },
);

adminRouter.post(
  "/admin/reports/:id/resolve",
  requireAuth,
  requireVerified,
  requireActive,
  requireRole("MODERATOR"),
  async (req, res) => {
    const { id } = idParams.parse(req.params);
    const input = resolutionSchema.parse(req.body);
    const report = await resolveReport(getAuth(req).user, id, input);

    res.json({ report });
  },
);

adminRouter.post(
  "/admin/users/:id/actions",
  requireAuth,
  requireVerified,
  requireActive,
  requireRole("MODERATOR"),
  async (req, res) => {
    const { id } = idParams.parse(req.params);
    const input = actionSchema.parse(req.body);
    const action = await actOnUser(getAuth(req).user, id, input);

    res.status(201).json({ action });
  },
);

adminRouter.post(
  "/admin/content/:type/:id/remove",
  requireAuth,
  requireVerified,
  requireActive,
  requireRole("MODERATOR"),
  async (req, res) => {
    const { type, id } = contentParams.parse(req.params);
    const { reason } = removalSchema.parse(req.body);
    const action = await removeContent(getAuth(req).user, type, id, reason);

    res.status(201).json({ action });
  },
);

/* ────────────────────── finding a person (#67) ────────────────────── */

/** The four values AccountStatus can hold (prisma/schema.prisma). */
const ACCOUNT_STATUSES = ["ACTIVE", "SUSPENDED", "BANNED", "DELETED"] as const;

/**
 * What a moderator may narrow the user list by.
 *
 * `email` is lowercased and trimmed before it is matched, the way
 * registration stores it (#10), so an address copied out of a complaint finds
 * the account whatever case it arrives in.
 *
 * `q` has a floor of two characters. A single letter is not a search, it is a
 * way of walking the table one page at a time — and unlike `email`, this one
 * matches partially, so that floor is the only thing standing in the way.
 */
const userSearchSchema = z.object({
  email: z.string().trim().toLowerCase().min(1).optional(),
  q: z.string().trim().min(2).max(50).optional(),
  status: z.enum(ACCOUNT_STATUSES).optional(),
  cursor: z.string().trim().min(1).optional(),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_PAGE_SIZE)
    .default(DEFAULT_PAGE_SIZE),
});

/**
 * Finding a person. MOD.
 *
 * The one place in the API that hands out an email address
 * (docs/07-trust-and-safety.md says there are none anywhere, and this is the
 * exception that proves the rule). Which is why it is behind `requireRole`,
 * why it is paged, and why every call of it is written to the log.
 */
adminRouter.get(
  "/admin/users",
  requireAuth,
  requireVerified,
  requireActive,
  requireRole("MODERATOR"),
  async (req, res) => {
    const { cursor, limit, ...filters } = userSearchSchema.parse(req.query);
    const page = await searchUsers(
      getAuth(req).user,
      filters,
      cursor === undefined ? undefined : decodeCursor(cursor),
      limit,
    );

    res.json(page);
  },
);
