import Link from "next/link";
import { LandingAccount } from "@/components/landing/landing-account";
import { HOW_IT_WORKS, TRUST, BROWSE } from "@/lib/landing-links";

/**
 * The marketing masthead — issue #168.
 *
 * NOT `components/header.tsx`, and the difference is the point. That one is a
 * tool for somebody already inside: My needs, Proposals, Deals, an inbox, and
 * five links that go nowhere yet with `app/not-found.tsx` behind them. This
 * one is for somebody who has decided nothing, so every link works and there
 * are five of them.
 *
 * A server component. The only part that knows whether anyone is signed in is
 * `LandingAccount`, which is two links wide.
 */
export function LandingHeader() {
  // TODO: the airmail stripe, the wordmark, and NAV's first three as a row.
  // The design puts the jump links first and the destinations after.
  return (
    <header>
      <Link href="/" className="wordmark">
        Farhand
      </Link>

      {/* TODO: HOW_IT_WORKS, TRUST, BROWSE */}
      <nav aria-label="Main">
        {[HOW_IT_WORKS, TRUST, BROWSE].map((link) => (
          <Link key={link.href} href={link.href}>
            {link.label}
          </Link>
        ))}
      </nav>

      <LandingAccount />
    </header>
  );
}
