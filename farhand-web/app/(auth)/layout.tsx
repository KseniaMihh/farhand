import type { ReactNode } from "react";
import { SessionProvider } from "@/lib/session";

/**
 * The split screen the three account pages share (3.1, 3.2, 3.3).
 *
 * Pine Grove on the left carrying one sentence in Libre Baskerville, the form
 * on the right on Cannoli Cream. A route group rather than three copies —
 * and the wordmark lives inside the panel, which is why these pages sit
 * outside the site layout and have no header of their own.
 *
 * The left-hand sentence is the only thing that differs, so each page draws
 * its own `<AuthPanel>` and this holds the shape around it.
 *
 * THE SESSION PROVIDER IS HERE although nothing in this file reads it, and
 * that is not an oversight — the pages inside do. `verify` reads `session` to
 * know which address it is verifying, and both `sign-in` and `verify` call
 * `refresh()` after a successful submit. Until #177 this group got the
 * provider free from the root layout; naming it here is the better state of
 * affairs, because `useSession` throws outside a provider, so a page added to
 * this group without one fails loudly instead of quietly.
 */
export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <SessionProvider>
      <div className="grid min-h-screen grid-cols-1 md:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
        {children}
      </div>
    </SessionProvider>
  );
}
