import { SECTIONS } from "@/lib/landing-links";

/**
 * The four questions anybody sensible asks — issue #168.
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
 * Each answer is checked against the product rather than the plan:
 *
 *  - POSTAGE. `docs/06-api-contract.md` has no shipping calculator anywhere
 *    in it, and `docs/04-deal-lifecycle.md` says `shippingActual` may differ
 *    from the estimate and that "the two settle it; Farhand only records it".
 *
 *  - PAYMENT. The strongest answer on the page, and the only protection in
 *    version 1 that does not depend on us: the helper does not buy until
 *    they have been paid (`docs/07-trust-and-safety.md`).
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
    question: "Who pays the postage?",
    answer:
      "You do, as part of the quote. The helper confirms the product price and the postage together before buying anything, and you agree to both at once. If the real postage comes out higher than the estimate, the difference is recorded and the two of you settle it — Farhand only writes it down.",
  },
  {
    question: "How does the money move?",
    answer:
      "Directly between you, by whatever means you both already use. There is no wallet, no escrow and no card on file. The helper does not buy anything until they have been paid, which is the one protection here that does not depend on us.",
  },
  {
    question: "What if something goes wrong?",
    answer:
      "Either side can dispute a deal from the moment the product is paid for until it ships. That freezes it, and only a moderator can end a dispute, with a note recorded against the deal. But because we hold none of the money, a resolution is a decision and a record — never a refund.",
  },
  {
    question: "Is there anything that can’t be sent?",
    answer:
      "Yes, and the list is checked when a need is posted rather than after something goes wrong: weapons, drugs including prescription medicines, alcohol and tobacco, live animals, perishable food, hazardous goods, counterfeits, adult content, and anything needing an export licence or restricted by sanctions.",
  },
];

export function GoodQuestions() {
  return (
    <section id={SECTIONS.questions} className="scroll-mt-20 bg-cream">
      <div className="mx-auto max-w-column px-4 py-16 lg:py-20">
        <h2 className="font-serif text-page-title text-pine">Good questions</h2>

        {/*
          Headings and paragraphs rather than <details>: there are four, they
          are short, and nobody should have to click to find out whether we
          hold their money.
        */}
        <dl className="mt-10 grid gap-x-12 gap-y-9 lg:grid-cols-2">
          {QUESTIONS.map((item) => (
            <div key={item.question}>
              <dt className="font-serif text-heading text-pine">
                {item.question}
              </dt>
              <dd className="mt-2 max-w-[58ch] text-body text-muted">
                {item.answer}
              </dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}
