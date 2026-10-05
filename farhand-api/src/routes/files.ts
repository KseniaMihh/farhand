import { Router } from "express";
import { z } from "zod";
import { optionalAuth } from "../middleware/auth.js";
import { fileReadUrl } from "../services/files.js";

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
 * `no-store`, because the redirect is only as good as the URL inside it: a
 * browser that cached this 302 for an hour would keep sending people to a
 * signature that died after five minutes.
 */
filesRouter.get("/files/:id", optionalAuth, async (req, res) => {
  const { id } = fileParams.parse(req.params);
  const url = await fileReadUrl(id, req.auth?.user);

  res.set("Cache-Control", "private, no-store");
  res.redirect(302, url);
});
