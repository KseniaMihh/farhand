/* eslint-disable @typescript-eslint/no-unused-vars --
   createSession below is a stub and does not use its arguments yet. DELETE
   THIS LINE once it is implemented. */
import type { Prisma } from "@prisma/client";
import type { CookieOptions } from "express";
import { isProduction } from "./env.js";
import { generateToken, hashToken } from "./tokens.js";

/**
 * Login sessions. Why sessions and not JWTs:
 * docs/10-decisions/0007-sessions-over-jwt.md — mainly, a session row can be
 * deleted, so banning someone takes effect immediately.
 *
 * The shape is the same as the verification tokens from #10, on purpose: a
 * random token goes to the browser (in a cookie this time, not an email), and
 * only its SHA-256 hash goes in the database. Same reasoning, same helpers.
 */

/** The cookie's name. The browser sends it back on every request. */
export const SESSION_COOKIE = "farhand_session";

/**
 * How long a login lasts: 30 days. After that the user logs in again.
 *
 * Fixed, not sliding — using the site does not extend it. Sliding expiry is
 * friendlier, but it means a write on every request; worth revisiting later
 * if people complain about being logged out.
 */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * How the session cookie is set. Each option closes a specific hole:
 *
 *   httpOnly   JavaScript on the page cannot read the cookie. If an attacker
 *              ever gets a script onto a Farhand page (XSS), they still cannot
 *              steal the session. This is the main reason ADR 0007 rejects
 *              keeping tokens in localStorage.
 *
 *   secure     The browser only sends the cookie over HTTPS, so it never
 *              travels in plain text. On in production. Off in development
 *              and tests, which run on plain http://localhost — with it on,
 *              the browser would silently refuse to send the cookie back.
 *
 *   sameSite   "lax": the cookie is not sent on requests that other websites
 *              trigger in the background (a hidden form on evil.example
 *              POSTing to our API). That blocks most CSRF attacks, which ADR
 *              0007 lists as the cost of using cookies. It IS sent when the
 *              user follows a normal link to Farhand, so arriving from an
 *              email link still finds you logged in.
 *
 *   path       "/" — sent to every endpoint, not only /auth.
 *
 *   maxAge     The browser forgets the cookie when the session expires in the
 *              database anyway, so the two lifetimes match.
 *
 * Takes `production` as a parameter rather than reading the environment inside,
 * so the tests can check both versions without restarting in production mode.
 */
export function sessionCookieOptions(
  production: boolean = isProduction,
): CookieOptions {
  return {
    httpOnly: true,
    secure: production,
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_TTL_MS,
  };
}

/** Recorded with the session so a user can later see "logged in from…". */
export interface SessionMeta {
  userAgent: string | undefined;
  ipAddress: string | undefined;
}

/**
 * Starts a session for a user. Returns the RAW token, for the cookie; stores
 * only its hash.
 *
 * TODO(#11): you have written this before — it is createVerificationToken from
 * #10 with a different table:
 *   1. generateToken()
 *   2. db.session.create with the userId, tokenHash: hashToken(raw),
 *      expiresAt: now + SESSION_TTL_MS, and the userAgent and ipAddress from
 *      `meta`
 *   3. return the raw token
 *
 * One Prisma detail: with `exactOptionalPropertyTypes` on in tsconfig, you
 * cannot pass `undefined` to a nullable column — pass `meta.userAgent ?? null`.
 */
export async function createSession(
  db: Prisma.TransactionClient,
  userId: string,
  meta: SessionMeta,
): Promise<string> {
  // TODO(#11): replace this whole body.
  return Promise.reject(new Error("createSession is not implemented yet"));
}
