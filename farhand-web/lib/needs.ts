/**
 * What a need is, to a screen that draws one — issue #166.
 *
 * Two shapes, because the API sends two. The list sends a card: one cover
 * picture, or `null`. One need's own page sends every photo it has. Keeping
 * them apart in the types is what stops a card quietly reaching for a field
 * only the full answer carries.
 *
 * Neither type is the whole need. The API sends more than this
 * (docs/06-api-contract.md); these are the fields the screens draw, which is
 * the honest subject of a file in `lib/`.
 */

/** The country pair, the money and the picture: what a card shows. */
export interface NeedCard {
  id: string;
  title: string;
  description: string;
  buyCountry: string;
  deliverCountry: string;
  currency: string;
  estimatedPrice: number;
  thankYouAmount: number;
  /**
   * The first photo as a path, or `null` — **never absent**, which is the
   * API's own guarantee (#81). A card with no picture is a case to draw, not
   * one to guess at.
   */
  coverPhoto: string | null;
  /**
   * THE ID, NOT THE CATEGORY. Measured against the running API rather than
   * assumed: `GET /needs` and `GET /needs/:id` both carry `categoryId` and
   * no nested object — unlike offers, which do carry one. A screen that
   * wants the NAME looks it up in `GET /categories` (#159), which it is
   * already fetching for the filter and which may be cached for an hour.
   */
  categoryId: string;
  createdAt: string;
}

/** One photo of a need. Oldest first, which is the order they were added. */
export interface NeedPhoto {
  id: string;
  url: string;
}

/**
 * A need's own page. `status` is here because the requester sees their own
 * drafts and everyone else sees only `OPEN` and `MATCHED` — so the screen has
 * to be able to say which it is looking at (2.2a, 2.2c).
 */
/**
 * A need's own page.
 *
 * NO REQUESTER OBJECT, measured the same way: this answer carries
 * `requesterId` and nothing else about them. Naming the person who asked
 * would mean a second request to the public profile — which is screen 2.5,
 * is not one of the seven, and whose link this page does not have anywhere to
 * point at yet. So the page does not name them, by the standing rule: where
 * the design asks for something the contract does not carry, build less.
 */
export interface Need extends Omit<NeedCard, "coverPhoto"> {
  status: string;
  productUrl: string | null;
  storeName: string | null;
  photos: NeedPhoto[];
}

/**
 * Money, as a person reads it.
 *
 * Whole cents everywhere in this product (decision 0006), so the division
 * belongs at the edge — here — and nowhere else.
 *
 * #93 had a copy of this inside the browse screen; both screens use this one
 * now, because two copies of a money format is how one of them learns about a
 * currency the other does not.
 */
export function price(amount: number, currency: string): string {
  return new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency,
  }).format(amount / 100);
}

/**
 * THE TWO AMOUNTS ARE NEVER ADDED UP, and this file is where that is
 * enforced rather than remembered.
 *
 * `estimatedPrice` is what the product costs. `thankYouAmount` is what the
 * requester offers for the trouble. They are separate integers beside one
 * currency, and the design review found a panel that showed them as two
 * lines and a total that silently included both — €24.00 and €9.50 reading
 * as €38.50.
 *
 * There is deliberately no `total()` in this file. If one is ever wanted, it
 * is a decision about what a total means here, not a convenience.
 *
 * TODO (#166): a test that asserts this module exports no sum. That sounds
 * absurd and is the cheapest way to make the next person argue for it.
 */

/**
 * A photo path from the API, as something an `<img>` can load.
 *
 * **THE `/api` PREFIX IS NOT DECORATION.** The API answers paths relative to
 * itself — `coverPhoto` is `/files/3f1c…`, and so is every `photos[].url`.
 * In a browser those resolve against *our* origin, where nothing serves
 * `/files`, so without this every picture on both screens is broken. Under
 * `/api` they reach the proxy, which redirects to a signed link that expires
 * in five minutes (#79); an `<img>` follows that redirect by itself.
 *
 * One function for both fields, and it lives here rather than in a component
 * because it is the same rule in two places and a component is where one
 * copy of it would be forgotten.
 *
 * Idempotent, because a path that already carries the prefix is somebody
 * calling this twice, and silently doubling it would produce
 * `/api/api/files/…` — a 404 that looks like a missing photo rather than a
 * mistake in the code.
 */
export function photoSrc(path: string): string {
  return path.startsWith("/api/") ? path : `/api${path}`;
}
