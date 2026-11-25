import Link from "next/link";
import { BROWSE, REGISTER } from "@/lib/landing-links";

/**
 * The last thing on the page — issue #168.
 *
 * "What would you ask someone abroad to buy for you?" A question rather than
 * a slogan, which is the design's instinct and a good one: it makes the
 * reader answer it in their head, and anybody who has an answer is somebody
 * this product is for.
 */
export function ClosingCall() {
  return (
    <section className="bg-pine">
      <div className="mx-auto max-w-column px-4 py-16 text-center lg:py-20">
        <h2 className="mx-auto max-w-[22ch] font-serif text-page-title text-cream">
          What would you ask someone abroad to buy for you?
        </h2>

        <p className="mx-auto mt-4 max-w-[52ch] text-lead text-sage-tint">
          Posting a need costs nothing and commits you to nothing. The answers
          come from people who live where it is sold.
        </p>

        <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
          <Link href={REGISTER.href} className="btn btn-offer no-underline">
            {REGISTER.label}
          </Link>
          <Link href={BROWSE.href} className="btn btn-secondary no-underline">
            {BROWSE.label}
          </Link>
        </div>
      </div>
    </section>
  );
}
