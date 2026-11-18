import { NextResponse, type NextRequest } from "next/server";

/**
 * Put the visitor's address back into the chain (#152).
 *
 * THE MEASUREMENT THAT MADE THIS NECESSARY. A rewrite declared in
 * next.config.ts is performed by Vercel's routing layer, and that layer makes
 * the outbound request **as though it were the client**: the first deploy put
 * three entries in `X-Forwarded-For` with Vercel's own address leftmost and
 * the visitor's nowhere at all. Not under another name either — no
 * `x-vercel-forwarded-for`, no `x-real-ip`.
 *
 * The API resolves a caller by counting three hops back from its socket
 * (#145, decision 0029), so it clamped to the leftmost entry and believed
 * Vercel. Every visitor would have shared one rate-limit bucket: ten people
 * signing in from ten countries exhausting a limit meant for one, with a
 * symptom — "signing in sometimes says too many attempts" — that looks
 * nothing like its cause.
 *
 * Worth recording that the obvious fix was wrong. The chain looked one short,
 * so raising the hop count to four was the plausible answer; it would have
 * resolved one step FURTHER left, into the part of the header a caller can
 * write for themselves. Decision 0029 says a count is a fact about somebody
 * else's infrastructure and has to be measured. It was, and it said something
 * different from the story.
 *
 * WHY MIDDLEWARE RATHER THAN A ROUTE HANDLER. #152 wrote down a catch-all
 * proxy at `app/api/[...path]/route.ts` as the fallback. This is smaller and
 * keeps more of the platform's own behaviour: the body still streams, a `302`
 * from `GET /files/:id` still passes through untouched, and `Set-Cookie` is
 * not something this app has to hand-copy — which matters more here than
 * usual, because the session cookie is the thing decision 0031 exists to
 * protect. The handler stays written down as the escalation if this does not
 * survive its own measurement.
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

  /**
   * SET, NEVER APPEND. Vercel fills `x-forwarded-for` on the way IN to this
   * function with the address it saw, which is the visitor's. Forwarding that
   * value wholesale is what puts the visitor back at the left of the chain.
   *
   * Appending to whatever the caller sent would hand an attacker the ability
   * to lengthen the chain and shift which entry the API's count lands on —
   * the exact attack the count protects against by reading from the right.
   * Overwriting leaves nothing of theirs in it.
   */
  const seen = request.headers.get("x-forwarded-for");
  // THE RIGHTMOST ENTRY, not the whole header. A proxy APPENDS the address it
  // saw, so the last entry is the one the nearest proxy vouches for and
  // everything to its left is whatever the caller chose to write. Copying the
  // header wholesale forwards the forgery — which a local test did, with a
  // made-up address sailing through to the API.
  //
  // This holds whichever way Vercel behaves: if it replaces the header there
  // is one entry and it is the right one; if it appends, the one it appended
  // is last. The same reading as the API own count, for the same reason.
  const vouched = seen?.split(",").pop()?.trim();

  if (vouched !== undefined && vouched !== "") {
    headers.set("x-forwarded-for", vouched);
  } else {
    // Nothing vouched for it, so claim nothing. Whatever is forwarding may
    // still add its own — Next's dev server puts the socket address in, which
    // is `::1` locally — and that is correct, because it is the one address
    // that was actually observed rather than asserted.
    headers.delete("x-forwarded-for");
  }

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
