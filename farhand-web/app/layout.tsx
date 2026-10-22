import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Farhand",
  description:
    "Somebody wants a product their country's shops will not deliver. Somebody else lives where it is sold.",
};

/**
 * The shell every screen sits in.
 *
 * Deliberately almost empty: there is one screen, and a navigation bar with
 * one link in it would be a guess about the other screens
 * (farhand-web/README.md says what is coming). The project's rule applies to
 * the frontend too — version 1's issues were good because they were not
 * guesses.
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="masthead">
          <div className="airmail" aria-hidden="true" />
          <p className="wordmark">Farhand</p>
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
