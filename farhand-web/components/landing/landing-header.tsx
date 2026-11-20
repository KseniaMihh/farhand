import Link from "next/link";
import { FRONT_DOOR, NAV, REGISTER, SIGN_IN } from "@/lib/landing-links";

/**
 * The marketing masthead — issue #168, laid out to the design in #170.
 *
 * NOT `components/header.tsx`, and the difference is the point. That one is a
 * tool for somebody already inside: My needs, Proposals, Deals, an inbox, and
 * five links that go nowhere yet with `app/not-found.tsx` behind them. This
 * one is for somebody who has decided nothing, so every link works and there
 * are five of them.
 *
 * TWO GROUPS, NOT THREE. The wordmark and the navigation are one thing on the
 * left and the account controls are alone on the right, which is how the
 * design has it. Three children of one `justify-between` put the navigation
 * in the middle of the bar instead, floating away from the name it belongs
 * to — which is what this looked like until #170.
 *
 * NO SESSION, AND NO CLIENT JAVASCRIPT AT ALL. Somebody signed in never sees
 * this page: `middleware.ts` sends a request for `/` that carries a session
 * cookie to `/needs`. So a visitor who gets here has no cookie, and no cookie
 * IS signed out — the cookie is the session. There is nothing to ask the API
 * and no second state to draw, which is why the pair below is plain markup
 * where it used to be a client component waiting on an answer.
 *
 * THE NAVIGATION IS THE PAGE'S TABLE OF CONTENTS (#172). Three jump links,
 * in the order the sections appear below: how it works, trust & safety, the
 * questions. Nothing in the bar leaves the page any more — "Browse needs"
 * moved out of it, because a bar that is three anchors and one departure
 * teaches nobody which is which, and leaving is what the hero's button, the
 * closing call and the footer are for.
 *
 * The list comes from `lib/landing-links.ts` rather than being written here.
 * It was written here briefly after #170, which quietly meant the test that
 * checks the navigation was checking a list nothing rendered.
 */
const LINK =
  "text-button whitespace-nowrap text-pine no-underline hover:underline hover:underline-offset-[3px]";

export function LandingHeader() {
  return (
    <header className="sticky top-0 z-20 border-b border-line bg-cream/95 backdrop-blur">
      <div className="mx-auto flex max-w-column items-center justify-between gap-6 px-4 py-4">
        <div className="flex min-w-0 items-center gap-8 overflow-x-auto [scrollbar-width:none] lg:gap-14">
          <Link href={FRONT_DOOR.href} className="wordmark">
            {FRONT_DOOR.label}
          </Link>

          <nav className="flex items-center gap-6 lg:gap-10" aria-label="Main">
            {NAV.map((link) => (
              <Link key={link.href} className={LINK} href={link.href}>
                {link.label}
              </Link>
            ))}
          </nav>
        </div>

        <div className="flex flex-none items-center gap-4">
          <Link className={LINK} href={SIGN_IN.href}>
            {SIGN_IN.label}
          </Link>
          <Link className="btn btn-primary no-underline" href={REGISTER.href}>
            {REGISTER.label}
          </Link>
        </div>
      </div>
    </header>
  );
}
