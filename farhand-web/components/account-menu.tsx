"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useSession, type Me } from "@/lib/session";

/**
 * Who you are, and the way out — issue #168.
 *
 * LIFTED OUT OF `components/header.tsx` BECAUSE THE LANDING PAGE NEEDS IT
 * TOO. Somebody signed in who lands on `/` would otherwise be on the one
 * screen of the site with no way to sign out of it. Two copies of a sign-out
 * button is two places for it to stop working, and the one that breaks is
 * always the copy somebody forgot existed.
 *
 * THE SETTINGS LINK IS PASSED IN RATHER THAN WRITTEN HERE. `/settings` is
 * one of the five routes the product header links to before they exist, with
 * `app/not-found.tsx` behind them — acceptable inside the product, and not
 * on the front door, where a dead link is read as "this is not a real
 * thing". So the caller decides, and the landing page passes nothing until
 * that screen is built.
 */
export function AccountMenu({
  me,
  settings,
}: {
  me: Me;
  /** Omitted where the destination does not exist yet. */
  settings?: { href: string; label: string } | undefined;
}) {
  const { signOut } = useSession();
  const router = useRouter();

  /** `profile` is nullable in the API's own type, so this falls back to the
      address rather than asserting one. */
  const name = me.profile?.displayName ?? me.email;

  return (
    /* <details> rather than state: the keyboard, Escape and click-outside
       all work without any of it being written here. */
    <details className="relative">
      <summary className="flex cursor-pointer list-none items-center gap-2 rounded-control px-1.5 py-1 text-button hover:bg-sage-tint [&::-webkit-details-marker]:hidden">
        <span className="avatar" aria-hidden="true">
          {name.slice(0, 1)}
        </span>
        <span className="hidden sm:inline">{name}</span>
        <span className="text-[10px] opacity-70" aria-hidden="true">
          ▾
        </span>
      </summary>

      <div className="absolute right-0 z-10 mt-1.5 min-w-45 rounded-control border border-line bg-card p-1.5 shadow-[0_10px_24px_rgb(31_59_52/0.12)]">
        <p className="mx-2.5 mt-0.5 mb-1.5 text-caption break-all text-muted">
          {me.email}
        </p>

        {settings !== undefined && (
          <Link
            href={settings.href}
            className="block w-full rounded px-2.5 py-2 text-button text-pine no-underline hover:bg-sage-tint"
          >
            {settings.label}
          </Link>
        )}

        <button
          type="button"
          className="block w-full cursor-pointer rounded px-2.5 py-2 text-left text-button text-pine hover:bg-sage-tint"
          onClick={() => {
            // The front door, which is where somebody who has just left the
            // product should land: it is the one screen that still has
            // something to say to them.
            void signOut().then(() => {
              router.push("/");
            });
          }}
        >
          Sign out
        </button>
      </div>
    </details>
  );
}
