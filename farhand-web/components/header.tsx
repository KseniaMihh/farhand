"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useSession } from "@/lib/session";
import { AccountMenu } from "@/components/account-menu";

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
 * The full navigation is here at the user's decision. Five of these links go
 * nowhere yet, which is why app/not-found.tsx exists and says so plainly
 * rather than letting a click land on a framework error page. Each path is
 * where that screen WILL live, so the issue that builds it adds a route and
 * nothing here changes.
 */

/** Signed-in navigation. The first two are public; the rest are yours. */
const MINE = [
  { href: "/me/needs", label: "My needs" },
  { href: "/me/offers", label: "My offers" },
  { href: "/proposals", label: "Proposals" },
  { href: "/deals", label: "Deals" },
  { href: "/inbox", label: "Inbox" },
];

const LINK =
  "text-button whitespace-nowrap text-pine no-underline hover:underline hover:underline-offset-[3px] aria-[current=page]:underline aria-[current=page]:underline-offset-[3px] aria-[current=page]:decoration-2";

export function Header() {
  const { session } = useSession();
  const path = usePathname();

  /** `aria-current` so the page you are on is announced, not only underlined. */
  function current(href: string) {
    return path === href ? "page" : undefined;
  }

  const browse = (
    <>
      <Link className={LINK} href="/needs" aria-current={current("/needs")}>
        Needs
      </Link>
      <Link className={LINK} href="/offers" aria-current={current("/offers")}>
        Offers
      </Link>
    </>
  );

  const signedOutActions = (
    <div className="flex items-center gap-3">
      <Link className={LINK} href="/sign-in">
        Sign in
      </Link>
      <Link className="btn btn-primary" href="/register">
        Create account
      </Link>
    </div>
  );

  return (
    <header className="border-b border-line bg-card">
      <div className="airmail" aria-hidden="true" />
      <div className="mx-auto flex max-w-column items-center justify-between gap-4 px-4 py-3.5">
        {/* Below the column width the navigation scrolls sideways rather than
            wrapping into two rows that push the whole page down. */}
        <div className="flex min-w-0 items-center gap-4 overflow-x-auto [scrollbar-width:none] lg:gap-7">
          <Link href="/" className="wordmark">
            Farhand
          </Link>

          <nav className="flex items-center gap-4 lg:gap-5.5" aria-label="Main">
            {browse}

            {session.status === "signed-in" && (
              <>
                <span className="h-5 w-px bg-line" aria-hidden="true" />
                {MINE.map((item) => (
                  <Link
                    key={item.href}
                    className={LINK}
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
          <div className="flex items-center gap-3">
            <Link className="btn btn-need" href="/needs/new">
              Post a need
            </Link>
            <Link className="btn btn-offer" href="/offers/new">
              Post an offer
            </Link>

            {/* The menu moved to `components/account-menu.tsx` in #168, so
                that the landing page can use it too and there is one sign-out
                button rather than two. Settings is passed from here because
                that screen does not exist yet and the front door may not
                link to it. */}
            <AccountMenu
              me={session.me}
              settings={{ href: "/settings", label: "Settings" }}
            />
          </div>
        ) : session.status === "signed-out" ? (
          signedOutActions
        ) : (
          <div className="invisible" aria-hidden="true">
            {signedOutActions}
          </div>
        )}
      </div>
    </header>
  );
}
