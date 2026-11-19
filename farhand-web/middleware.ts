import { NextResponse, type NextRequest } from "next/server";
import { applyVouch } from "@/lib/vouched-caller";

/**
 * The API under our own address, and the visitor's address stated plainly
 * (#152, #164).
 *
 * WHY THIS FILE PROXIES AT ALL. The browser has to see one site, so the
 * `sameSite: "lax"` session cookie survives — decision 0031. A rewrite
 * declared in `next.config.ts` would do the same job, and did, until it was
 * measured: that one is performed by Vercel's routing layer, which makes the
 * outbound request **as though it were the client**. `next.config.ts` is
 * deliberately empty and says so (decision 0034).
 *
 * WHY THE ADDRESS TRAVELS UNDER A NAME OF OURS. Three deploys tried to put
 * the visitor back into `x-forwarded-for` and all three failed, for one
 * reason that took three rounds to see: the value was right and the API's hop
 * count was reading one entry past it. This middleware is a fourth machine in
 * front of the API, so the chain it receives is four long where a direct one
 * is three, and no count can be correct for both — raising it would resolve a
 * forgery on the direct path instead.
 *
 * The rule itself, and the argument for the entry it picks, is in
 * `lib/vouched-caller.ts`. The measurements are in decision 0035.
 *
 * vouched caller: see docs/10-decisions/0035-the-frontend-states-the-caller.md
 */

const API = process.env.FARHAND_API_URL ?? "https://farhand-api.onrender.com";

export function middleware(request: NextRequest) {
  const url = new URL(request.url);
  // `/api/needs` → `${API}/needs`, query and all.
  const destination = new URL(
    url.pathname.replace(/^\/api/, "") + url.search,
    API,
  );

  const headers = new Headers(request.headers);

  // Read here rather than at module scope only because it reads better beside
  // the call. Next inlines `process.env` into the edge bundle at BUILD time
  // either way, which is why rotating this secret needs a redeploy of this
  // side and not just a dashboard save — decision 0035 has the order to do it
  // in.
  applyVouch(
    headers,
    request.headers.get("x-forwarded-for"),
    process.env.PROXY_VOUCH_SECRET,
  );

  // `x-forwarded-for` itself is deliberately left exactly as it arrives.
  // Three attempts at rewriting it are what #164 is for, and the API no
  // longer needs it on this path — it counts hops only for requests that come
  // to it directly. Leaving it alone also keeps the chain honest about who
  // connected to what, which is worth more than a guess at the caller.

  return NextResponse.rewrite(destination, { request: { headers } });
}

/**
 * Only the proxied calls. Everything else — pages, the fonts next/font
 * self-hosts, Next's own assets — must not pay for a middleware invocation,
 * and has no reason to be rewritten anywhere.
 */
export const config = {
  matcher: "/api/:path*",
};
