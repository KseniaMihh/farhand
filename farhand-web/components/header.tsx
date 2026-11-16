"use client";

import Link from "next/link";
import { useSession } from "@/lib/session";

/**
 * The masthead, in its three states.
 *
 * The design has two headers — signed out (2.2, 2.3: "Sign in · Create
 * account") and signed in (3.6, 4.x: the full navigation plus the account
 * menu). There is a third, and it is the honest one: **checking**, before
 * `GET /auth/me` has answered. Drawing the signed-out header during it means
 * every signed-in person watches "Sign in" turn into their own name on every
 * cold load.
 *
 * TODO(#156): the navigation the design shows signed in — Needs, Offers, My
 * needs, My offers, Proposals, Deals, Inbox — is seven links to five screens
 * that do not exist. Render only what this issue builds (the wordmark, Needs,
 * and the account menu) and let each later screen add its own link. A dead
 * link is worse than a missing one.
 */
export function Header() {
  const { session: _session } = useSession();

  // TODO(#156): three branches.
  //
  //   checking   a NEUTRAL PLACEHOLDER of the same width as the widest of
  //              the two real states — empty, not "Sign in". Reserving the
  //              space is only half of it: drawing the signed-out controls
  //              while the answer is unknown is a guess that is wrong for
  //              everybody who is signed in, and they are the ones who load
  //              this page most. `aria-hidden` and `visibility: hidden` on a
  //              copy of the wider state keeps the measurement honest without
  //              announcing furniture that is not there yet.
  //   signed-out "Sign in" (quiet) and "Create account" (primary)
  //   signed-in  "Needs", then the display name with a menu holding
  //              "Sign out". The avatar circle in the design is the
  //              initial — avatars are #80 and have no screen here.
  //              `profile` can be null, so fall back to the email rather
  //              than asserting it away.
  return (
    <header className="masthead">
      <div className="airmail" aria-hidden="true" />
      <div className="masthead-row">
        <Link href="/" className="wordmark">
          Farhand
        </Link>
      </div>
    </header>
  );
}
