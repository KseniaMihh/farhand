import type { Request, RequestHandler } from "express";
import { ipKeyGenerator, rateLimit } from "express-rate-limit";
import { env } from "../env.js";
import { HttpError } from "../errors.js";

/**
 * Rate limiting for the authentication endpoints.
 *
 * What it is for, endpoint by endpoint:
 *
 *   login                 stops password guessing — a thousand tries against
 *                         one account, or one common password against a
 *                         thousand accounts
 *   register              stops a script creating accounts in bulk
 *   forgot-password,      stops someone using our server to flood a stranger's
 *   resend-verification   inbox with emails they did not ask for (#41 noted
 *                         this endpoint needs it)
 *   reset-password,       stops guessing at tokens
 *   verify-email
 *
 * Two limits run on each of those, because one alone is easy to walk around:
 *
 *   BY IP      one address can only try so often — but an attacker with a
 *              botnet has thousands of addresses
 *   BY ACCOUNT one email address can only be tried so often, wherever the
 *              requests come from — but one address could still attack many
 *              accounts, one try each
 *
 * Neither catches both attacks. Together they cover each other, which is why
 * issue #14 asks for both.
 *
 * The counts live in this process's memory. That is fine for one server and
 * wrong for several: each would count separately, so three servers means three
 * times the limit. When the API is deployed behind more than one instance, the
 * store moves to Redis — the library supports it, and nothing else changes.
 */

/**
 * How many requests, in how long. Deliberately generous: a real person who
 * fumbles their password five times must not be locked out, while a script
 * trying thousands is stopped long before it gets anywhere.
 */
export const RATE_LIMITS = {
  login: { windowMs: 15 * 60 * 1000, perIp: 20, perAccount: 10 },
  register: { windowMs: 60 * 60 * 1000, perIp: 10, perAccount: 5 },
  /** Both endpoints that send an email to an address someone typed in. */
  emailToAddress: { windowMs: 60 * 60 * 1000, perIp: 10, perAccount: 5 },
  /** Token guessing: no account to key on, so by IP only. */
  token: { windowMs: 15 * 60 * 1000, perIp: 30 },
  /**
   * Everything, by address. Not a security control on its own — the specific
   * limits above are what stop password guessing and inbox flooding — but a
   * ceiling under which no single machine can hammer the API at all, however
   * inventive it is about which endpoint it picks (issue #28).
   *
   * Generous on purpose: a person browsing quickly must never see a 429.
   */
  global: { windowMs: 60 * 1000, perIp: 300 },

  /**
   * Messages, per signed-in user: sending one needs a session, so there is
   * somebody better to count than an address two colleagues share. Generous
   * enough for a real back-and-forth, mean enough that flooding somebody's
   * inbox takes effort (docs/07-trust-and-safety.md).
   */
  message: { windowMs: 60 * 1000, perUser: 20 },
} as const;

/** What a limiter counts by. */
export type LimitBy = "ip" | "account" | "user";

export interface RateLimiterOptions {
  windowMs: number;
  max: number;
  by: LimitBy;
}

/**
 * Builds one rate limiter.
 */
export function createRateLimiter(options: RateLimiterOptions): RequestHandler {
  return rateLimit({
    windowMs: options.windowMs,
    limit: options.max,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    skip: () => !env.RATE_LIMIT_ENABLED,
    keyGenerator: (req) => {
      if (options.by === "ip") return ipKeyGenerator(req.ip ?? "");
      if (options.by === "user") return signedInKey(req);
      return accountKey(req);
    },
    handler: (req, res, _next, opts) => {
      res.setHeader(
        "Retry-After",
        String(retryAfterSeconds(req, opts.windowMs)),
      );
      throw HttpError.tooManyRequests();
    },
  });
}

/**
 * How many seconds until this client may try again.
 *
 * express-rate-limit records when the window ends on the request, but version
 * 8 no longer adds that field to Express's types — hence the small cast. If
 * it is missing, the whole window is a safe answer: never tell a client to
 * come back sooner than they may.
 */
export function retryAfterSeconds(req: Request, windowMs: number): number {
  const info = (req as Request & { rateLimit?: { resetTime?: Date } })
    .rateLimit;
  const msLeft = info?.resetTime
    ? info.resetTime.getTime() - Date.now()
    : windowMs;

  return Math.max(1, Math.ceil(msLeft / 1000));
}

/**
 * The key for an account limit: the email in the request body, normalised the
 * same way the schemas normalise it, so "Anna@X.com " and "anna@x.com" share
 * one budget rather than getting one each.
 *
 * A request with no usable email falls back to the IP, so it still counts
 * against something. Validation will reject it a moment later anyway.
 */
export function accountKey(req: Request): string {
  const body: unknown = req.body;
  const email =
    typeof body === "object" && body !== null && "email" in body
      ? (body as { email?: unknown }).email
      : undefined;

  return typeof email === "string" && email.trim() !== ""
    ? `account:${email.trim().toLowerCase()}`
    : `account-unknown:${ipKeyGenerator(req.ip ?? "")}`;
}

/**
 * The key for a signed-in caller: the user behind the session.
 *
 * `accountKey` above reads the email out of the body, which is the only thing
 * available when nobody is signed in yet — login and register. Behind
 * `requireAuth` there is something better, and using the body there would key
 * every message on the sender's address instead, which is to say on nothing
 * (issue #21).
 *
 * The limiter runs after `requireAuth`, so `req.auth` is set; the fallback is
 * only for a limiter mounted in the wrong order, and it fails closed onto the
 * address rather than handing out an unlimited budget.
 */
export function signedInKey(req: Request): string {
  const auth = (req as Request & { auth?: { user: { id: string } } }).auth;

  return auth
    ? `user:${auth.user.id}`
    : `user-unknown:${ipKeyGenerator(req.ip ?? "")}`;
}

/**
 * The limiters the routes use. Built once, here, so every endpoint of a kind
 * shares one set of counters — forgot-password and resend-verification both
 * send an email to whatever address was typed in, so they share a budget
 * rather than each granting its own.
 */
export const limiters = {
  loginByIp: createRateLimiter({
    windowMs: RATE_LIMITS.login.windowMs,
    max: RATE_LIMITS.login.perIp,
    by: "ip",
  }),
  loginByAccount: createRateLimiter({
    windowMs: RATE_LIMITS.login.windowMs,
    max: RATE_LIMITS.login.perAccount,
    by: "account",
  }),
  registerByIp: createRateLimiter({
    windowMs: RATE_LIMITS.register.windowMs,
    max: RATE_LIMITS.register.perIp,
    by: "ip",
  }),
  registerByAccount: createRateLimiter({
    windowMs: RATE_LIMITS.register.windowMs,
    max: RATE_LIMITS.register.perAccount,
    by: "account",
  }),
  emailToAddressByIp: createRateLimiter({
    windowMs: RATE_LIMITS.emailToAddress.windowMs,
    max: RATE_LIMITS.emailToAddress.perIp,
    by: "ip",
  }),
  emailToAddressByAccount: createRateLimiter({
    windowMs: RATE_LIMITS.emailToAddress.windowMs,
    max: RATE_LIMITS.emailToAddress.perAccount,
    by: "account",
  }),
  tokenByIp: createRateLimiter({
    windowMs: RATE_LIMITS.token.windowMs,
    max: RATE_LIMITS.token.perIp,
    by: "ip",
  }),
  globalByIp: createRateLimiter({
    windowMs: RATE_LIMITS.global.windowMs,
    max: RATE_LIMITS.global.perIp,
    by: "ip",
  }),
  messageByUser: createRateLimiter({
    windowMs: RATE_LIMITS.message.windowMs,
    max: RATE_LIMITS.message.perUser,
    by: "user",
  }),
};
