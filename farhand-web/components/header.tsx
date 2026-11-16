"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useSession } from "@/lib/session";

/**
 * The masthead, in three branches over four states.
 *
 * The design has two headers — signed out (2.2, 2.3: "Sign in · Create
 * account") and signed in (3.6, 4.x). There is a third, and it is the honest
 * one: the answer is not known yet.
 *
 * NOT KNOWN IS NOT SIGNED OUT. Drawing the signed-out controls while the
 * session is still "checking" — or "unknown", which is what a sleeping API
 * produces on every cold start — is a guess that is wrong for everybody who
 * IS signed in, and they are the people who load this page most. So both of
 * those render a copy of the wider state, hidden: the row keeps its width,
 * nothing jumps when the answer lands, and nothing is announced that is not
 * there.
 *
 * The navigation the design shows signed in — Needs, Offers, My needs, My
 * offers, Proposals, Deals, Inbox — is seven links to five screens that do
 * not exist. Only what this issue and #93 built is rendered; each later
 * screen adds its own. A dead link is worse than a missing one.
 */
export function Header() {
  const { session, signOut } = useSession();
  const router = useRouter();

  const signedOut = (
    <nav className="nav">
      <Link className="nav-link" href="/sign-in">
        Sign in
      </Link>
      <Link className="btn btn-primary" href="/register">
        Create account
      </Link>
    </nav>
  );

  return (
    <header className="masthead">
      <div className="airmail" aria-hidden="true" />
      <div className="masthead-row">
        <Link href="/" className="wordmark">
          Farhand
        </Link>

        {session.status === "signed-in" ? (
          <nav className="nav">
            <Link className="nav-link" href="/">
              Needs
            </Link>
            <span className="nav-name">
              <span className="avatar" aria-hidden="true">
                {/* `profile` is nullable in the API's own type, so the
                    initial falls back to the address rather than asserting
                    a profile that registration does always make. */}
                {(session.me.profile?.displayName ?? session.me.email).slice(
                  0,
                  1,
                )}
              </span>
              {session.me.profile?.displayName ?? session.me.email}
            </span>
            <button
              type="button"
              className="btn btn-quiet"
              onClick={() => {
                void signOut().then(() => {
                  router.push("/");
                });
              }}
            >
              Sign out
            </button>
          </nav>
        ) : session.status === "signed-out" ? (
          signedOut
        ) : (
          <div className="nav-placeholder" aria-hidden="true">
            {signedOut}
          </div>
        )}
      </div>
    </header>
  );
}
