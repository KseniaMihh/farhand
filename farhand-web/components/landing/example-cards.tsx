/**
 * The two cards floating over the hero photograph — issue #168.
 *
 * THESE ARE ILLUSTRATIONS AND MUST READ AS ILLUSTRATIONS. Showing what a
 * listing looks like is the fastest way to explain the product, and a made-up
 * listing presented as a real one is the same mistake as the testimonials
 * that were cut from this page. So: each card carries a visible "Example",
 * neither is a link, and neither sits in anything that looks like a list of
 * real needs.
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
 *     capitals and `docs/07-trust-and-safety.md` is why: a city beside a name
 *     is often enough to find a real person. An example card advertising one
 *     would advertise a privacy behaviour we deliberately do not have.
 *
 *  2. The offer card reads "★ 5.0 (4)". Ratings are real — reviews are built
 *     (#83–#84) — and the star still comes off, for the reason the
 *     testimonials came off the page: an invented five-star average beside an
 *     invented name is a testimonial in miniature. A real helper's card shows
 *     their rating; this one shows what they can get.
 */
function Example() {
  return (
    <span className="rounded-full bg-pine/10 px-2 py-0.5 text-badge tracking-[0.08em] text-muted uppercase">
      Example
    </span>
  );
}

export function ExampleCards() {
  return (
    <div className="mt-6 flex flex-col gap-3 lg:absolute lg:-bottom-8 lg:-left-14 lg:mt-0 lg:w-[19rem]">
      {/* A need, as the list draws one. */}
      <article className="rounded-xl border border-line bg-card p-4 shadow-[0_12px_30px_rgb(31_59_52/0.14)]">
        <div className="flex items-center justify-between gap-3">
          <span className="rounded bg-need-tint px-2 py-0.5 text-badge tracking-[0.08em] text-need-ink uppercase">
            Need
          </span>
          <Example />
        </div>

        <h2 className="mt-3 font-serif text-card-title text-pine">
          Japanese sunscreen, 50 ml
        </h2>

        <div className="mt-2 flex items-baseline justify-between gap-3">
          <p className="text-caption text-muted">Japan → Estonia</p>
          <p className="font-serif text-xl text-pine">€24.00</p>
        </div>
      </article>

      {/* An offer, as a helper writes one. */}
      <article className="rounded-xl border border-line bg-card p-4 shadow-[0_12px_30px_rgb(31_59_52/0.14)] lg:ml-16">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <span className="avatar" aria-hidden="true">
              A
            </span>
            <div>
              <p className="text-card-title text-pine">Aiko</p>
              <p className="text-caption whitespace-nowrap text-muted">
                Lives in Japan
              </p>
            </div>
          </div>
          <Example />
        </div>

        <p className="mt-3 text-body text-pine">
          Uniqlo lines sold only here, kitchen knives, ceramics. Careful packer.
        </p>

        <p className="mt-2 text-caption text-terracotta">Ships anywhere</p>
      </article>
    </div>
  );
}
