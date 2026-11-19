import Link from "next/link";

/**
 * A need that is not there, or not yours to see — issue #166.
 *
 * INSIDE THE SITE CHROME, which is why it is here and not left to the root
 * `app/not-found.tsx`. Somebody who followed a link to a need is in the
 * middle of the product, and dropping them onto a bare page with no header
 * takes away the way out. The root one stays where it is, for a URL that
 * matches nothing at all.
 *
 * It must not say which of the two happened. `GET /needs/:id` answers `404`
 * rather than `403` for a draft precisely so that trying ids reveals nothing,
 * and a page saying "you are not allowed to see this one" would hand back
 * what the API just refused to say. The wording names both possibilities and
 * promises neither.
 *
 * Reached from a client component calling `notFound()` during render, which
 * was checked in a browser before anything was built on it: called from the
 * effect instead, after the page has already rendered, it does nothing.
 */
export default function NeedNotFound() {
  return (
    <section className="rounded-xl border border-line bg-card p-10 text-center">
      <h1 className="font-serif text-2xl text-pine">
        We cannot find that need
      </h1>
      <p className="mt-3 text-muted">
        The link may be old, or the need was closed or removed.
      </p>
      <p className="mt-6">
        <Link href="/needs" className="btn btn-secondary no-underline">
          Browse what people need
        </Link>
      </p>
    </section>
  );
}
