import Image from "next/image";
import trust from "@/images/trust_safety.webp";
import { SECTIONS } from "@/lib/landing-links";

/**
 * Why this is not a stranger taking your money — issue #168, drawn to the
 * design in #172.
 *
 * "FARHAND NEVER TOUCHES YOUR MONEY. IT KEEPS THE RECORD." is the strongest
 * line on the page and both halves are true. There is no payment
 * integration, by decision, and `docs/08-scope.md` lists holding money as a
 * version 3 idea. The second half is `DealEvent`: every status change is a
 * row with an actor and a time, and the design's second card is what makes
 * the headline a statement of fact rather than a slogan.
 *
 * EACH OF THE SIX WAS CHECKED AGAINST THE API BEFORE IT WAS WRITTEN, because
 * this is the section where being approximately right is worse than saying
 * less. Five came through clean. The fifth did not, and ships anyway — read
 * its entry below before changing anything else in this file.
 *
 *  - No middleman — TRUE. There is nowhere else for the money to go.
 *
 *  - Every step on record — TRUE, and precisely as worded. `DealEvent` is
 *    append-only: `GET /deals/:id/events` serves them oldest first, and the
 *    contract offers no way to change one after the fact.
 *
 *  - Receipts that stay — TRUE, and stronger than it sounds. PDFs really are
 *    accepted alongside images (06-api-contract.md, the file rules table).
 *    There is no delete: decision 0016 makes a receipt evidence in somebody
 *    else's dispute, so a wrong one is followed by a right one and both
 *    stay, and even `DELETE /me` keeps them.
 *
 *  - Honest reviews — TRUE, decision 0017. Blind until both are in or the
 *    fourteen days run out.
 *
 *  - "Real moderators" / "one click" — THE DESIGN'S WORDING, KEPT ON PURPOSE
 *    AND NOT TRUE YET. Both halves overstate what exists, and the decision
 *    to ship them anyway was Ksenia's with this written down in front of
 *    her, so nobody should quietly "correct" them later — change them when
 *    the product catches up, or ask her.
 *
 *    "Real moderators" is plural. The moderation API is built (#76–#78) but
 *    there are no moderator screens, so today this is one person with
 *    database access.
 *
 *    "One click" is wrong in a smaller way: `POST /reports` requires a
 *    `reason` out of six, so it is a couple of taps. The contract does make
 *    `details` optional on purpose — "demanding a paragraph before somebody
 *    can report harassment is a way of getting fewer reports about
 *    harassment" — which is the thing the design was reaching for and the
 *    line to fall back on if this ever has to be rewritten in a hurry.
 *
 *    WHAT MAKES THIS DIFFERENT FROM THE OTHER FIVE: the rest of the section
 *    is load-bearing. Somebody decides to hand money to a stranger partly
 *    on the strength of it, and if one card turns out to be decoration the
 *    other five stop being evidence. The moderator screens are the fix.
 *
 *  - Clear rules — TRUE. `GET /prohibited-items` is public, the API enforces
 *    it when a need is posted, and #87 made the tick a condition of
 *    publishing, which is what "everyone agrees before posting" means.
 *
 * THE CLOSING PARAGRAPH IS GONE, and that is the design — #168 ended this
 * section with the admission from `docs/07-trust-and-safety.md`, the column
 * headed "Does not promise": we record what was agreed and when, but not
 * that either side keeps the agreement, and we cannot recover money,
 * insure, refund or compensate. The design has no room for it and it was
 * cut here rather than squeezed in.
 *
 * It is not gone from the page. `good-questions.tsx` says the same thing in
 * the answer to "What if something goes wrong?" — "because we hold none of
 * the money, a resolution is a decision and a record — never a refund". If
 * that answer is ever softened, this section loses the only place it admits
 * a limit, and the paragraph should come back here.
 */
const POINTS = [
  {
    title: "No middleman for money",
    text: "Payments go straight between the two of you. Farhand never holds, charges or takes a cut.",
  },
  {
    title: "Every step on record",
    text: "Quote, payment, purchase, tracking, delivery — each is logged with a date, oldest first, and can’t be edited.",
  },
  {
    title: "Receipts that stay",
    text: "Helpers add photos or PDFs of product and postage receipts. Both can see them; nobody can delete them.",
  },
  {
    title: "Honest reviews",
    text: "Reviews stay hidden until both people have written one, or 14 days pass — so nobody reviews in reply.",
  },
  {
    title: "Real moderators",
    text: "Report anything with one click. If a deal goes wrong, open a dispute and a moderator reviews the full history.",
  },
  {
    title: "Clear rules",
    text: "Weapons, prescription medicines, counterfeits and other prohibited items are not allowed. Everyone agrees before posting.",
  },
];

export function TrustAndSafety() {
  return (
    <section id={SECTIONS.trust} className="scroll-mt-20 bg-card">
      <div className="mx-auto max-w-column px-4 py-16 lg:py-20">
        {/*
          Top-aligned, not centred. The two columns are near enough the same
          height in the design that centring them looks identical until the
          headline wraps to a fourth line, and then the picture drifts.
        */}
        <div className="grid items-start gap-10 lg:grid-cols-[1fr_0.9fr] lg:gap-14">
          <div>
            <p className="text-label tracking-[0.12em] text-muted uppercase">
              Trust &amp; safety
            </p>
            <h2 className="mt-2 font-serif text-page-title text-pine">
              Farhand never touches your money. It keeps the record.
            </h2>
            <p className="mt-5 max-w-[48ch] text-lead text-muted">
              You pay the helper directly, the way you both agree. Farhand
              writes down every step — quote, payment, purchase, tracking,
              delivery — so there’s always a clear history if something goes
              wrong.
            </p>
          </div>

          <Image
            src={trust}
            alt="Someone writing an address on a cardboard box."
            sizes="(min-width: 1024px) 42vw, 100vw"
            /* Its own shape, uncropped: the subject is the hand, the marker
               and the box, and every crop that made the column taller cut
               one of the three out of the frame. */
            className="w-[90%] rounded-xl"
          />
        </div>

        {/*
          A description list, not an ordered one. The numbers are the
          design's and they are decoration — unlike the five steps further
          up, where four before three is a different product, these six could
          be read in any order. So they are `aria-hidden` and the markup
          stays term-and-description.

          THE NEGATIVE MARGIN IS THE DETAIL THAT MAKES THE SECTION LINE UP.
          The cards are pulled out by exactly their own padding, so the card
          text sits on the same left edge as the headline above it and the
          last card's text ends level with the right edge of the photograph.
          Without it the whole grid looks inset by twenty pixels from the
          thing it belongs to.
        */}
        <dl className="mt-12 grid gap-4 sm:grid-cols-2 lg:-mx-5 lg:mt-14 lg:grid-cols-3">
          {POINTS.map((point, index) => (
            <div key={point.title} className="rounded-xl bg-cream p-5">
              <span
                className="flex h-11 w-11 items-center justify-center rounded-full bg-pine/30 font-serif text-heading text-pine"
                aria-hidden="true"
              >
                {index + 1}
              </span>
              <dt className="mt-4 font-serif text-card-title text-pine">
                {point.title}
              </dt>
              <dd className="mt-2 text-body text-muted">{point.text}</dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}
