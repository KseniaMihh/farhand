import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { getAuth } from "../middleware/auth.js";
import { setEmailNotifications } from "../services/notifications.js";

export const notificationsRouter: Router = Router();

const preferenceSchema = z.object({ emailNotifications: z.boolean() }).strict();

/**
 * SESSION — and the missing guards are the decision here, not an oversight.
 *
 * `AUTH` would add `requireVerified` and `requireActive`, which between them
 * refuse an unverified account and a suspended one. Those are exactly the two
 * people most likely to want the email to stop: one never confirmed the
 * address it is arriving at, and the other has been told off and would rather
 * not hear more about it. "Confirm your email address before you may ask us
 * to stop emailing you" is not a sentence this project is going to send.
 *
 * `DELETE /me` is marked the same way, for the same reason (#66): what you
 * may do to your own account does not depend on the state of it.
 *
 * The opt-out being here at all, rather than a link in the email, is decision
 * 0015: one unsubscribe click at the provider blocks the address for
 * everything we send, verification included.
 */
notificationsRouter.patch(
  "/me/notifications",
  requireAuth,
  async (req, res) => {
    const { emailNotifications } = preferenceSchema.parse(req.body);
    const now = await setEmailNotifications(
      getAuth(req).user.id,
      emailNotifications,
    );

    res.json({ emailNotifications: now });
  },
);
