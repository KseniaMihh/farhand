import Link from "next/link";
import { LandingAccount } from "@/components/landing/landing-account";
import { BROWSE, FRONT_DOOR, HOW_IT_WORKS, TRUST } from "@/lib/landing-links";

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
const LINK =
  "text-button whitespace-nowrap text-pine no-underline hover:underline hover:underline-offset-[3px]";

export function LandingHeader() {
  return (
    <header className="sticky top-0 z-20 border-b border-line bg-cream/95 backdrop-blur">
      <div className="airmail" aria-hidden="true" />

      <div className="mx-auto flex max-w-column items-center justify-between gap-4 px-4 py-3.5">
        <Link href={FRONT_DOOR.href} className="wordmark">
          {FRONT_DOOR.label}
        </Link>

        <nav
          className="flex min-w-0 items-center gap-5 overflow-x-auto [scrollbar-width:none]"
          aria-label="Main"
        >
          {[HOW_IT_WORKS, TRUST, BROWSE].map((link) => (
            <Link key={link.href} className={LINK} href={link.href}>
              {link.label}
            </Link>
          ))}
        </nav>

        <LandingAccount />
      </div>
    </header>
  );
}
