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
 * Worth recording that two obvious fixes were wrong. Raising the hop count to
 * four would have resolved one step FURTHER left, into the part of the header
 * a caller can write for themselves. Reading the rightmost entry of
 * `x-forwarded-for` reached production and delivered a Vercel address again,
 * because Vercel appends its own internal hop after the client's. Decision
 * 0029 says a count — and, it turns out, an end of a header — is a fact about
 * somebody else's infrastructure, to be measured rather than reasoned about.
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
   * WHICH HEADER THE PLATFORM VOUCHES FOR, rather than which end of
   * `x-forwarded-for` looks right.
   *
   * Two readings of that header have now been wrong on this platform. The
   * first copied it wholesale and forwarded a forgery; the second took the
   * rightmost entry — on the rule that a proxy appends, so the last entry is
   * the one the nearest proxy stands behind — and that reached production
   * and delivered a Vercel address again, a different one. Vercel appends
   * its own internal hop AFTER the client, so the rightmost entry is
   * Vercel's and the leftmost is the visitor's.
   *
   * The leftmost would therefore be right, and is not safe to take: it is
   * only the visitor's address if Vercel REPLACES a client-supplied header
   * rather than appending to it, and if it appends, the leftmost is whatever
   * the caller typed. Shipping that to find out would trade a shared rate
   * limit for a forgeable one, which is the worse of the two.
   *
   * So: one header, and only the one the platform RESERVES.
   * `x-vercel-forwarded-for` is in Vercel own namespace, which it strips from
   * anything a client sends, so a caller cannot put a value in it. It also
   * carries a single address rather than a chain to pick an end of.
   *
   * REJECTED: `x-real-ip` as a fallback. It was in this file for about ten
   * minutes and a local test forged it — a made-up address went straight to
   * the API. It is not a reserved name, so its safety rests entirely on
   * Vercel overwriting it, which is exactly the kind of assumption that has
   * been wrong twice here already. Having no address is a shared rate-limit
   * bucket, which is todays bug; having a forgeable one is worse than today.
   *
   * If the probe below says this header is absent in production, the next
   * thing to try is `ipAddress()` from `@vercel/functions` — the platform own
   * helper, which exists because this is hard to get right by hand.
   */
  const vouched = request.headers.get("x-vercel-forwarded-for");

  if (vouched !== null && vouched.trim() !== "") {
    // One address, already the visitor's. The API counts hops from its own
    // socket backwards, so this becomes the leftmost entry of the chain it
    // sees — which is where #145 expects to find a caller.
    headers.set("x-forwarded-for", vouched.trim());
  } else {
    // Nothing the platform stands behind, so claim nothing rather than
    // guessing at an end of `x-forwarded-for`. Whatever forwards this may
    // still add its own — Next's dev server puts the socket address in,
    // `::1` locally — and that is honest, because it was observed.
    headers.delete("x-forwarded-for");
  }

  /**
   * TEMPORARY, AND #163 REMOVES IT.
   *
   * Says which headers were available, never their values. The API logs every
   * request header, so this turns the next deploy into evidence instead of
   * another guess: if the address is still wrong, this says whether the
   * platform offered anything at all and how long the chain was.
   *
   * Names and a count only. An address in a log is the thing decision 0029's
   * runs are careful not to write down.
   */
  headers.set(
    "x-farhand-probe",
    [
      `real-ip=${request.headers.has("x-real-ip") ? "y" : "n"}`,
      `vercel-ffor=${request.headers.has("x-vercel-forwarded-for") ? "y" : "n"}`,
      `xff-entries=${String(
        (request.headers.get("x-forwarded-for") ?? "")
          .split(",")
          .filter((part) => part.trim() !== "").length,
      )}`,
      `used=${vouched !== null && vouched.trim() !== "" ? "platform" : "none"}`,
    ].join(" "),
  );

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
