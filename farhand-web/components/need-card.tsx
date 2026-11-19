import Link from "next/link";
import { countryName } from "@/lib/countries";
import { photoSrc, price, type NeedCard as Card } from "@/lib/needs";

/**
 * One need, as a card in the list — screen 2.1, issue #166.
 *
 * WHERE THE STYLING WENT. #93 put this screen's look in
 * `app/(site)/page.module.css` and #158 deliberately left it there, with a
 * note: a card nothing else draws is one screen's business, and it should
 * move "the moment a second screen wants one — and that is the issue that
 * should move it". This is that issue. The arrangement is utilities now, by
 * decision 0033, and nothing here earned a name: a card is padding, a radius
 * and a border, none of which encode a decision. `.badge` and the tints did
 * earn theirs, and they are used rather than re-typed.
 */
/**
 * `categoryName` is passed in and optional, because the need itself only
 * carries an id and the names arrive separately. A card drawn before that
 * list lands simply has no chip — which is better than holding the whole
 * list back for a label.
 */
export function NeedCard({
  need,
  categoryName,
}: {
  need: Card;
  categoryName?: string | undefined;
}) {
  return (
    <li>
      {/*
        THE WHOLE CARD IS THE LINK, and its accessible name is the title. A
        separate "read more" gives a screen reader twenty identical links on a
        list of twenty needs, which is twenty ways to go somewhere unnamed.
      */}
      <Link
        href={`/needs/${need.id}`}
        className="group block h-full overflow-hidden rounded-xl border border-line bg-card no-underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pine"
      >
        {/*
          `coverPhoto` is `null` and never absent (#81), so the empty case is
          drawn rather than guessed at. `alt` is empty on purpose: the picture
          repeats the title directly beside it, and announcing both says
          everything twice.
        */}
        {need.coverPhoto === null ? (
          <div
            className="h-44 w-full bg-sage-tint"
            aria-hidden="true"
            data-testid="no-photo"
          />
        ) : (
          <img
            className="h-44 w-full object-cover"
            src={photoSrc(need.coverPhoto)}
            alt=""
            loading="lazy"
          />
        )}

        <div className="p-4">
          <h2 className="font-serif text-lg leading-snug text-pine group-hover:underline">
            {need.title}
          </h2>

          {/* COUNTRY, NEVER CITY — a city is shown to nobody but its owner. */}
          <p className="mt-1 text-sm text-muted">
            {countryName(need.buyCountry)} → {countryName(need.deliverCountry)}
          </p>

          <p className="mt-3 font-serif text-xl text-pine">
            {price(need.estimatedPrice, need.currency)}
          </p>

          {/*
            The thank-you is its OWN line and is never added to the price
            above. The design review found a panel that showed both and then a
            total including the second — €24.00 and €9.50 reading as €38.50.
          */}
          {need.thankYouAmount > 0 && (
            <p className="text-sm text-muted">
              + {price(need.thankYouAmount, need.currency)} thank-you
            </p>
          )}

          <p className="mt-3 line-clamp-2 text-sm text-pine/80">
            {need.description}
          </p>

          {categoryName !== undefined && (
            <p className="mt-3">
              <span className="rounded-full bg-need-tint px-2 py-1 text-xs text-need-ink">
                {categoryName}
              </span>
            </p>
          )}
        </div>
      </Link>
    </li>
  );
}
