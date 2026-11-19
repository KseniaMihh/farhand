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
    <section>
      {/* TODO: the question as a heading, one line under it, two buttons. */}
      <h2>What would you ask someone abroad to buy for you?</h2>

      <Link href={REGISTER.href} className="btn btn-primary">
        {REGISTER.label}
      </Link>
      <Link href={BROWSE.href} className="btn btn-secondary">
        {BROWSE.label}
      </Link>
    </section>
  );
}
