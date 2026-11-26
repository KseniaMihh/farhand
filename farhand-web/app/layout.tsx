import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Libre_Baskerville } from "next/font/google";
import "./globals.css";

/**
 * ONE FACE: Libre Baskerville, for everything (#170).
 *
 * It was two until this issue — Libre Baskerville to brand, Inter to work —
 * and the design file has one. Inter is not downloaded any more, which also
 * takes a font file off the first paint of every page.
 *
 * It ships 400 and 700 and nothing between, and `globals.css` says so where
 * the weights are set: a rule asking for 500 or 600 gets 700 drawn and no
 * warning anywhere.
 *
 * `next/font` downloads and self-hosts it at build time, so there is no
 * request to Google from a visitor's browser — which keeps the one-origin
 * story of decision 0031 true for fonts as well as for data, and means no
 * third party learns who reads Farhand.
 *
 * The variable is named `--font-serif-face` rather than `--font-serif`
 * because Tailwind owns the short name: `--font-serif` in the theme is what
 * generates `font-serif`, and it is written in terms of this one (#158). A
 * token defined in terms of itself is a loop that renders as Times New
 * Roman.
 */
const serif = Libre_Baskerville({
  subsets: ["latin"],
  weight: ["400", "700"],
  style: ["normal", "italic"],
  variable: "--font-serif-face",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Farhand",
  description:
    "Somebody wants a product their country's shops will not deliver. Somebody else lives where it is sold.",
};

/**
 * The shell every screen sits in — and nothing more than a shell.
 *
 * The header and the banner are NOT here, because the account screens do not
 * have them: 3.1, 3.2 and 3.3 are a full-bleed split with the wordmark inside
 * the dark panel. Two route groups settle it — `(site)` wears the furniture,
 * `(auth)` does not — and neither changes a URL.
 *
 * NEITHER IS THE SESSION, since #177. The provider wrapped everything here,
 * which looked like generosity and was a request: it asks `GET /auth/me` on
 * mount, so it asked on the landing page too — the one screen whose visitors
 * are all signed out by definition, because `proxy.ts` sends anybody
 * carrying a cookie to `/needs` before this layout ever runs. A question
 * whose answer is already known is not a cheap question. It is a pointless
 * one, and it was also the reason the landing page shipped client JavaScript
 * while two documents said it shipped none.
 *
 * It now sits in `(site)` and `(auth)`, the two groups that read it.
 * `(landing)` has no reader at all: its masthead is plain markup. What
 * replaced the accidental wake-up that request was performing is in
 * `components/landing/warm-up.tsx` and decision 0036.
 *
 * What is left here is what every screen genuinely shares: the document, the
 * typeface and the stylesheet.
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={serif.variable}>
      <body>{children}</body>
    </html>
  );
}
