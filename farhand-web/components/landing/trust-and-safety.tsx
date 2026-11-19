import Image from "next/image";
import trust from "@/images/trust_safety.webp";
import { SECTIONS } from "@/lib/landing-links";

/**
 * Why this is not a stranger taking your money — issue #168.
 *
 * "FARHAND NEVER TOUCHES YOUR MONEY" is the strongest line on the page and
 * it is completely true: there is no payment integration, by decision, and
 * `docs/08-scope.md` lists holding money as a version 3 idea. The two people
 * agree an amount and settle it between themselves.
 *
 * THE OTHER THREE CLAIMS NEEDED CHECKING, and this is where every difference
 * between the design's copy and the product turned out to be:
 *
 *  - "Honest reviews" — TRUE, and worth saying precisely rather than as a
 *    slogan, because the precision is the reassurance. A review can only be
 *    written after a deal completes, so nobody can review a stranger they
 *    never dealt with; and neither side sees the other's until both have
 *    written or the fourteen-day window closes, so a review cannot be
 *    retaliation for the one you just read (decision 0017, #83–#84).
 *    TODO: write that as one sentence a person would read.
 *
 *  - "Clear rules" — TRUE. `docs/07-trust-and-safety.md` exists, and
 *    `GET /prohibited` serves the prohibited-items list the API enforces.
 *    TODO: it has no page to link to, so the rules are stated here or not
 *    claimed.
 *
 *  - "Real moderators" — the moderation API is built (#76–#78): reports, a
 *    queue, warn, suspend, ban, content hiding, an audit log. There are no
 *    moderator screens, so today this is one person with database access.
 *    "Real moderators" implies a team and there is not one; what is true is
 *    that a person reads every report.
 *    TODO: "A person reviews every report", or words to that effect.
 */
export function TrustAndSafety() {
  return (
    <section id={SECTIONS.trust}>
      {/* TODO: the eyebrow, the heading, the money line, three points. */}
      <h2>Trust &amp; safety</h2>

      {/* TODO: alt text. This one is a person labelling a parcel, which is
          the product's own subject — it may deserve real alt text rather
          than the empty string a decorative photograph gets. */}
      <Image src={trust} alt="" />
    </section>
  );
}
