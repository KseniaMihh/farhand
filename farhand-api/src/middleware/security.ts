import cors from "cors";
import type { RequestHandler } from "express";
import helmet from "helmet";
import { env } from "../env.js";
import { HttpError } from "../errors.js";

/**
 * The three pieces of hardening that apply to every request.
 *
 * None of this is about who a caller is — the guards in ./auth.ts do that.
 * This is about the browser: what it is allowed to do with our answers, which
 * pages may call us at all, and which requests we refuse to believe came from
 * our own site.
 */

/**
 * Response headers that tell the browser to be careful.
 *
 * Helmet sets about a dozen; the ones that matter for a JSON API:
 *
 *   X-Content-Type-Options: nosniff   never guess a response is HTML or a
 *                                     script when we said it is JSON
 *   X-Frame-Options / frame-ancestors nobody may put our answers in an iframe
 *   Strict-Transport-Security         after one visit over HTTPS, the browser
 *                                     refuses to try HTTP again (production
 *                                     only — it is set by helmet's default and
 *                                     harmless behind a proxy that terminates
 *                                     TLS)
 *   Referrer-Policy                   our URLs do not leak to other sites
 *
 * The Content-Security-Policy helmet adds by default is aimed at HTML pages.
 * It costs nothing here and is one more thing in place if this server ever
 * returns a page, so it stays.
 */
export const securityHeaders: RequestHandler = helmet();

/**
 * Which website's JavaScript may call this API, with cookies.
 *
 * `credentials: true` is what lets the browser send the session cookie at all,
 * and it is exactly why `origin` cannot be `*`: the two together are forbidden
 * by the specification, and a wildcard would mean any page on the internet
 * could make authenticated requests as whoever is signed in.
 */
export const crossOrigin: RequestHandler = cors({
  // A function rather than the string, so that a page we do not know gets NO
  // header at all. Handed the string, the cors package answers every request
  // with our own origin — which a browser still refuses to accept, but which
  // reads like an allowance and tells the caller what we expect.
  origin: (origin, allow) => {
    allow(null, origin === env.APP_ORIGIN);
  },
  credentials: true,
  methods: ["GET", "POST", "PATCH", "DELETE"],
  allowedHeaders: ["Content-Type"],
  maxAge: 600,
});

/**
 * Refuses writes that did not come from our own site.
 */
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export const sameOriginWrites: RequestHandler = (req, _res, next) => {
  if (!env.CSRF_ENABLED || SAFE_METHODS.has(req.method)) {
    next();
    return;
  }

  const origin = req.get("origin");
  if (origin !== undefined) {
    // Exact match only. A browser's Origin header is always scheme+host+port
    // with no path, so there is nothing to be a prefix OF.
    if (origin === env.APP_ORIGIN) {
      next();
      return;
    }
    next(HttpError.forbidden("Cross-site request refused"));
    return;
  }

  const referer = req.get("referer");
  if (referer !== undefined) {
    // Parsed, not matched as text. `https://farhand.ee.evil.example` starts
    // with our origin as a STRING but is a different site — .origin from a
    // real URL object is the only comparison that can't be fooled that way.
    try {
      if (new URL(referer).origin === env.APP_ORIGIN) {
        next();
        return;
      }
    } catch {
      // An unparsable Referer proves nothing either way; fall through.
    }
  }

  // Neither header, or neither one matched: no provenance we can trust.
  next(HttpError.forbidden("Cross-site request refused"));
};
