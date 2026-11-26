import type { ReactNode } from "react";
import { AccountBanner } from "@/components/account-banner";
import { Header } from "@/components/header";
import { SessionProvider } from "@/lib/session";

/**
 * Every screen that is the product itself, rather than the way in.
 *
 * The header and the banner live here and not in the root layout because the
 * account screens (3.1–3.3) have neither — they are a full-bleed split with
 * the wordmark inside the dark panel. A route group costs nothing and leaves
 * every URL exactly where it was.
 *
 * THE SESSION PROVIDER IS HERE TOO, since #177, where it used to sit above
 * all three groups. The reason it wraps a group rather than one component is
 * unchanged and is decision 0032's: the header and the banner ask the same
 * question, and one provider between them is what stops two askers racing for
 * the same answer. The reason it is no longer above `(landing)` as well is
 * that `(landing)` never asked it anything.
 */
export default function SiteLayout({ children }: { children: ReactNode }) {
  return (
    <SessionProvider>
      <Header />
      <AccountBanner />
      <main className="mx-auto max-w-column px-4 pt-8 pb-20">{children}</main>
    </SessionProvider>
  );
}
