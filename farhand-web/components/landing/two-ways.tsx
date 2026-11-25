import Link from "next/link";
import { REGISTER } from "@/lib/landing-links";

/**
 * "Two ways to use Farhand" — issue #168.
 *
 * The section that does the most work on this page: a marketplace is
 * confusing until somebody knows which side of it they are on. The copy is
 * the design's, word for word, because every line of it is true today.
 *
 * THE COLOURS ARE THE POINT AND ARE SAID OUT LOUD — "blue always means a
 * need, terracotta always means an offer" is a promise the rest of the
 * product keeps, in `.btn-need`, `.btn-offer` and the two tints. A landing
 * page that teaches the code is a landing page doing something useful.
 *
 * BOTH COLUMNS END AT "CREATE ACCOUNT". The design's buttons are "Post a
 * need" and "Post an offer" and neither screen exists yet, and the front
 * door is the one page where a dead link is not acceptable
 * (`lib/landing-links.ts`). An account is genuinely the first step on either
 * path, so the button is honest rather than merely available. The two
 * original buttons come back with their issues.
 */
const NEEDING = [
  "Describe the product, the store, and where it should go",
  "Set an estimated price and a thank-you for the helper",
  "Choose from people who offer to help",
];

const HELPING = [
  "Say where you live, where you ship, and what you can buy",
  "Offer to help on open needs, or get asked directly",
  "Receive the product cost, postage and a thank-you",
];

function Column({
  kind,
  label,
  title,
  points,
  button,
}: {
  kind: "need" | "offer";
  label: string;
  title: string;
  points: readonly string[];
  button: string;
}) {
  const need = kind === "need";

  return (
    <article className="overflow-hidden rounded-xl border border-line bg-cream">
      <div className={need ? "h-1.5 bg-blue" : "h-1.5 bg-terracotta"} />

      <div className="p-7">
        <span
          className={`rounded px-2 py-0.5 text-badge tracking-[0.08em] uppercase ${
            need ? "bg-need-tint text-need-ink" : "bg-offer-tint text-offer-ink"
          }`}
        >
          {label}
        </span>

        <h3 className="mt-4 font-serif text-heading text-pine">{title}</h3>

        <ul className="mt-4 space-y-2.5">
          {points.map((point) => (
            <li key={point} className="flex gap-2.5 text-body text-pine">
              <span className="text-muted" aria-hidden="true">
                ·
              </span>
              {point}
            </li>
          ))}
        </ul>

        <Link
          href={REGISTER.href}
          className={`btn mt-6 no-underline ${need ? "btn-need" : "btn-offer"}`}
        >
          {button}
        </Link>
      </div>
    </article>
  );
}

export function TwoWays() {
  return (
    <section className="bg-card">
      <div className="mx-auto max-w-column px-4 py-16 lg:py-20">
        <h2 className="font-serif text-page-title text-pine">
          Two ways to use Farhand
        </h2>
        <p className="mt-3 text-lead text-muted">
          The same account does both. Blue always means a need, terracotta
          always means an offer.
        </p>

        <div className="mt-10 grid gap-6 lg:grid-cols-2">
          <Column
            kind="need"
            label="I need something"
            title="Get what isn’t sold where you live"
            points={NEEDING}
            button={REGISTER.label}
          />
          <Column
            kind="offer"
            label="I can help"
            title="Shop for others in your country"
            points={HELPING}
            button={REGISTER.label}
          />
        </div>
      </div>
    </section>
  );
}
