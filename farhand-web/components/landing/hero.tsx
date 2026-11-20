import Image from "next/image";
import hero from "@/images/hero_img.webp";
import { ExampleCards } from "@/components/landing/example-cards";

/**
 * The first screenful — issue #168, laid out to the design in #172.
 *
 * The headline is the design's and is kept word for word: it says what the
 * product is in one sentence, which is the whole job of this section.
 *
 * THE PHOTOGRAPH BLEEDS OFF THE TOP AND THE RIGHT, so it is a direct child of
 * the section and not of the centred column — `right-0` inside a column that
 * stops at 1140px would stop there too. The text keeps the column, and takes
 * `z-10` so it stays above the picture where the two overlap.
 *
 * ITS LEFT EDGE IS ONE DECLARATION. `border-bottom-left-radius` takes two
 * radii, horizontal and vertical, and a vertical radius of 100% turns the
 * whole left side into a single quarter-ellipse rather than a rounded corner.
 * The proportions come off the design: the picture is 57% of the section
 * wide and 74% tall, and the arc reaches a quarter of the way across it.
 * Percentages rather than pixels, so the curve keeps its shape at every
 * width instead of flattening on a large screen.
 *
 * The image is imported rather than put in `public/`, so Next reads its
 * dimensions out of the file. It is 1600px wide and 38KB; the 6000x4000
 * original is gitignored, because a committed file cannot be taken back out
 * of history. `priority` because it is the largest thing above the fold, and
 * `sizes` because without it Next assumes the image fills the viewport and
 * serves a phone the full-width file for a half-width slot.
 */
export function Hero() {
  return (
    <section className="relative overflow-hidden bg-cream">
      <div className="relative z-10 mx-auto max-w-column px-4 pt-14 pb-16 lg:pt-28 lg:pb-52">
        {/*
          NARROW ENOUGH TO CLEAR THE CURVE. The picture's edge sweeps right as
          it falls, so the headline is at its most cramped where the arc is
          furthest left — the top. 38% is what keeps the longest line clear of
          it at the column width, and it is also what makes the headline break
          into the design's five lines instead of four.

          No `text-balance` here, for the same reason: it evens the lines by
          choosing its own measure, which is the one thing this column cannot
          let it do.
        */}
        <div className="lg:max-w-[38%]">
          <p className="text-label tracking-[0.12em] text-muted uppercase">
            Peer-to-peer, across borders
          </p>

          <h1 className="mt-4 font-serif text-page-title text-pine lg:text-display">
            The things you miss from abroad, bought by someone who lives there.
          </h1>

          <p className="mt-6 max-w-[46ch] text-lead text-muted">
            Post what you need — a sunscreen from Tokyo, a pen from Kyoto,
            biscuits from Sydney. A helper in that country buys it and posts it
            to you. You agree the price together and pay them directly.
          </p>
        </div>
      </div>

      {/*
        Below the column width it goes back into the flow under the text,
        because a picture positioned off the corner of a phone screen is a
        picture nobody sees. Phone width is unfinished either way — see
        farhand-web/README.md.
      */}
      <div className="lg:absolute lg:top-0 lg:right-0 lg:h-[74%] lg:w-[57%]">
        <Image
          src={hero}
          alt="Two people handing a parcel between them across a counter."
          priority
          sizes="(min-width: 1024px) 57vw, 100vw"
          className="h-56 w-full object-cover [border-bottom-left-radius:25%_100%] sm:h-72 lg:h-full"
        />
      </div>

      <ExampleCards />
    </section>
  );
}
