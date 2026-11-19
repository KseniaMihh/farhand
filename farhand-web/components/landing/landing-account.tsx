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
 * TODO: decide what a signed-in visitor sees instead. "Browse needs" is
 * already in the nav, so the honest answer is probably their own name
 * linking to the product, or nothing at all.
 */
export function LandingAccount() {
  const { session } = useSession();

  // TODO: the other three states, as in components/header.tsx — checking and
  // unknown should render this pair hidden rather than absent, so the row
  // keeps its width and nothing is announced that is not there.
  if (session.status === "signed-in") return null;

  return (
    <div>
      <Link href={SIGN_IN.href}>{SIGN_IN.label}</Link>
      <Link href={REGISTER.href} className="btn btn-primary">
        {REGISTER.label}
      </Link>
    </div>
  );
}
