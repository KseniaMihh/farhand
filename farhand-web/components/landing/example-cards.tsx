/**
 * The two cards floating over the hero photograph — issue #168.
 *
 * THESE ARE ILLUSTRATIONS AND MUST READ AS ILLUSTRATIONS. Showing what a
 * listing looks like is the fastest way to explain the product, and a made-up
 * listing presented as a real one is the same mistake as the testimonials
 * that were cut from this page. So: each card carries a visible "Example",
 * neither is a link, and neither is a `<li>` in anything that looks like a
 * list of real needs.
 *
 * BUILT IN MARKUP, NOT PLACED AS THE PNG EXPORTS. The exports are 380x192 and
 * 480x256 at 1x, so they are soft on any modern screen; their text is
 * invisible to a screen reader and to search; and they would keep the
 * palette they were exported with while `globals.css` moved on. They remain
 * the reference these were built against.
 *
 * TWO THINGS THE DESIGN SHOWS THAT THE PRODUCT DOES NOT DO, both found while
 * transcribing the cards, and both changed here:
 *
 *  1. The need card reads "Kadri · Tallinn". The product never shows a city
 *     to anybody but its owner — `components/need-card.tsx` says so in
 *     capitals and `docs/07-trust-and-safety.md` is why. An example card
 *     advertising a city would be advertising a privacy behaviour we
 *     deliberately do not have. It shows the country.
 *
 *  2. The offer card reads "★ 5.0 (4)". Reviews and ratings are version 2
 *     (`docs/08-scope.md`), so there is no star anywhere in the product. The
 *     card says what a helper actually has today.
 *
 * TODO: settle whether "Kadri" and "Aiko" stay as names at all. They are
 * invented people, which is fine on a card marked Example, and the
 * alternative — "A helper in Japan" — says the same thing without inventing
 * anybody.
 */
export function ExampleCards() {
  return (
    <div aria-label="What a need and an offer look like">
      {/* TODO: the need card — NEED badge, name, country, title, JP → EE,
          the price in the serif face. No city. */}
      <article>
        <p>Example</p>
      </article>

      {/* TODO: the offer card — avatar, name, "Lives in Japan", what they
          can get, "Ships to: Anywhere". No rating. */}
      <article>
        <p>Example</p>
      </article>
    </div>
  );
}
