import { SECTIONS } from "@/lib/landing-links";

/**
 * The five steps — issue #168.
 *
 * Post a need · A helper offers · Agree a quote · Buy and ship · Deliver and
 * review. This is the deal lifecycle told as a story, and
 * `docs/04-deal-lifecycle.md` is the authority: if the five steps here and
 * the status table there ever disagree, the table is right.
 *
 * THE LAST STEP SAYS "REVIEW" AND REVIEWS ARE VERSION 2 (`docs/08-scope.md`).
 * TODO: either the step ends at delivery, or it names the review as
 * something that happens after the deal is marked complete — which is what
 * the product does today, minus the review itself. Decide and write the
 * reason here.
 *
 * The `id` is read from `SECTIONS` rather than typed, because the masthead
 * jumps to it and a renamed id is a dead link that nothing catches.
 */
export function HowItWorks() {
  return (
    <section id={SECTIONS.howItWorks}>
      {/* TODO: the eyebrow "How it works", the heading, and the five steps
          as an ordered list — the numbers are the content, not decoration,
          so this is an <ol>. */}
      <h2>How it works</h2>
      <ol>
        <li>Post a need</li>
        <li>A helper offers</li>
        <li>Agree a quote</li>
        <li>Buy and ship</li>
        <li>Deliver</li>
      </ol>
    </section>
  );
}
