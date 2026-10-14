import { ReportTarget } from "@prisma/client";
import { Router } from "express";
import { z } from "zod";
import {
  getAuth,
  requireActive,
  requireAuth,
  requireVerified,
} from "../middleware/auth.js";
import { submitReport } from "../services/reports.js";

export const reportsRouter: Router = Router();

/**
 * Reports, and the queue they land in.
 *
 *   POST /reports   anybody signed in says "look at this"
 *
 * The reading half lives in routes/admin.ts, with the rest of the moderator's
 * surface: everything under `/admin` needs `requireRole`, and keeping those
 * routes in one file makes a missing guard obvious at a glance rather than
 * something you have to go looking for (docs/02-roles-and-permissions.md).
 */

/**
 * Read from the schema rather than typed out again (#125).
 *
 * This was a hand-written copy of `ReportTarget`, in two route files, and
 * adding `REVIEW` to the enum left both of them quietly refusing the new value
 * with a `422` — the drift that `docs/README.md`'s first rule is about.
 * Prisma generates the enum as a real object, so the list can come from there
 * and the next value added arrives here on its own.
 */
const TARGET_TYPES = ReportTarget;
const REASONS = [
  "PROHIBITED_ITEM",
  "SCAM",
  "HARASSMENT",
  "SEXUAL_CONTENT",
  "SPAM",
  "OTHER",
] as const;
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
