/**
 * The two cards hanging off the corner of the hero photograph — issue #168,
 * drawn to the design in #172.
 *
 * THESE ARE ILLUSTRATIONS, AND THEY NOW SHOW THE DESIGN IN FULL. Showing what
 * a listing looks like is the fastest way to explain the product, and a
 * picture of one is what this is.
 *
 * An earlier version of this file held three things back — a visible
 * "Example" chip on each card, the requester's city, and the helper's star
 * rating. All three are here now, and the reversal is Ksenia's with her
 * reason: these cards carry nothing a visitor would act on. Nobody can click
 * them, nothing leads anywhere from them, and they sit in a hero rather than
 * in a list, so there is no decision for the detail on them to mislead.
 *
 * **Neither is a link and neither sits in anything shaped like a list.** That
 * is what is now doing the work, so keep both true. The testimonials further
 * down the page were cut for the neighbouring reason — those were quotes
 * attributed to people, which is a claim; a sample card is furniture.
 *
 * BUILT IN MARKUP, NOT PLACED AS THE PNG EXPORTS. The exports are 380x192 and
 * 480x256 at 1x, so they are soft on any modern screen; their text is
 * invisible to a screen reader and to search; and they would keep the palette
 * they were exported with while `globals.css` moved on. They remain the
 * reference these were built against.
 *
 * DO NOT READ THIS FILE AS A SPECIFICATION FOR THE REAL CARD. It is the one
 * way these could still mislead, and the reader at risk is the next developer
 * rather than a visitor:
 *
 *  - "Kadri · Tallinn" shows a CITY. The product does not, ever, to anybody
 *    but its owner — `components/need-card.tsx` says so in capitals, and
 *    `docs/07-trust-and-safety.md` is why: a city beside a name is often
 *    enough to find a real person. A real need card shows two countries.
 *
 *  - "★ 5.0 (4)" is an invented average. Ratings are real and come from
 *    reviews on completed deals, blind until both sides have written
 *    (decision 0017) — not from a number typed into a component.
 *
 * Whoever builds the helper profile or the offers list takes those shapes
 * from the API contract, not from here.
 *
 * A HAIRLINE AND A DEEP SHADOW. The border is pine at 12% rather than
 * `--color-line`, which is the same colour at 16%: over a photograph the
 * stock line reads as a cut-out edge, and four points lighter is enough to
 * hold the card's shape without drawing one. The shadow is deeper than the
 * list's cards for the same reason — these float over a picture rather than
 * sitting in a grid, and the shadow is what says so.
 */

const CARD =
  "rounded-xl border border-pine/12 bg-card p-4 shadow-[0_18px_40px_rgb(31_59_52/0.18)]";

export function ExampleCards() {
  return (
    <div className="relative z-10 mx-auto grid max-w-column gap-4 px-4 pb-14 lg:absolute lg:top-[60%] lg:right-[11%] lg:block lg:w-138 lg:px-0 lg:pb-0">
      {/* A need, as the list draws one. */}
      <article className={`${CARD} lg:w-[20rem]`}>
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <span className="rounded bg-pine px-2 py-0.5 text-badge tracking-[0.06em] text-cream uppercase">
              Need
            </span>
            {/* The name without the city, for the reason at the top. */}
            <span className="text-caption text-muted">Kadri · Tallinn</span>
          </div>
        </div>

        <h2 className="mt-3 font-serif text-card-title text-pine">
          Japanese sunscreen, 50 ml
        </h2>

        <div className="mt-2 flex items-baseline justify-between gap-3">
          {/* Codes rather than names, as the design has them: this card is
              small and "Japan → Estonia" is the list's job, not the
              illustration's. */}
          <span className="text-caption text-muted">JP → EE</span>
        </div>
      </article>

      {/* An offer, as a helper writes one. */}
      <article className={`${CARD} lg:-mt-9 lg:ml-30 lg:w-104`}>
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
              <p className="text-caption text-muted">
                Lives in Japan · ★ 5.0 (4)
              </p>
            </div>
          </div>

          <div className="flex flex-none items-center gap-2">
            <span className="rounded bg-offer-tint px-2 py-0.5 text-badge tracking-[0.06em] text-offer-ink font-bold uppercase">
              Offer
            </span>
          </div>
        </div>

        <p className="mt-3 text-body text-pine">
          Osaka. Uniqlo Japan-only lines, kitchen knives from Doguyasuji,
          ceramics. Careful packer.
        </p>

        <p className="mt-3 text-body font-bold text-terracotta">
          Ships to: Anywhere
        </p>
      </article>
    </div>
  );
}
