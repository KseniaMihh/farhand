import Link from "next/link";
import { FOOTER } from "@/lib/landing-links";

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
    <footer>
      {/* TODO: the wordmark and one line saying what Farhand is, beside the
          columns. */}
      {FOOTER.map((column) => (
        <div key={column.heading}>
          <h2>{column.heading}</h2>
          <ul>
            {column.links.map((link) => (
              <li key={link.href}>
                <Link href={link.href}>{link.label}</Link>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </footer>
  );
}
