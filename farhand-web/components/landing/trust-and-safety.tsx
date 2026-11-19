import Image from "next/image";
import trust from "@/images/trust_safety.webp";
import { SECTIONS } from "@/lib/landing-links";

/**
 * Why this is not a stranger taking your money — issue #168.
 *
 * "FARHAND NEVER TOUCHES YOUR MONEY" is the strongest line on the page and
 * it is completely true: there is no payment integration, by decision, and
 * `docs/08-scope.md` lists holding money as a version 3 idea.
 *
 * THE DESIGN'S THREE SUPPORTING CLAIMS WERE "Honest reviews", "Clear rules"
 * and "Real moderators". Two are true as written and one was not:
 *
 *  - Reviews — TRUE, and said precisely here rather than as a slogan,
 *    because the precision IS the reassurance: only after a completed deal,
 *    and blind until both are in (decision 0017).
 *
 *  - Rules — TRUE. `GET /prohibited-items` serves a public list the API
 *    enforces when a need is posted, readable before anybody has an account.
 *    It has no page of its own yet, so the examples are given here rather
 *    than linked to.
 *
 *  - "Real moderators" — CHANGED. The moderation API is built (#76–#78):
 *    reports, a queue, warn, suspend, ban, content hiding, an audit log.
 *    There are no moderator screens, so today this is one person with
 *    database access. "Real moderators" implies a team and there is not one.
 *    What is true is that a person reads every report, and that is what it
 *    says now.
 *
 * THE LAST PARAGRAPH IS THE ONE THAT MAKES THE REST BELIEVABLE, and it is
 * lifted almost directly from `docs/07-trust-and-safety.md`, which has a
 * column headed "Does not promise" and means it. A trust section that only
 * lists promises is an advertisement.
 */
const POINTS = [
  {
    title: "Reviews that cost something to write",
    text: "A review can only be written after a deal is finished, so nobody can review a stranger they never dealt with. Neither of you sees the other’s until both are in, so a review is never an answer to the one you just read.",
  },
  {
    title: "Rules you can read before you join",
    text: "The list of what Farhand will not carry is public and the API checks it when a need is posted: weapons, drugs and medicines, alcohol and tobacco, live animals, perishable food, hazardous goods, counterfeits, and anything needing an export licence.",
  },
  {
    title: "A person reads every report",
    text: "Any listing, message or account can be reported. A person reads it and can warn, suspend or ban an account and hide what was posted, and every one of those actions is written to an audit log.",
  },
];

export function TrustAndSafety() {
  return (
    <section
      id={SECTIONS.trust}
      className="scroll-mt-20 border-y border-line bg-card"
    >
      <div className="mx-auto grid max-w-column items-center gap-12 px-4 py-16 lg:grid-cols-[1fr_0.8fr] lg:py-20">
        <div>
          <p className="text-label tracking-[0.12em] text-muted uppercase">
            Trust &amp; safety
          </p>
          <h2 className="mt-2 font-serif text-page-title text-pine">
            Farhand never touches your money
          </h2>
          <p className="mt-4 max-w-[54ch] text-lead text-muted">
            There is no wallet here, no escrow and no card on file. You and your
            helper agree an amount and settle it between you — which means there
            is nothing for us to lose, and nothing for us to take.
          </p>

          <dl className="mt-9 space-y-6">
            {POINTS.map((point) => (
              <div key={point.title}>
                <dt className="font-serif text-card-title text-pine">
                  {point.title}
                </dt>
                <dd className="mt-1.5 max-w-[58ch] text-body text-muted">
                  {point.text}
                </dd>
              </div>
            ))}
          </dl>

          <p className="mt-9 max-w-[58ch] border-l-2 border-sage pl-4 text-body text-pine">
            And what we do not promise, in the same plain words we use
            everywhere else: we keep a record of what was agreed and when, but
            not that either side keeps the agreement. We cannot recover money,
            and we do not insure, refund or compensate. That is the trade for
            never having to trust us with it.
          </p>
        </div>

        <Image
          src={trust}
          alt="Someone writing an address on a cardboard box."
          sizes="(min-width: 1024px) 40vw, 100vw"
          /* Its own shape, uncropped: the subject is the hand, the marker and
             the box, and every crop that made the column taller cut one of
             the three out of the frame. */
          className="w-full rounded-xl"
        />
      </div>
    </section>
  );
}
