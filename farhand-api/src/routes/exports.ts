import { Router } from "express";
import { z } from "zod";
import { getAuth, requireAuth } from "../middleware/auth.js";
import { downloadExport, requestExport } from "../services/exports.js";

export const exportsRouter: Router = Router();

const exportParams = z.object({ id: z.string().min(1) });

/**
 * SESSION, the same marker and the same reasoning as `DELETE /me` (#66): what
 * you may do about your own data does not depend on the state of your
 * account. An unverified or suspended person is still entitled to a copy —
 * and because the export is handed to a session rather than emailed, nothing
 * is ever sent to an address nobody has proved they own.
 *
 * `202`, not `200`: the answer is "asked for", not "here it is". The work
 * happens in #85's queue, because reading somebody's whole history is a dozen
 * queries and a request that takes a second is a request people press twice.
 */
exportsRouter.post("/me/exports", requireAuth, async (req, res) => {
  const asked = await requestExport(getAuth(req).user);

  res.status(202).json(asked);
});

/**
 * SESSION. Ownership is checked on the ROW rather than on the path, and a
 * stranger's export is `404` rather than `403` — an export somebody may not
 * read is one they may not know exists (#79's lesson about files).
 *
 * Not ready is `409`, expired is `410`: "ask again in a moment" and "ask
 * again from the start" are different answers, and a client can tell them
 * apart.
 */
exportsRouter.get("/me/exports/:id", requireAuth, async (req, res) => {
  const { id } = exportParams.parse(req.params);
  const payload = await downloadExport(getAuth(req).user, id);

  // Named and attached, so a browser saves the file rather than painting
  // somebody's whole history onto a screen.
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="farhand-export-${id}.json"`,
  );
  res.json(payload);
});
