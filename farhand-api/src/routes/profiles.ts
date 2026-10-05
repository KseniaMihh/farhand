import express, { Router } from "express";
import { z } from "zod";
import {
  getAuth,
  requireActive,
  requireAuth,
  requireVerified,
} from "../middleware/auth.js";
import { limiters } from "../middleware/rate-limit.js";
import { countryCode } from "../schemas/common.js";
import { removeAvatar, setAvatar } from "../services/avatars.js";
import { MAX_FILE_BYTES } from "../services/files.js";
import {
  deleteMyAccount,
  getPublicProfile,
  ownProfileView,
  updateMyProfile,
} from "../services/profiles.js";

export const profilesRouter: Router = Router();

/**
 * Profiles.
 *
 *   GET   /users/:id     public, no session needed
 *   PATCH /me/profile    AUTH, and only ever the caller's own
 *   PUT   /me/avatar     AUTH, the image as the body (#80)
 *   DELETE /me/avatar    AUTH, back to none (#80)
 *
 * Contract: docs/06-api-contract.md, "Profile". `DELETE /me` belongs in this
 * file too and arrives with #66; it is a different problem — what survives an
 * account — and not a bigger version of this one.
 */

const userParams = z.object({ id: z.string().min(1) });

/**
 * The fields someone may change about themselves.
 *
 * Every one optional: a PATCH changes only what it mentions. The two nullable
 * columns are `.nullable()` as well, which is how a bio is cleared — sending
 * `null` empties it, sending `""` is refused, and leaving the key out keeps
 * what is there. Three distinct requests, three distinct meanings.
 *
 * The lengths match prisma/schema.prisma, so an over-long bio is a clean 422
 * rather than an error from Postgres.
 *
 * The avatar is NOT here. It is an upload, PUT /me/avatar (#80): accepting a
 * URL in this body would be an open invitation to point the whole site's
 * image tags at somebody else's server. `email` is not here
 * either: changing an address means proving the new one, which is #10's flow
 * and not a profile edit.
 *
 * Unknown fields are dropped by Zod, so a request cannot reach through this
 * and set `userId`.
 */
const updateProfileSchema = z.object({
  displayName: z.string().trim().min(1).max(50).optional(),
  bio: z.string().trim().min(1).max(500).nullable().optional(),
  countryCode: countryCode.optional(),
  city: z.string().trim().min(1).max(80).nullable().optional(),
});

/**
 * Anyone may look. No session is read at all — not even optionalAuth, because
 * unlike a need (#16) there is nothing extra for the owner to see here: a
 * person reading their own public profile should see exactly what everybody
 * else sees. `GET /auth/me` is where they look at their own private fields.
 */
profilesRouter.get("/users/:id", async (req, res) => {
  const { id } = userParams.parse(req.params);
  const user = await getPublicProfile(id);

  res.json({ user });
});

/**
 * AUTH — the three guards in the order docs/06-api-contract.md defines for the
 * marker. Verified included: a display name is public the moment it changes,
 * and an unverified account is one nobody has proved owns its address.
 */
profilesRouter.patch(
  "/me/profile",
  requireAuth,
  requireVerified,
  requireActive,
  async (req, res) => {
    const input = updateProfileSchema.parse(req.body);
    const updated = await updateMyProfile(getAuth(req).user, input);

    /**
     * The same five fields, in the same shape, as the `profile` object inside
     * `GET /auth/me` — a client that has already written code to read one
     * should not need a second reader for the other. `userId` is dropped: the
     * caller knows who they are.
     */
    res.json({ profile: ownProfileView(updated) });
  },
);

/**
 * The body of PUT /me/avatar is the image itself — `fetch(url, { method:
 * "PUT", body: file })` — so it is read raw, here only; the JSON parser in
 * app.ts stays at 100 kb for everything else.
 *
 * The parser's ceiling is TWICE the file limit, on purpose. Up to that, the
 * body is read and storeFile's rule answers the documented 422 "too large".
 * Beyond it the parser stops reading and answers 413 — a body ten times the
 * limit is not worth receiving just to refuse politely.
 */
const avatarBody = express.raw({
  type: () => true,
  limit: MAX_FILE_BYTES * 2,
});

/**
 * AUTH — an avatar is public the moment it is set, like a display name.
 * Limited per user: every upload is decoded and re-encoded (#80).
 */
profilesRouter.put(
  "/me/avatar",
  requireAuth,
  requireVerified,
  requireActive,
  limiters.avatarByUser,
  avatarBody,
  async (req, res) => {
    // With no body at all the raw parser leaves `{}` behind, not a Buffer.
    const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const profile = await setAvatar(getAuth(req).user, bytes, req.log);

    res.json({ profile: ownProfileView(profile) });
  },
);

/** AUTH. Having no avatar already is fine: the answer is the same. */
profilesRouter.delete(
  "/me/avatar",
  requireAuth,
  requireVerified,
  requireActive,
  async (req, res) => {
    const profile = await removeAvatar(getAuth(req).user, req.log);

    res.json({ profile: ownProfileView(profile) });
  },
);

/**
 * The password again, for the one write that cannot be undone.
 *
 * Every other write in this API is authorised by the session alone. This one
 * asks for the password as well, for the same reason a bank asks again before
 * a transfer: a cookie somebody else is holding should not be enough to
 * destroy an account (docs/06-api-contract.md).
 *
 * The bounds match registration (#10) so that a password that could never
 * have been set is refused as a 422 rather than spending time being hashed.
 */
const deleteAccountSchema = z.object({
  password: z.string().min(8).max(72),
});

/**
 * `SESSION`, not `AUTH`.
 *
 * An unverified account is still somebody's personal data — and the person who
 * signed up and never confirmed their email is exactly the one most likely to
 * want it gone. A suspended one too: a suspension stops you acting, and
 * leaving is not acting. The other guards would turn both into a 403 with
 * nowhere to go (docs/02-roles-and-permissions.md).
 */
profilesRouter.delete("/me", requireAuth, async (req, res) => {
  const { password } = deleteAccountSchema.parse(req.body);
  await deleteMyAccount(getAuth(req).user, password);

  res.status(204).end();
});
