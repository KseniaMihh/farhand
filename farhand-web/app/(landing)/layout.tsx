import type { ReactNode } from "react";
import { LandingFooter } from "@/components/landing/landing-footer";
import { LandingHeader } from "@/components/landing/landing-header";

/**
 * The front door, and the only screen that is not the product — issue #168.
 *
 * A THIRD ROUTE GROUP, beside `(site)` which wears the product header and
 * `(auth)` which wears nothing. This one has its own masthead and its own
 * footer, because the product header is a tool for somebody already here:
 * it offers My needs, Proposals, Deals, an inbox, and five links that go
 * nowhere yet. A visitor who has not decided anything needs five links, all
 * of which work.
 *
 * It also takes `/`, which is why browse moved to `/needs` — two route
 * groups cannot both own the root.
 *
 * THE PAGE IS A SERVER COMPONENT and stays one. It fetches nothing, so it is
 * prerendered at build time and appears instantly even when Render's free
 * instance is asleep — which is precisely the first visit this page exists
 * for, and the opposite of what the browse list does. The only part that
 * knows about a session is the pair of account controls in the masthead, and
 * that is a client component the size of two links; see `landing-header.tsx`.
 */
export default function LandingLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <LandingHeader />
      <main>{children}</main>
      <LandingFooter />
    </>
  );
}
