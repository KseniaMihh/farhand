"use client";

import Link from "next/link";
import { useSession } from "@/lib/session";
import { REGISTER, SIGN_IN } from "@/lib/landing-links";

/**
 * The two account controls in the marketing masthead — issue #168.
 *
 * THE ONLY CLIENT COMPONENT ON THIS PAGE, and the only reason the page needs
 * one. Everything else here is prose and can be prerendered; "Sign in" shown
 * to somebody who is already signed in is the one visible lie the front door
 * would otherwise tell.
 *
 * NOT KNOWN IS NOT SIGNED OUT — the same rule as `components/header.tsx`, and
 * it matters more here, because this page is prerendered: the HTML that
 * arrives always says "Sign in", and the session answer comes after. A
 * signed-in visitor must not see the pair flash and then change.
 *
 * SIGNED IN, THEY GET THE SAME NAME MENU AS THE PRODUCT HEADER — avatar,
 * address, Sign out — because otherwise the landing page is the one screen
 * on the site with no way to sign out of it.
 *
 * WITH ONE OMISSION, and it is the rule of this page doing its job: the
 * product header's menu also links to `/settings`, which does not exist. It
 * is one of the five dead links `app/not-found.tsx` catches, acceptable
 * inside the product and not acceptable here. So the shared menu takes the
 * settings link as something a caller may pass, and this caller does not
 * pass it until that screen is built. The dead-link test would have caught
 * it either way, which is the point of having one.
 *
 * TODO: extract the `<details>` menu out of `components/header.tsx` into
 * `components/account-menu.tsx` and use it from both. Two copies of a
 * sign-out button is two places for it to stop working.
 */
export function LandingAccount() {
  const { session } = useSession();

  // TODO: the shared account menu, without its settings link.
  if (session.status === "signed-in") return null;

  // TODO: checking and unknown render this pair hidden rather than absent, so
  // the row keeps its width and nothing is announced that is not there.

  return (
    <div>
      <Link href={SIGN_IN.href}>{SIGN_IN.label}</Link>
      <Link href={REGISTER.href} className="btn btn-primary">
        {REGISTER.label}
      </Link>
    </div>
  );
}
