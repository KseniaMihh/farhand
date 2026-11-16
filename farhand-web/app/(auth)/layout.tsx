import type { ReactNode } from "react";

/**
 * The split screen the three account pages share (3.1, 3.2, 3.3).
 *
 * Pine Grove on the left carrying one sentence in Libre Baskerville, the form
 * on the right on Cannoli Cream. A route group rather than three copies,
 * because the left-hand sentence is the only thing that differs and a page
 * can set that itself.
 *
 * TODO(#156): the promise at the bottom of the panel — "Farhand never handles
 * money. People pay each other directly." — is on all three in the design and
 * belongs here, not in each page.
 *
 * TODO(#156): at phone width the panel stacks above the form and loses the
 * display line, which is decoration. 6.x has no account screens, so this is
 * the one place the mobile shape is a judgement rather than a drawing.
 */
export default function AuthLayout({ children }: { children: ReactNode }) {
  return <div className="auth-split">{children}</div>;
}
