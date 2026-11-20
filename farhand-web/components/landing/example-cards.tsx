/**
 * The two cards hanging off the corner of the hero photograph — issue #168,
 * drawn to the design in #172.
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
 * invisible to a screen reader and to search; and they would keep the palette
 * they were exported with while `globals.css` moved on. They remain the
 * reference these were built against.
 *
 * TWO THINGS THE DESIGN DRAWS THAT ARE DELIBERATELY NOT HERE, and both were
 * agreed before the first version of this file:
 *
 *  1. The need card reads "Kadri · Tallinn". The product never shows a city
 *     to anybody but its owner — `components/need-card.tsx` says so in
 *     capitals and `docs/07-trust-and-safety.md` is why: a city beside a name
 *     is often enough to find a real person. An example card advertising one
 *     would advertise a privacy behaviour we deliberately do not have.
 *
 *  2. The offer card reads "★ 5.0 (4)". Ratings are real — reviews shipped in
 *     version 2 — and the star still comes off, for the reason the
 *     testimonials came off the page: an invented five-star average beside an
 *     invented name is a testimonial in miniature. A real helper's card shows
 *     their rating; this one shows what they can get.
 *
 * NO BORDER AND A DEEPER SHADOW than the cards in the product list, which is
 * the design's own distinction: these float over a photograph rather than
 * sitting in a grid, and a border on a card over a picture reads as a cut-out.
 */
function Example() {
  return (
    <span className="rounded-full bg-pine/10 px-2 py-0.5 text-badge tracking-[0.06em] text-muted uppercase">
      Example
    </span>
  );
}

const CARD = "rounded-xl bg-card p-4 shadow-[0_18px_40px_rgb(31_59_52/0.18)]";

export function ExampleCards() {
  return (
    <div className="relative z-10 mx-auto grid max-w-column gap-4 px-4 pb-14 lg:absolute lg:top-[60%] lg:right-[6%] lg:block lg:w-[34.5rem] lg:px-0 lg:pb-0">
      {/* A need, as the list draws one. */}
      <article className={`${CARD} lg:w-[20rem]`}>
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <span className="rounded bg-pine px-2 py-0.5 text-badge tracking-[0.06em] text-cream uppercase">
              Need
            </span>
            {/* The name without the city, for the reason at the top. */}
            <span className="text-caption text-muted">Kadri</span>
          </div>
          <Example />
        </div>

        <h2 className="mt-3 font-serif text-card-title text-pine">
          Japanese sunscreen, 50 ml
        </h2>

        <div className="mt-2 flex items-baseline justify-between gap-3">
          {/* Codes rather than names, as the design has them: this card is
              small and "Japan → Estonia" is the list's job, not the
              illustration's. */}
          <span className="text-caption text-muted">JP → EE</span>
          <span className="font-serif text-xl text-pine">€24.00</span>
        </div>
      </article>

      {/* An offer, as a helper writes one. */}
      <article className={`${CARD} lg:-mt-6 lg:ml-32 lg:w-[26rem]`}>
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2.5">
            {/*
              Not the `.avatar` class. That one is sage with pine text and
              carries its contrast ratio with it, and an offer is terracotta
              everywhere else in the product — the colour is the code the
              page teaches two sections further down.
            */}
            <span
              className="inline-flex h-9 w-9 flex-none items-center justify-center rounded-full bg-offer-tint font-serif text-card-title text-offer-ink"
              aria-hidden="true"
            >
              A
            </span>
            <div>
              <p className="font-serif text-card-title text-pine">Aiko</p>
              {/* No rating, for the reason at the top. */}
              <p className="text-caption text-muted">Lives in Japan</p>
            </div>
          </div>

          <div className="flex flex-none items-center gap-2">
            <Example />
            <span className="rounded bg-offer-tint px-2 py-0.5 text-badge tracking-[0.06em] text-offer-ink uppercase">
              Offer
            </span>
          </div>
        </div>

        <p className="mt-3 text-body text-pine">
          Osaka. Uniqlo Japan-only lines, kitchen knives from Doguyasuji,
          ceramics. Careful packer.
        </p>

        <p className="mt-3 text-body text-terracotta">Ships to: Anywhere</p>
      </article>
    </div>
  );
}
