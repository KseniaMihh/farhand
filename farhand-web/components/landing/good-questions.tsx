import { SECTIONS } from "@/lib/landing-links";

/**
 * The four questions anybody sensible asks — issue #168, drawn to the design
 * in #172.
 *
 * The design calls the section "Good questions", which is better than "FAQ"
 * because it is answering rather than deflecting.
 *
 * THE MASTHEAD STILL SAYS "FAQ" (#172), and the two are meant to differ. A
 * navigation bar is scanned rather than read, and "FAQ" is the word people
 * scan for; a heading is read, and has room to be warmer than the label that
 * pointed at it. If that ever stops being deliberate, the heading is the one
 * to change — the label is doing a job the heading is not.
 *
 * ONE LINE EACH, OPENING ON A CLICK — the design's accordion, and it reverses
 * what #168 wrote here. The argument then was that four short answers should
 * not be hidden behind a click, and it was a fair one when the questions were
 * long enough to be answers in themselves. The design's questions are not:
 * they are four lines a reader can take in at once and choose between, which
 * is a better way into the section than a wall of four paragraphs. THE FIRST
 * ONE IS OPEN, which is the half of the old argument worth keeping — nobody
 * should have to click to find out whether we hold their money.
 *
 * IT IS `<details>`, NOT STATE. No `"use client"`, no event handler, no
 * JavaScript at all: the open/closed toggle is the browser's, it works before
 * hydration and with scripting off, and the plus turning into a minus is one
 * CSS transform under `group-open`. A landing page is the last place to ship
 * a component tree to do what a browser already does.
 *
 * Each answer is checked against the product rather than the plan:
 *
 *  - PAYMENT. The design's wording, and it is accurate: the quote really is
 *    the three figures it names, and marking a deal paid really is a status
 *    on it (`docs/04-deal-lifecycle.md`). It is deliberately shorter than
 *    #168's answer, which also said that the helper does not buy until they
 *    have been paid — the one protection in version 1 that does not depend
 *    on us (`docs/07-trust-and-safety.md`). That sentence is worth putting
 *    back somewhere on this page if the answer ever grows again.
 *
 *  - POSTAGE. `docs/06-api-contract.md` has no shipping calculator anywhere
 *    in it, and `docs/04-deal-lifecycle.md` says `shippingActual` may differ
 *    from the estimate and that "the two settle it; Farhand only records it".
 *    "Farhand shows the difference" is a promise about a deal screen rather
 *    than about the API: both figures are on the deal, so the screen can
 *    subtract them, but nothing does today. It is the smallest outstanding
 *    thing on this page and the deal screen should honour it.
 *
 *  - WHAT IF IT GOES WRONG. There IS a dispute process, and the answer is
 *    two halves that have to be said together. Either side can dispute
 *    between `PRODUCT_PAID` and `SHIPPED`; that freezes the deal, and only a
 *    moderator can take it out of `DISPUTED`, with a resolution note on the
 *    record (#134). And: Farhand holds none of the money, so a resolution is
 *    a decision and a record, never a refund. The second half alone reads as
 *    a shrug; the first half alone is a promise we cannot keep.
 *
 *  - PROHIBITED ITEMS. `GET /prohibited-items` is public precisely so that
 *    "somebody deciding whether Farhand is any use to them should be able to
 *    read what it refuses to carry before they have an account". There is no
 *    page to link to yet, so the answer names the list instead of promising
 *    one — a "read the full list" link that goes nowhere is the thing
 *    `lib/landing-links.ts` exists to prevent.
 */
const QUESTIONS = [
  {
    question: "How does payment work?",
    answer:
      "You and the helper agree on a quote — product price, estimated postage and a thank-you. You pay the helper directly, using whatever you both choose, then mark it as paid on Farhand. Farhand never handles money.",
  },
  {
    question: "What if the actual postage is different?",
    answer:
      "When the helper ships, they enter the actual postage. Farhand shows the difference so you can settle it between you.",
  },
  {
    question: "What if something goes wrong?",
    answer:
      "Either side can dispute a deal from the moment the product is paid for until it ships. That freezes it, and only a moderator can end a dispute, with a note recorded against the deal. But because we hold none of the money, a resolution is a decision and a record — never a refund.",
  },
  {
    question: "What can’t I ask for?",
    answer:
      "The list is checked when a need is posted rather than after something goes wrong: weapons, drugs including prescription medicines, alcohol and tobacco, live animals, perishable food, hazardous goods, counterfeits, adult content, and anything needing an export licence or restricted by sanctions.",
  },
];

export function GoodQuestions() {
  return (
    <section id={SECTIONS.questions} className="scroll-mt-20 bg-cream">
      <div className="mx-auto max-w-column px-4 py-16 lg:py-20">
        <h2 className="font-serif text-page-title text-pine">Good questions</h2>

        <div className="mt-10 lg:mt-12">
          {QUESTIONS.map((item, index) => (
            /*
              `border-t` on every row rather than `border-b`: the design draws
              a rule above the first question and none below the last, so the
              lines read as separators between the questions instead of a box
              drawn around them.
            */
            <details
              key={item.question}
              open={index === 0}
              className="group border-t border-line"
            >
              <summary className="flex cursor-pointer list-none items-center justify-between gap-6 py-4 font-serif text-card-title text-pine [&::-webkit-details-marker]:hidden">
                {item.question}

                {/*
                  One plus that becomes a minus. The vertical stroke is
                  flattened to nothing when the row opens, so there is no
                  second icon to keep in step and nothing to get wrong — and
                  it is `aria-hidden` because <summary> already announces
                  expanded or collapsed on its own.
                */}
                <svg
                  viewBox="0 0 16 16"
                  aria-hidden="true"
                  className="h-4 w-4 shrink-0 stroke-pine"
                  strokeWidth="1.25"
                  strokeLinecap="round"
                >
                  <line x1="1" y1="8" x2="15" y2="8" />
                  <line
                    x1="8"
                    y1="1"
                    x2="8"
                    y2="15"
                    className="origin-center transition-transform duration-200 group-open:scale-y-0"
                  />
                </svg>
              </summary>

              <p className="max-w-[70ch] pb-5 text-body text-muted">
                {item.answer}
              </p>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}
