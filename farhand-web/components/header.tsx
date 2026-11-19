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
  const { session, signOut } = useSession();
  const router = useRouter();
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

            {/* <details> rather than state: the keyboard, Escape and
                click-outside all work without any of it being written here. */}
            <details className="relative">
              <summary className="flex cursor-pointer list-none items-center gap-2 rounded-control px-1.5 py-1 text-button hover:bg-sage-tint [&::-webkit-details-marker]:hidden">
                <span className="avatar" aria-hidden="true">
                  {/* `profile` is nullable in the API's own type, so this
                      falls back to the address rather than asserting one. */}
                  {(session.me.profile?.displayName ?? session.me.email).slice(
                    0,
                    1,
                  )}
                </span>
                <span className="hidden sm:inline">
                  {session.me.profile?.displayName ?? session.me.email}
                </span>
                <span className="text-[10px] opacity-70" aria-hidden="true">
                  ▾
                </span>
              </summary>

              <div className="absolute right-0 z-10 mt-1.5 min-w-45 rounded-control border border-line bg-card p-1.5 shadow-[0_10px_24px_rgb(31_59_52/0.12)]">
                <p className="mx-2.5 mt-0.5 mb-1.5 text-caption break-all text-muted">
                  {session.me.email}
                </p>
                <Link
                  href="/settings"
                  className="block w-full rounded px-2.5 py-2 text-button text-pine no-underline hover:bg-sage-tint"
                >
                  Settings
                </Link>
                <button
                  type="button"
                  className="block w-full cursor-pointer rounded px-2.5 py-2 text-left text-button text-pine hover:bg-sage-tint"
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
          <div className="invisible" aria-hidden="true">
            {signedOutActions}
          </div>
        )}
      </div>
    </header>
  );
}
