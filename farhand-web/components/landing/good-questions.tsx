/**
 * The four questions anybody sensible asks — issue #168.
 *
 * Postage · payment · what if it goes wrong · what may not be sent. The
 * design calls the section "Good questions", which is better than "FAQ"
 * because it is answering rather than deflecting.
 *
 * EACH ANSWER IS CHECKED AGAINST THE PRODUCT, not against the plan:
 *
 *  - POSTAGE. True today, and the answer is in the data model: a quote is an
 *    amount the two of them agree, and `docs/06-api-contract.md` has no
 *    shipping calculator anywhere in it. The honest answer is that the
 *    helper quotes what it costs them and you accept or you do not.
 *
 *  - PAYMENT. True today, strongest answer on the page: Farhand never holds
 *    the money, so there is nothing to lose to Farhand.
 *
 *  - WHAT IF IT GOES WRONG. There IS a dispute process, and the answer is
 *    two halves that have to be said together. Either side can dispute a
 *    deal between `PRODUCT_PAID` and `SHIPPED`; that freezes it, and only a
 *    moderator can take it out of `DISPUTED`, with a resolution note on the
 *    record (`docs/04-deal-lifecycle.md`, #134). And: Farhand holds none of
 *    the money, so a resolution is a decision and a record, never a refund —
 *    the same document's edge cases say it plainly, "Farhand records; it
 *    does not compensate".
 *    TODO: both halves, in that order. The second one alone reads as a
 *    shrug; the first one alone is a promise we cannot keep.
 *
 *  - PROHIBITED ITEMS. `GET /prohibited` exists and the API enforces the
 *    list, so the claim is true. The acknowledgement flow is version 2 and
 *    there is no page to link to.
 *    TODO: the short version of the list goes in the answer, or this
 *    question waits for its page. A "read the full list" link that goes
 *    nowhere is the thing `lib/landing-links.ts` exists to prevent.
 */
export function GoodQuestions() {
  return (
    <section>
      {/* TODO: four questions. Plain headings and paragraphs rather than
          <details>: there are four, they are short, and nobody should have
          to click to find out whether we hold their money. */}
      <h2>Good questions</h2>
    </section>
  );
}
