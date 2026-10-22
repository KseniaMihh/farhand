import type { NextConfig } from "next";

/**
 * The API is served under this app's own address, and that is the whole
 * configuration — issue #93, decision 0031.
 *
 * THE REASON IS A COOKIE. The session cookie is `sameSite: "lax"`, so a
 * browser will not attach it to a request aimed at a *different site*, and
 * `onrender.com` and `vercel.app` are public suffixes — every subdomain is
 * its own site. A frontend calling `farhand-api.onrender.com` directly would
 * log in to a `200` and be signed out on the next request, with nothing in
 * either log to explain it (docs/15-architecture.md found this while drawing
 * the map). Rewriting the API under `/api` means the browser only ever sees
 * one site, so Lax keeps protecting us and nothing has to be loosened.
 *
 * It is a proxy, so every browser request to `/api/...` costs a hop through
 * this app before it reaches the API. That is the price, and it is also why
 * the deploy issue has to re-measure the API's `trust proxy` hop count: this
 * app becomes another machine in front of it (#145).
 */
const api = process.env.FARHAND_API_URL ?? "https://farhand-api.onrender.com";

const nextConfig: NextConfig = {
  // Next asks for a promise here; there is nothing to wait for, so it is
  // resolved rather than written `async` with no `await` in it.
  rewrites: () =>
    Promise.resolve([
      {
        source: "/api/:path*",
        destination: `${api}/:path*`,
      },
    ]),
};

export default nextConfig;
