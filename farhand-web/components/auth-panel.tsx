import Link from "next/link";
import type { ReactNode } from "react";

/**
 * The dark half of an account screen (3.1, 3.2, 3.3).
 *
 * One line, which is the only thing that differs between the three, plus the
 * wordmark and the promise that is on all of them. At phone width the line
 * and the promise go — they are decoration, and the form is the page.
 *
 * `.wordmark` stays a class: Terracotta on Cream is about 2.9:1 and is only
 * legal because it is large and bold, which is a rule rather than a look.
 */
export function AuthPanel({ children }: { children: ReactNode }) {
  return (
    <aside className="flex flex-col justify-between gap-4 bg-pine p-5 text-cream md:gap-12 md:p-10">
      <Link href="/" className="wordmark text-cream">
        Farhand
      </Link>
      <p className="hidden max-w-[10em] font-serif text-display md:block">
        {children}
      </p>
      <p className="hidden text-caption opacity-75 md:block">
        Farhand never handles money. People pay each other directly.
      </p>
    </aside>
  );
}
