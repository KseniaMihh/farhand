import type { ReactNode } from "react";
import { LandingFooter } from "@/components/landing/landing-footer";
import { LandingHeader } from "@/components/landing/landing-header";
import { WarmUp } from "@/components/landing/warm-up";

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
 * THE PAGE IS A SERVER COMPONENT and stays one. Every section is markup, so
 * it is prerendered at build time and appears instantly even when Render's
 * free instance is asleep — which is precisely the first visit this page
 * exists for, and the opposite of what the browse list does. Nothing drawn
 * here waits on the API.
 *
 * ONE CLIENT COMPONENT, AND IT DRAWS NOTHING. `<WarmUp />` asks
 * `GET /health/ready` once on mount and throws the answer away, so that the
 * API is awake by the time somebody clicks through to a screen that needs it.
 * It renders `null`, so the prerendered HTML is unchanged and the page still
 * appears whether or not the API ever answers. Its own file has the argument,
 * including why it is not on hover, and decision 0036 has what was rejected.
 *
 * Until #177 this group was wrapped by the session provider from the root
 * layout, which asked `GET /auth/me` on every visit. Nothing here reads a
 * session: a visitor who reaches this page has no cookie, because
 * `middleware.ts` sends anybody who has one to `/needs`, and no cookie IS
 * signed out — so the masthead draws the signed-out state as plain markup
 * with nothing to ask. See `landing-header.tsx`, which has said so since
 * #170 while this file still claimed the opposite.
 */
export default function LandingLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <LandingHeader />
      <main>{children}</main>
      <LandingFooter />
      <WarmUp />
    </>
  );
}
