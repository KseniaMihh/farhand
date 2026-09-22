import type { Profile, Role, Session, User } from "@prisma/client";
import { parseCookie } from "cookie";
import type { Request, RequestHandler } from "express";
import { prisma } from "../db.js";
import { HttpError } from "../errors.js";
import { SESSION_COOKIE } from "../sessions.js";
import { hashToken } from "../tokens.js";

/**
 * Authentication for every protected route.
 *
 * Login (#11) gave the browser a session cookie. From now on it sends that
 * cookie with every request, and the middlewares here turn it back into "who
 * is this, and what may they do":
 *
 *   requireAuth      is anyone logged in? Loads the user from the session.
 *   requireVerified  have they confirmed their email?
 *   requireActive    are they allowed to act — not suspended?
 *   requireRole      are they a moderator, or an admin?
 *
 * The last three build on the first, so a route lists them in that order:
 *
 *   router.post("/needs", requireAuth, requireVerified, requireActive, handler)
 *
 * Why this lives on the server even though the frontend will hide buttons:
 * "Hiding a button in the frontend is not a permission"
 * (docs/02-roles-and-permissions.md). Anyone can send any request with curl.
 */

/** What requireAuth attaches to the request once it knows who is calling. */
export interface AuthContext {
  user: User & { profile: Profile | null };
  session: Session;
}

// Teaches TypeScript that every Express request may carry `auth`. Without this,
// `req.auth = …` is a type error. This is "declaration merging": we add a field
// to Express's own Request interface rather than inventing a new request type.
declare module "express-serve-static-core" {
  interface Request {
    auth?: AuthContext;
  }
}

/**
 * The logged-in user and session, for handlers behind requireAuth.
 *
 * `req.auth` is optional in the type, because TypeScript cannot know which
 * middlewares ran before a handler. This turns "optional" into "definitely
 * there" — and if a route forgot requireAuth, it fails loudly with a 500
 * instead of quietly treating everyone as logged out, or worse, logged in.
 */
export function getAuth(req: Request): AuthContext {
  if (!req.auth) {
    throw new Error(
      "getAuth() called on a route without requireAuth in front of it",
    );
  }
  return req.auth;
}

/** The raw session token from the request's Cookie header, if there is one. */
function readSessionToken(req: Request): string | undefined {
  return parseCookie(req.headers.cookie ?? "")[SESSION_COOKIE];
}

/**
 * Is anyone logged in? Loads their session and user, or answers 401.
 *
 * Use the same 401 — HttpError.unauthorized(), default message — for every
 * failure. The caller learns "log in again", nothing about why.
 *
 * This one is async (it queries the database). Express 5 forwards a throw
 * from an async middleware to the error handler by itself.
 */
export const requireAuth: RequestHandler = async (req, _res, next) => {
  const token = readSessionToken(req);
  if (!token) {
    next(HttpError.unauthorized());
    return;
  }

  const session = await prisma.session.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { user: { include: { profile: true } } },
  });

  if (
    !session ||
    session.expiresAt < new Date() ||
    session.user.status === "BANNED" ||
    session.user.status === "DELETED"
  ) {
    next(HttpError.unauthorized());
    return;
  }

  req.auth = { user: session.user, session };
  next();
};

/**
 * Has the user confirmed their email? 403 if not.
 *
 * 403, not 401: we know exactly who they are. They are just not allowed yet.
 * Unverified users can log in and look around; they cannot post or propose
 * until they verify (docs/02-roles-and-permissions.md).
 */
export const requireVerified: RequestHandler = (req, _res, next) => {
  if (getAuth(req).user.emailVerifiedAt === null) {
    next(HttpError.forbidden("Confirm your email address first"));
    return;
  }
  next();
};

/**
 * Is the user allowed to act — that is, not suspended? 403 if they are.
 *
 * Not in #12's acceptance criteria, but it is where #11's promise lands: a
 * suspended user can log in and see their deals, and this is what stops them
 * posting or messaging. Routes from #15 on will use it.
 *
 * "Not ended yet" means suspendedUntil is null (no end date) or in the future.
 * A suspendedUntil in the PAST means the suspension is over — nothing runs at
 * midnight to flip the status back to ACTIVE, so this check is what makes a
 * suspension end on time.
 */
export const requireActive: RequestHandler = (req, _res, next) => {
  const { user } = getAuth(req);
  const stillSuspended =
    user.status === "SUSPENDED" &&
    (user.suspendedUntil === null || user.suspendedUntil > new Date());

  if (stillSuspended) {
    next(HttpError.forbidden("Your account is suspended"));
    return;
  }
  next();
};

/**
 * The roles, in order of power. Each can do everything the ones below it can
 * (docs/02-roles-and-permissions.md: an admin can do everything a moderator
 * can). Comparing numbers means requireRole("MODERATOR") lets admins through
 * without listing them.
 */
const ROLE_RANK: Record<Role, number> = {
  USER: 0,
  MODERATOR: 1,
  ADMIN: 2,
};

/**
 * At least this role, or 403.
 *
 * A function that RETURNS a middleware, because it needs an argument:
 *
 *   router.post("/admin/users/:id/actions", requireAuth, requireRole("MODERATOR"), handler)
 */
export function requireRole(minimum: Role): RequestHandler {
  return (req, _res, next) => {
    const { user } = getAuth(req);
    if (ROLE_RANK[user.role] < ROLE_RANK[minimum]) {
      next(HttpError.forbidden());
      return;
    }
    next();
  };
}
