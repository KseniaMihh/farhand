import { SECTIONS } from "@/lib/landing-links";

/**
 * The five steps — issue #168.
 *
 * Post a need · A helper offers · Agree a quote · Buy and ship · Deliver and
 * review. This is the deal lifecycle told as a story, and
 * `docs/04-deal-lifecycle.md` is the authority: if the five steps here and
 * the status table there ever disagree, the table is right.
 *
 * THE LAST STEP KEEPS ITS REVIEW. Reviews are built (#83–#84), and the step
 * should say when one may be written rather than implying it is a free
 * comment box: after the deal completes, by either side, within fourteen
 * days — and blind until both are in.
 *
 * TODO: five steps is already a lot of words for a landing page, so the
 * qualification belongs in the step's sentence, not as a fourth clause.
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
