import Link from "next/link";
import type { ReactNode } from "react";

/**
 * The dark half of an account screen (3.1, 3.2, 3.3).
 *
 * One line, which is the only thing that differs between the three, plus the
 * wordmark and the promise that is on all of them. At phone width the line
 * and the promise go — they are decoration, and the form is the page.
 */
export function AuthPanel({ children }: { children: ReactNode }) {
  return (
    <aside className="auth-panel">
      <Link href="/" className="auth-panel-wordmark">
        Farhand
      </Link>
      <p className="auth-panel-line">{children}</p>
      <p className="auth-panel-foot">
        Farhand never handles money. People pay each other directly.
      </p>
    </aside>
  );
}
