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
 *  - WHAT IF IT GOES WRONG. The thin one. There is a deal lifecycle with a
 *    cancelled state and an event log, and there is a reporting and
 *    moderation flow. There is no dispute process, no refunds, no
 *    arbitration — Farhand holds no money, so it has nothing to refund with.
 *    TODO: write the answer that says this plainly. It is less reassuring
 *    than the design's, and it is the answer that keeps the page honest.
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
