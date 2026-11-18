import type { ReactNode } from "react";
import { AccountBanner } from "@/components/account-banner";
import { Header } from "@/components/header";

/**
 * Every screen that is the product itself, rather than the way in.
 *
 * The header and the banner live here and not in the root layout because the
 * account screens (3.1–3.3) have neither — they are a full-bleed split with
 * the wordmark inside the dark panel. A route group costs nothing and keeps
 * both the URL and the session provider where they were.
 */
export default function SiteLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <Header />
      <AccountBanner />
      <main className="mx-auto max-w-column px-4 pt-8 pb-20">{children}</main>
    </>
  );
}
