import Link from "next/link";
import { REGISTER } from "@/lib/landing-links";

/**
 * "Two ways to use Farhand" — issue #168.
 *
 * I NEED SOMETHING / I CAN HELP, three bullets each. The section that does
 * the most work on this page: a marketplace is confusing until somebody
 * knows which side of it they are on.
 *
 * BOTH COLUMNS END AT "CREATE ACCOUNT". The design's buttons are "Post a
 * need" and "Post an offer" and neither screen exists yet, and the front
 * door is the one page where a dead link is not acceptable
 * (`lib/landing-links.ts`). An account is genuinely the first step on either
 * path, so the button is honest rather than merely available. The two
 * original buttons come back with their issues.
 */
export function TwoWays() {
  return (
    <section>
      {/* TODO: the section heading, then the two columns. */}
      <h2>Two ways to use Farhand</h2>

      {/* TODO: I need something — three bullets from the design, checked
          against what the product does. */}
      <article>
        <h3>I need something</h3>
        <Link href={REGISTER.href} className="btn btn-need">
          {REGISTER.label}
        </Link>
      </article>

      {/* TODO: I can help — three bullets, same check. */}
      <article>
        <h3>I can help</h3>
        <Link href={REGISTER.href} className="btn btn-offer">
          {REGISTER.label}
        </Link>
      </article>
    </section>
  );
}
