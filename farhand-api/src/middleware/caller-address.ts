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

    if (!isPrivateAddress(req.ip)) {
      next();
      return;
    }

    said = true;

    const forwardedFor = req.headers["x-forwarded-for"];
    const message =
      `The caller's address resolved to ${String(req.ip)}, which is private: ` +
      `trust proxy believes ${String(TRUSTED_PROXY_HOPS)} hops and the chain ` +
      `has more than that, so every by-address rate limit is counting a ` +
      `proxy instead of the caller (#145)`;

    logger.error(
      {
        ip: req.ip,
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
