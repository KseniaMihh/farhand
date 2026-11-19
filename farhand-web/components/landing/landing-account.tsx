"use client";

import Link from "next/link";
import { AccountMenu } from "@/components/account-menu";
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
 * arrives always says "Sign in", and the session answer comes after. So
 * "checking" and "unknown" render this pair hidden rather than absent, the
 * row keeps its width, and nothing is announced that is not there.
 *
 * SIGNED IN, THEY GET THE SAME NAME MENU AS THE PRODUCT HEADER — avatar,
 * address, Sign out — because otherwise the landing page is the one screen
 * on the site with no way to sign out of it.
 *
 * WITH ONE OMISSION, and it is the rule of this page doing its job: the
 * product header's menu also links to `/settings`, which does not exist. It
 * is one of the five dead links `app/not-found.tsx` catches, acceptable
 * inside the product and not acceptable here. `AccountMenu` takes the
 * settings link from its caller, and this caller passes none.
 */
export function LandingAccount() {
  const { session } = useSession();

  if (session.status === "signed-in") {
    return <AccountMenu me={session.me} />;
  }

  const actions = (
    <div className="flex items-center gap-3">
      <Link
        className="text-button whitespace-nowrap text-pine no-underline hover:underline hover:underline-offset-[3px]"
        href={SIGN_IN.href}
      >
        {SIGN_IN.label}
      </Link>
      <Link className="btn btn-primary" href={REGISTER.href}>
        {REGISTER.label}
      </Link>
    </div>
  );

  if (session.status === "signed-out") return actions;

  return (
    <div className="invisible" aria-hidden="true">
      {actions}
    </div>
  );
}
