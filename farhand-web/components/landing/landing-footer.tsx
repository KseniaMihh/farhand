import Link from "next/link";
import { FOOTER, FRONT_DOOR } from "@/lib/landing-links";

/**
 * The foot of the front door — issue #168.
 *
 * TWO COLUMNS, NOT THE DESIGN'S THREE. The third is Legal, and there are no
 * terms and no privacy policy to point at; a heading above no links is worse
 * than no column. It comes back with its pages.
 *
 * Every link comes from `lib/landing-links.ts`, which is what the dead-link
 * test reads. Nothing here writes an `href` of its own, and a second test
 * says so.
 */
export function LandingFooter() {
  return (
    <footer className="bg-cream">
      <div className="mx-auto grid max-w-column gap-10 px-4 py-12 lg:grid-cols-[1.4fr_1fr_1fr]">
        <div>
          <Link href={FRONT_DOOR.href} className="wordmark">
            {FRONT_DOOR.label}
          </Link>
          <p className="mt-3 max-w-[38ch] text-body text-muted">
            Peer-to-peer cross-border shopping. The money stays between the two
            of you.
          </p>
        </div>

        {FOOTER.map((column) => (
          <nav key={column.heading} aria-label={column.heading}>
            <h2 className="text-label tracking-[0.08em] text-pine uppercase">
              {column.heading}
            </h2>
            <ul className="mt-3 space-y-2">
              {column.links.map((link) => (
                <li key={link.href}>
                  <Link
                    href={link.href}
                    className="text-body text-muted no-underline hover:text-pine hover:underline hover:underline-offset-[3px]"
                  >
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        ))}
      </div>

      <div className="border-t border-line">
        <p className="mx-auto max-w-column px-4 py-5 text-caption text-muted">
          Farhand is a learning project, built in the open.
        </p>
      </div>
    </footer>
  );
}
