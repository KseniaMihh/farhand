import { createHash, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { env } from "../env.js";
import { logger } from "../logger.js";
import { reportError } from "../observability.js";
import { requestIdOf } from "./request-id.js";

/**
 * Who the caller is, when everything between them and us belongs to somebody
 * else — issue #145.
 *
 * `req.ip` is not a fact the API observes. The socket it is handed comes from
 * Render's own network, so the caller's address is a claim in a header, and
 * what `trust proxy` decides is how much of that claim to believe. Get it
 * wrong and nothing breaks loudly: every by-address rate limit counts against
 * the proxy instead of the caller, and the "logged in from…" record on each
 * session names a machine in a data centre.
 *
 * measured chain: see docs/15-architecture.md and decision 0029
 */

/**
 * How many hops of `X-Forwarded-For` Express believes.
 *
 * **Three, measured on production on 21 October 2026** (#131's walk, step 12,
 * and #145):
 *
 *     caller → Cloudflare → Render's balancer → us
 *
 * Cloudflare is in front of every `onrender.com` host — production's own
 * response headers carry `server: cloudflare` beside `x-render-origin-server:
 * Render` — and the hop from the balancer to this process arrives on
 * loopback, which is why `remoteAddress` is `::1` and not a proxy's address.
 *
 * **Express counts from the socket backwards**, which is the direction that
 * makes a count safe: Cloudflare *appends* the address it sees to whatever
 * `X-Forwarded-For` already said, so anything a caller invents for itself
 * ends up to the LEFT of its real address, and a count of three steps over
 * it. `true` would believe the leftmost entry — an unlimited budget for
 * anybody who can write a header, or somebody else's address and a lockout
 * for them.
 *
 * The cost of a count is that it is a fact about somebody else's
 * infrastructure. If Render puts another hop in front of us, this number is
 * quietly wrong again in the one direction `createCallerAddressCheck` below
 * cannot see — landing on Cloudflare's address, which is a real one. Step 12
 * of docs/16-pre-launch-smoke-test.md is what asks; it caught this one.
 */
export const TRUSTED_PROXY_HOPS = 3;

/** `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16` — RFC 1918. */
function isRfc1918(octets: number[]): boolean {
  const [first, second] = octets as [number, number, number, number];

  if (first === 10) return true;
  if (first === 172 && second >= 16 && second <= 31) return true;

  return first === 192 && second === 168;
}

/**
 * Whether an address can only have come from inside a network.
 *
 * This is the whole of what makes a wrong hop count detectable without
 * knowing the right one: a request from the internet cannot *arrive* carrying
 * one of these as its caller, so resolving one means the count landed on an
 * intermediary rather than on a caller.
 *
 * `undefined` is not a wrong address — it is no address, which is what
 * Express hands back when there is nothing to resolve at all.
 */
export function isPrivateAddress(address: string | undefined): boolean {
  if (address === undefined || address.trim() === "") return false;

  // Node writes an IPv4 address reached over an IPv6 socket as
  // `::ffff:127.0.0.1`, which is the spelling every local request has.
  const plain = address
    .trim()
    .toLowerCase()
    .replace(/^::ffff:/, "");

  if (plain.includes(":")) {
    // `::1` is loopback; `fc00::/7` — anything starting `fc` or `fd` — is
    // IPv6's own private range.
    return plain === "::1" || /^f[cd]/.test(plain);
  }

  const octets = plain.split(".").map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet))) {
    return false;
  }

  // 169.254.0.0/16 is link-local: a machine that failed to get a lease, never
  // a caller.
  return (
    octets[0] === 127 ||
    isRfc1918(octets) ||
    (octets[0] === 169 && octets[1] === 254)
  );
}

/**
 * THE TWO HEADERS THE FRONTEND SIGNS WITH — issue #164.
 *
 * `TRUSTED_PROXY_HOPS` above governs the direct path and nothing else now.
 * Requests that come through the deployed site arrive with a chain one entry
 * longer, because `farhand-web/proxy.ts` is a fourth machine in front of
 * this one, and a count cannot be right for both lengths at once.
 *
 * Nor can it be made right by raising it. A direct caller who sends one
 * invented entry produces a chain the same length and the same shape as the
 * proxied one, so a count of four would resolve the forgery. The chain simply
 * carries no evidence of which path it came down — see decision 0035, which
 * has the measurements.
 *
 * So the frontend states the address and proves it is the frontend. The proof
 * is a shared secret, which is the one thing a stranger cannot produce.
 */
export const CALLER_HEADER = "x-farhand-caller";
export const VOUCH_HEADER = "x-farhand-vouch";

// Same reason as `req.auth` in middleware/auth.ts: teaches TypeScript that a
// request may carry this, rather than inventing a request type of our own.
declare module "express-serve-static-core" {
  interface Request {
    /**
     * The address the frontend stated, once it has proved it is the frontend.
     * Read it through `callerAddress` rather than directly — `undefined` here
     * means "nobody vouched", not "no address".
     */
    vouchedCaller?: string;
  }
}

/**
 * Who to count this request against, and whose address to record on a session.
 *
 * The vouched address when there is one, and `req.ip` otherwise. Unlike
 * `getAuth`, this does not throw when nothing ran before it: a direct request
 * to the API is a perfectly ordinary thing, and `req.ip` is the right answer
 * for it.
 */
export function callerAddress(req: Request): string | undefined {
  return req.vouchedCaller ?? req.ip;
}

/**
 * A digest, so two values can be compared without their lengths mattering.
 *
 * `timingSafeEqual` throws unless both buffers are the same length, which
 * leaves two choices: check the lengths first — and a thrown-or-not on length
 * is itself a side channel telling a caller how long the secret is — or
 * compare digests, which are always 32 bytes. The second one.
 */
function sha256(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/**
 * Honours `x-farhand-caller`, but only on proof that our own frontend sent it.
 *
 * A factory for the same reason `createCallerAddressCheck` is one: the "said
 * it once" below belongs to this app, not to the module, so a second app in
 * the same process starts with nothing said yet. That is what makes it
 * testable.
 *
 * Mounted before the limiters in app.ts, because what it decides is what they
 * are about to count.
 */
export function createVouchedAddress(
  // The secret is a parameter with a default rather than a read from `env`
  // inside, so a test can hand one in. `env.PROXY_VOUCH_SECRET` is absent for
  // the whole suite and in development, which is the state that must mean
  // "nothing is ever vouched" — so it is also the default.
  secret: string | undefined = env.PROXY_VOUCH_SECRET,
): RequestHandler {
  // Hashed once, at mount, rather than on every request.
  const expected =
    secret === undefined || secret === "" ? undefined : sha256(secret);

  // The "once" belongs to this app, not to the module — see above.
  let said = false;

  return function vouchedAddress(
    req: Request,
    _res: Response,
    next: NextFunction,
  ): void {
    // No secret configured, so nothing is ever vouched. This is development,
    // this is the whole test suite, and — the reason it fails this way round —
    // it is also a forgotten dashboard variable. Falling back to `req.ip`
    // counts a proxy, which is a bug; trusting an unverifiable header would
    // let anyone claim any address, which is worse.
    if (expected === undefined) {
      next();
      return;
    }

    const offered = req.headers[VOUCH_HEADER];
    const claimed = req.headers[CALLER_HEADER];

    // Both, and each exactly one value. Node joins duplicate headers with a
    // comma so `string[]` is rare, but "the first of two" is not something to
    // guess at: a request carrying two of either is refused rather than read.
    if (typeof offered !== "string" || typeof claimed !== "string") {
      next();
      return;
    }

    if (!timingSafeEqual(sha256(offered), expected)) {
      // What a rotated secret looks like from in here, and it is otherwise
      // silent: the site keeps working and every visitor quietly shares one
      // bucket again. Never either secret in the message — this is read in
      // Render's logs, which is exactly where neither belongs.
      if (!said) {
        said = true;
        logger.error(
          { header: VOUCH_HEADER },
          "A request carried a vouch that does not verify: PROXY_VOUCH_SECRET " +
            "differs between this API and the frontend, so every by-address " +
            "limit is counting the proxy again (#164). Rotating it needs a " +
            "redeploy of the web side, not only a dashboard save",
        );
      }
      next();
      return;
    }

    const address = claimed.trim();

    // A verified vouch carrying something that is not an address is our own
    // frontend being wrong, and it would otherwise become a rate-limit key
    // that silently groups everyone it was sent for into one bucket.
    if (isIP(address) === 0) {
      if (!said) {
        said = true;
        logger.error(
          { header: CALLER_HEADER },
          "A verified vouch carried something that is not an address, so it " +
            "was ignored: farhand-web/lib/vouched-caller.ts is reading its " +
            "own inbound chain wrongly (#164)",
        );
      }
      next();
      return;
    }

    // Deliberately not checked for being private — see the complaint in
    // `createCallerAddressCheck`, which is what notices that and says which
    // file to go and look at. Refusing here would fall back to `req.ip`,
    // look almost right, and hide it.
    req.vouchedCaller = address;

    next();
  };
}

/**
 * Says so, once, when the address we resolved cannot be a caller's.
 *
 * A factory rather than a middleware, so the "once" belongs to this app and
 * not to the module: a second app in the same process starts with nothing
 * said yet, which is what makes it testable. `createRateLimiter` is a factory
 * for the same reason.
 *
 * Production only. Development and the test suite resolve `127.0.0.1` or a
 * Docker address every time, and a check that complained about `npm run dev`
 * would be switched off inside a week.
 *
 * It writes to the root logger rather than `req.log`, because what it has
 * found is a fact about the process and its configuration, not about the
 * request that happened to reveal it.
 */
export function createCallerAddressCheck(): RequestHandler {
  let said = false;

  return function callerAddressCheck(
    req: Request,
    _res: Response,
    next: NextFunction,
  ): void {
    if (said || env.NODE_ENV !== "production") {
      next();
      return;
    }

    // The address we would actually USE, which since #164 is not always
    // `req.ip`: a vouched one would otherwise slip past this check entirely.
    const resolved = callerAddress(req);

    if (!isPrivateAddress(resolved)) {
      next();
      return;
    }

    said = true;

    const forwardedFor = req.headers["x-forwarded-for"];

    // WHICH SETTING TO GO AND LOOK AT, because the two sources fail for
    // completely different reasons and this message is the only thing
    // pointing at one of them. A private address that was VOUCHED for is not
    // a hop-count problem at all — sending that reader to
    // `TRUSTED_PROXY_HOPS` would cost them an afternoon in the wrong file.
    const message =
      req.vouchedCaller !== undefined
        ? `The caller's address resolved to ${String(resolved)}, which is ` +
          `private, and our own frontend vouched for it (#164): ` +
          `farhand-web/proxy.ts is reading its own inbound chain wrongly ` +
          `— TRUSTED_PROXY_HOPS is NOT the setting to change`
        : `The caller's address resolved to ${String(resolved)}, which is ` +
          `private: trust proxy believes ${String(TRUSTED_PROXY_HOPS)} hops ` +
          `and the chain has more than that, so every by-address rate limit ` +
          `is counting a proxy instead of the caller (#145)`;

    logger.error(
      {
        ip: resolved,
        vouched: req.vouchedCaller !== undefined,
        forwardedFor: Array.isArray(forwardedFor)
          ? forwardedFor.join(", ")
          : forwardedFor,
        remoteAddress: req.socket.remoteAddress,
        trustedProxyHops: TRUSTED_PROXY_HOPS,
      },
      message,
    );

    // Worth a report and not only a line: this is silent in every way a user
    // could notice, and the log it lands in is Render's, which nobody is
    // watching at three in the morning.
    reportError(new Error(message), {
      requestId: requestIdOf(req),
      method: req.method,
      path: req.path,
    });

    next();
  };
}
