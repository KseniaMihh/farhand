"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useSession } from "@/lib/session";

/**
 * The masthead, in three branches over four states.
 *
 * NOT KNOWN IS NOT SIGNED OUT. Drawing the signed-out controls while the
 * session is still "checking" — or "unknown", which is what a sleeping API
 * produces on every cold start — is a guess that is wrong for everybody who
 * IS signed in, and they are the people who load this page most. So both of
 * those render a copy of the signed-out state, hidden: the row keeps its
 * width, nothing jumps when the answer lands, and nothing is announced that
 * is not there.
 *
 * THE FULL NAVIGATION IS HERE AT THE USER'S DECISION. I had cut it to the
 * screens that exist, on the rule that a dead link is worse than a missing
 * one; they chose the design's header instead, and the header IS the product
 * on one line, so that is a reasonable thing to want early. Five of these go
 * nowhere yet, which is why app/not-found.tsx now exists and says so plainly
 * rather than letting a click land on a framework error page.
 *
 * Each of these paths is where that screen WILL live, so the issue that
 * builds it adds a route and nothing here changes.
 */

/** Signed-in navigation. The first two are public; the rest are yours. */
const MINE = [
  { href: "/me/needs", label: "My needs" },
  { href: "/me/offers", label: "My offers" },
  { href: "/proposals", label: "Proposals" },
  { href: "/deals", label: "Deals" },
  { href: "/inbox", label: "Inbox" },
];

export function Header() {
  const { session, signOut } = useSession();
  const router = useRouter();
  const path = usePathname();

  /** `aria-current` so the page you are on is announced, not only underlined. */
  function current(href: string) {
    return path === href ? "page" : undefined;
  }

  const browse = (
    <>
      <Link className="nav-link" href="/" aria-current={current("/")}>
        Needs
      </Link>
      <Link
        className="nav-link"
        href="/offers"
        aria-current={current("/offers")}
      >
        Offers
      </Link>
    </>
  );

  const signedOutActions = (
    <div className="nav-actions">
      <Link className="nav-link" href="/sign-in">
        Sign in
      </Link>
      <Link className="btn btn-primary" href="/register">
        Create account
      </Link>
    </div>
  );

  return (
    <header className="masthead">
      <div className="airmail" aria-hidden="true" />
      <div className="masthead-row">
        <div className="masthead-left">
          <Link href="/" className="wordmark">
            Farhand
          </Link>

          <nav className="nav" aria-label="Main">
            {browse}

            {session.status === "signed-in" && (
              <>
                <span className="nav-divider" aria-hidden="true" />
                {MINE.map((item) => (
                  <Link
                    key={item.href}
                    className="nav-link"
                    href={item.href}
                    aria-current={current(item.href)}
                  >
                    {item.label}
                    {/* The design shows an unread count on Inbox. There is no
                        endpoint that gives a total — `GET /conversations`
                        carries one per conversation — so a number here would
                        be invented. It arrives with the inbox screen. */}
                  </Link>
                ))}
              </>
            )}
          </nav>
        </div>

        {session.status === "signed-in" ? (
          <div className="nav-actions">
            <Link className="btn btn-need" href="/needs/new">
              Post a need
            </Link>
            <Link className="btn btn-offer" href="/offers/new">
              Post an offer
            </Link>

            {/* <details> rather than state: the keyboard, Escape and
                click-outside all work without any of it being written here. */}
            <details className="menu">
              <summary className="nav-name">
                <span className="avatar" aria-hidden="true">
                  {/* `profile` is nullable in the API's own type, so this
                      falls back to the address rather than asserting one. */}
                  {(session.me.profile?.displayName ?? session.me.email).slice(
                    0,
                    1,
                  )}
                </span>
                <span>
                  {session.me.profile?.displayName ?? session.me.email}
                </span>
                <span className="nav-caret" aria-hidden="true">
                  ▾
                </span>
              </summary>

              <div className="menu-sheet">
                <p className="menu-sheet-note">{session.me.email}</p>
                <Link href="/settings">Settings</Link>
                <button
                  type="button"
                  onClick={() => {
                    void signOut().then(() => {
                      router.push("/");
                    });
                  }}
                >
                  Sign out
                </button>
              </div>
            </details>
          </div>
        ) : session.status === "signed-out" ? (
          signedOutActions
        ) : (
          <div className="nav-placeholder" aria-hidden="true">
            {signedOutActions}
          </div>
        )}
      </div>
    </header>
  );
}
