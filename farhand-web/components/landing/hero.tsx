import Image from "next/image";
import Link from "next/link";
import hero from "@/images/hero_img.webp";
import { BROWSE, REGISTER } from "@/lib/landing-links";
import { ExampleCards } from "@/components/landing/example-cards";

/**
 * The first screenful — issue #168.
 *
 * The headline is the design's and is kept word for word: it says what the
 * product is in one sentence, which is the whole job of this section.
 *
 * THE PHOTOGRAPH is imported rather than put in `public/`, so Next reads its
 * dimensions out of the file and reserves the space before it loads —
 * nothing on the page jumps. It is 1600px wide and 38KB; the 6000x4000
 * original is gitignored, because a committed file cannot be taken back out
 * of history.
 *
 * `priority` because it is the largest thing above the fold, and `sizes`
 * because without it Next assumes the image fills the viewport and serves a
 * phone the full-width file for a half-width slot.
 */
export function Hero() {
  return (
    <section className="border-b border-line bg-cream">
      <div className="mx-auto grid max-w-column items-center gap-12 px-4 py-16 lg:grid-cols-[1fr_1.15fr] lg:py-20">
        <div>
          <p className="text-label tracking-[0.12em] text-terracotta uppercase">
            Peer-to-peer, across borders
          </p>

          <h1 className="mt-4 font-serif text-page-title text-balance text-pine lg:text-display">
            The things you miss from abroad, bought by someone who lives there.
          </h1>

          <p className="mt-5 max-w-[46ch] text-lead text-muted">
            Somebody wants a product their country’s shops will not deliver.
            Somebody else lives where it is sold. Farhand introduces them, keeps
            the record — and stays out of the money.
          </p>

          <div className="mt-8 flex flex-wrap items-center gap-3">
            <Link href={BROWSE.href} className="btn btn-primary no-underline">
              {BROWSE.label}
            </Link>
            <Link
              href={REGISTER.href}
              className="btn btn-secondary no-underline"
            >
              {REGISTER.label}
            </Link>
          </div>
        </div>

        {/*
          The photograph and the two example cards are one unit: the cards sit
          over the picture at the design's widths and stack under it below
          them, which is the only way the text in them stays readable.
        */}
        <div className="relative">
          <Image
            src={hero}
            alt="Two people handing a parcel between them across a counter."
            priority
            sizes="(min-width: 1024px) 46vw, 100vw"
            className="aspect-[4/3] w-full rounded-xl object-cover"
          />

          <ExampleCards />
        </div>
      </div>
    </section>
  );
}
