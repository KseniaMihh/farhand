import Link from "next/link";

/**
 * Screen 1.5's "not found", and the place the header's forward links land.
 *
 * The header draws the whole product on one line — Needs, Offers, My needs,
 * My offers, Proposals, Deals, Inbox — and five of those screens are not
 * built. Without this, a click lands on the framework's own error page, which
 * says "404" in a typeface that is not ours and gives nobody a way back.
 *
 * It does NOT say "coming soon". Every real 404 — a deleted need, a mistyped
 * address, an old link out of somebody's inbox — arrives here too, and a page
 * that promises a feature is wrong for all of them. "We could not find it,
 * here is the way back" is true in every case.
 *
 * No header, because the root layout holds only the session: the furniture
 * belongs to `(site)`, and a not-found outside it has none. That is a fair
 * trade for a page whose job is one sentence and one link.
 */
export default function NotFound() {
  return (
    <main className="notfound">
      <p className="notfound-mark" aria-hidden="true">
        ✉
      </p>
      <h1 className="notfound-title">We couldn’t find that page</h1>
      <p className="notfound-line">
        It may have been closed, or the address may be wrong. Nothing has gone
        missing from your account.
      </p>
      <p>
        <Link className="btn btn-primary" href="/">
          Browse needs
        </Link>
      </p>
    </main>
  );
}
