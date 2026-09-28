import { Router } from "express";
import { z } from "zod";
import {
  getAuth,
  requireActive,
  requireAuth,
  requireRole,
  requireVerified,
} from "../middleware/auth.js";
import { listReportQueue, submitReport } from "../services/reports.js";
import {
  decodeCursor,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
} from "../services/shared.js";

export const reportsRouter: Router = Router();

/**
 * Reports, and the queue they land in.
 *
 *   POST /reports          anybody signed in says "look at this"
 *   GET  /admin/reports    a moderator reads what is waiting
 *
 * Two audiences, one row. The `/admin` prefix is not decoration: everything
 * under it needs `requireRole("MODERATOR")`, and keeping those routes together
 * makes a missing guard obvious at a glance rather than something you have to
 * go looking for (docs/02-roles-and-permissions.md).
 */

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

/**
 * `details` is optional and nullable — the reason carries the meaning, and
 * demanding a paragraph before somebody can report harassment is a way of
 * getting fewer reports about harassment.
 */
const reportSchema = z.object({
  targetType: z.enum(TARGET_TYPES),
  targetId: z.string().trim().min(1),
  reason: z.enum(REASONS),
  details: z.string().trim().min(1).max(2000).nullable().default(null),
});

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

reportsRouter.post(
  "/reports",
  requireAuth,
  requireVerified,
  requireActive,
  async (req, res) => {
    const input = reportSchema.parse(req.body);
    const report = await submitReport(getAuth(req).user, input);

    res.status(201).json({ report });
  },
);

reportsRouter.get(
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
