import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Inter, Libre_Baskerville } from "next/font/google";
import { Header } from "@/components/header";
import { AccountBanner } from "@/components/account-banner";
import { SessionProvider } from "@/lib/session";
import "./globals.css";

/**
 * The two faces the design names (1.2): Libre Baskerville for the brand,
 * titles and prices, Inter for everything that is interface.
 *
 * `next/font` downloads and self-hosts them at build time, so there is no
 * request to Google from a visitor's browser — which keeps the one-origin
 * story of decision 0031 true for fonts as well as for data, and means no
 * third party learns who reads Farhand.
 */
const serif = Libre_Baskerville({
  subsets: ["latin"],
  weight: ["400", "700"],
  style: ["normal", "italic"],
  variable: "--font-serif",
  display: "swap",
});

const sans = Inter({
  subsets: ["latin"],
  variable: "--font-sans",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Farhand",
  description:
    "Somebody wants a product their country's shops will not deliver. Somebody else lives where it is sold.",
};

/**
 * The shell every screen sits in.
 *
 * #93 left this almost empty on purpose — a navigation bar with one link in
 * it would have been a guess. #156 is the issue that stops it being a guess:
 * there is a session now, so there is a header with two sides to it, and a
 * banner that an unverified or suspended account sees.
 *
 * The provider wraps everything because the header and the banner both ask
 * the same question, and asking `GET /auth/me` twice per page load would make
 * the answer a race.
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${serif.variable} ${sans.variable}`}>
      <body>
        <SessionProvider>
          <Header />
          <AccountBanner />
          <main>{children}</main>
        </SessionProvider>
      </body>
    </html>
  );
}
