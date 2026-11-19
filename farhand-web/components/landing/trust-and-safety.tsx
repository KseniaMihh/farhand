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
 *  - "Honest reviews" — reviews are version 2. There are none.
 *    TODO: cut it, or replace it with something true today.
 *
 *  - "Clear rules" — TRUE. `docs/07-trust-and-safety.md` exists, and
 *    `GET /prohibited` serves the prohibited-items list the API enforces.
 *    TODO: it has no page to link to, so the rules are stated here or not
 *    claimed.
 *
 *  - "Real moderators" — the moderation API is built (#76–#78): reports, a
 *    queue, warn, suspend, ban, content hiding, an audit log. There are no
 *    moderator screens, so today "real moderators" means one person with
 *    database access.
 *    TODO: say what is true — that reports are read by a person — or cut it.
 *    "Real moderators" implies a team, and there is not one.
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
