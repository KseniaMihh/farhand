import { Router } from "express";
import { listCategories } from "../services/categories.js";

export const categoriesRouter: Router = Router();

/**
 * How long a shared cache may keep the list (#159).
 *
 * An hour. A renamed category shows its old name for at most that long, and
 * nobody is hurt by it; the list changes about once a year. Short enough
 * that it is not worth building a way to clear it, which would otherwise be
 * the next thing somebody built.
 *
 * A constant rather than a number written into the header, because
 * docs/06-api-contract.md quotes it: a figure a document states and the code
 * also states is two places to change, and #119 is the issue that learned
 * that the hard way about an email.
 */
export const CATEGORY_CACHE_SECONDS = 3600;

/**
 * Every category (#159).
 *
 * `—`: no session is read at all, for the same reason as
 * `GET /prohibited-items`. A category picker sits on the screens somebody
 * fills in before they have posted anything, and the browse filters are
 * public outright.
 *
 * THE FIRST PUBLIC CACHE HEADER THIS API SETS. `src/routes/files.ts` already
 * sends `private, max-age=…` on the image redirect, so the mechanism is not
 * new — but `private` means "this answer was for one caller". This one is
 * the same for everybody, and `public` is a genuinely different promise: a
 * shared cache may keep it and hand it to somebody else.
 *
 * That promise is only safe while nothing here depends on who is asking. The
 * day this endpoint learns to say something per-caller — a hidden category,
 * a count of somebody's own needs — `public` becomes a leak rather than an
 * optimisation. There is a test that two different callers get byte-for-byte
 * the same answer, and that is the test that would notice.
 */
categoriesRouter.get("/categories", async (_req, res) => {
  const categories = await listCategories();

  res.set("Cache-Control", `public, max-age=${String(CATEGORY_CACHE_SECONDS)}`);

  // Named, never a bare array — every other reply in this API is an object,
  // and the shape inside it is the one an offer has carried since #17.
  res.json({ categories });
});
