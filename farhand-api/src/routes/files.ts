import { Router } from "express";
import { z } from "zod";
import { optionalAuth } from "../middleware/auth.js";
import { limiters } from "../middleware/rate-limit.js";
import { fileReadUrl } from "../services/files.js";
import { REDIRECT_CACHE_SECONDS } from "../storage.js";

export const filesRouter: Router = Router();

/**
 * Files.
 *
 *   GET /files/:id    whoever the file's purpose allows; a redirect
 *
 * Uploads are not here: each purpose gets its own (#80 avatars, #81 need
 * photos, #82 receipts), because only those endpoints know which need or deal
 * a file belongs to. Contract: docs/06-api-contract.md, "Files".
 */

const fileParams = z.object({ id: z.string().min(1) });

/**
 * A 302 to a signed URL that expires in five minutes, never the bytes.
 *
 * Redirecting rather than streaming keeps a 5 MB photo off the API's 512 MB
 * machine, and `<img src="/files/…">` follows a redirect without the frontend
 * knowing one happened.
 *
 * optionalAuth, because an avatar is for anyone while a receipt is for two
 * people — whether to read the session depends on the file, not the route.
 *
 * Cached for less time than the signature lasts, never longer: the redirect is
 * only as good as the URL inside it, so a browser that kept this 302 for an
 * hour would keep sending people to a signature that died after five minutes.
 * `private`, because the answer depends on who asked — a shared cache must
 * never hand one person's redirect to the next (src/storage.ts).
 *
 * Its own rate limit rather than the global one: this endpoint is called once
 * per image, so a single page view of a need with 30 photos would otherwise
 * spend a tenth of a visitor's whole browsing budget (#102).
 */
filesRouter.get(
  "/files/:id",
  limiters.fileByIp,
  optionalAuth,
  async (req, res) => {
    const { id } = fileParams.parse(req.params);
    const url = await fileReadUrl(id, req.auth?.user);

    res.set(
      "Cache-Control",
      `private, max-age=${String(REDIRECT_CACHE_SECONDS)}`,
    );
    res.redirect(302, url);
  },
);
