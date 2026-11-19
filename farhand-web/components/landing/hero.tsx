import Image from "next/image";
import Link from "next/link";
import hero from "@/images/hero_img.webp";
import { BROWSE, REGISTER } from "@/lib/landing-links";
import { ExampleCards } from "@/components/landing/example-cards";

/**
 * The first screenful — issue #168.
 *
 * "PEER-TO-PEER, ACROSS BORDERS" over "The things you miss from abroad,
 * bought by someone who lives there." The headline is the design's and is
 * kept word for word: it says what the product is in one sentence, which is
 * the whole job of this section.
 *
 * THE PHOTOGRAPH is imported rather than put in `public/`, so Next reads its
 * dimensions out of the file and reserves the space before it loads —
 * nothing on the page jumps. It is 1600px wide and 38KB; the 6000x4000
 * original is gitignored, because a committed file cannot be taken back out
 * of history.
 *
 * `priority` because it is the largest thing above the fold and the one
 * image worth blocking on.
 */
export function Hero() {
  return (
    <section>
      {/* TODO: the eyebrow, the headline, the lead paragraph. */}
      <p>Peer-to-peer, across borders</p>
      <h1>
        The things you miss from abroad, bought by someone who lives there.
      </h1>

      {/* TODO: the two calls to action. The design has "Post a need" first;
          that screen does not exist, so browsing leads and registering
          follows. */}
      <Link href={BROWSE.href} className="btn btn-primary">
        {BROWSE.label}
      </Link>
      <Link href={REGISTER.href} className="btn btn-secondary">
        {REGISTER.label}
      </Link>

      {/* TODO: alt text that describes the picture and does not repeat the
          headline. */}
      <Image src={hero} alt="" priority />

      <ExampleCards />
    </section>
  );
}
