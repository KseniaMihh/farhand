import { SECTIONS } from "@/lib/landing-links";

/**
 * The five steps — issue #168, drawn to the design in #172.
 *
 * This is the deal lifecycle told as a story, and
 * `docs/04-deal-lifecycle.md` is the authority: if the five steps here and
 * the status table there ever disagree, the table is right.
 *
 * THE COPY IS THE DESIGN'S, UNCHANGED, because every line of it survived the
 * check — including the two that looked like claims about a future product
 * and are not. "You see their profile and reviews" is true (#83–#84). "You
 * both leave a review, shown once both are written" is exactly decision
 * 0017: blind until both are in, or until the fourteen-day window closes.
 * "Pay them directly" is true in the strongest sense — there is nowhere else
 * for the money to go.
 *
 * The `id` is read from `SECTIONS` rather than typed, because the masthead
 * jumps to it and a renamed id is a dead link that nothing catches.
 */
const STEPS = [
  {
    title: "Post a need",
    text: "Say what you want, where it’s sold, and where it should go. Add an estimated price and a thank-you.",
  },
  {
    title: "A helper offers",
    text: "Someone who lives in that country offers to help. You see their profile and reviews, then accept one.",
  },
  {
    title: "Agree a quote",
    text: "The helper confirms the product price and postage. You agree, and pay them directly.",
  },
  {
    title: "Buy and ship",
    text: "The helper buys it, adds receipts, and posts it with a tracking number.",
  },
  {
    title: "Deliver, review",
    text: "You confirm it arrived. You both leave a review, shown once both are written.",
  },
];

export function HowItWorks() {
  return (
    <section id={SECTIONS.howItWorks} className="scroll-mt-20 bg-cream">
      <div className="mx-auto max-w-column px-4 py-16 lg:py-20">
        <p className="text-label tracking-[0.12em] text-muted uppercase">
          How it works
        </p>
        <h2 className="mt-2 font-serif text-page-title text-pine">
          From “I need this” to a parcel at your door
        </h2>

        {/* An ordered list, because the numbers ARE the content: step four
            before step three is a different product. */}
        <ol className="mt-10 space-y-3">
          {STEPS.map((step, index) => (
            <li
              key={step.title}
              className="grid items-center gap-4 lg:grid-cols-[15rem_1fr] lg:gap-8"
            >
              {/*
                THE NUMBER SITS ON THE FLOOR OF THE CARD, which is `items-end`
                plus the tight leading below — and the leading is the half
                that is easy to miss. A line box is a whole em tall while the
                digit inside it is about two thirds of that, so at this size
                `leading-none` would still leave the digit floating a visible
                distance above the card's bottom edge, and no amount of
                padding fixes that without moving the title too. Squeezing the
                box down to roughly the height of the digit is what puts the
                two edges together.

                It also means the CARD'S HEIGHT FOLLOWS THE NUMBER rather than
                the title, so making the number bigger makes the card taller
                on its own. That is the honest behaviour: the number is the
                tallest thing in there.
              */}
              <div className="flex items-end gap-3 rounded-lg border border-pine bg-card px-4 pt-3">
                <span
                  className="font-serif text-[54px] leading-[0.72] text-pine/30"
                  aria-hidden="true"
                >
                  {index + 1}
                </span>
                {/*
                  Its baseline lands above the number's, which is the design
                  and is not a correction waiting to happen: both boxes end
                  together, and a 20px line has far less room under its
                  baseline than a 64px one does.
                */}
                <span className="font-serif text-card-title text-pine">
                  {step.title}
                </span>
              </div>

              <p className="self-end font-serif text-[16px]/[26px] text-pine">
                {step.text}
              </p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
