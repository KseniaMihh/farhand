/**
 * Every link the landing page offers — issue #168.
 *
 * WHY A MODULE AND NOT JUST MARKUP. The front door is the one screen where a
 * dead link reads as "this is not a real product", and it is also the screen
 * most likely to grow one: the design's header and footer offer Post an
 * offer, Browse offers, Trust & safety as a page, Prohibited items, Community
 * rules, How disputes work and Legal — seven destinations that do not exist.
 * `components/header.tsx` carries five dead links of its own by decision,
 * with `app/not-found.tsx` behind them to catch the clicks. That is
 * acceptable inside the product, where the person has already decided to be
 * here. It is not acceptable on the page that makes the case.
 *
 * So the landing page has FIVE links and no others, each one named here once.
 * Two tests hold that: one checks every link below against the routes that
 * actually exist on disk, and one checks that no landing component writes an
 * `href` of its own. The second is what makes the first complete.
 *
 * Adding a sixth is not forbidden. Building its screen first is.
 */

export interface LandingLink {
  readonly href: string;
  readonly label: string;
}

/**
 * The ids the in-page links jump to.
 *
 * Here rather than typed into both places, because a jump link whose target
 * was renamed is a dead link that no 404 catches: the browser simply does
 * nothing, and nothing in the build complains.
 */
export const SECTIONS = {
  howItWorks: "how-it-works",
  trust: "trust-and-safety",
} as const;

/** The two that are this same page, so they work the day it ships. */
export const HOW_IT_WORKS: LandingLink = {
  href: `/#${SECTIONS.howItWorks}`,
  label: "How it works",
};

export const TRUST: LandingLink = {
  href: `/#${SECTIONS.trust}`,
  label: "Trust & safety",
};

/** The three things a signed-out visitor can actually do today. */
export const BROWSE: LandingLink = { href: "/needs", label: "Browse needs" };

export const SIGN_IN: LandingLink = { href: "/sign-in", label: "Sign in" };

export const REGISTER: LandingLink = {
  href: "/register",
  label: "Create account",
};

/**
 * ONE LABEL PER DESTINATION, everywhere on the page.
 *
 * The design calls the same place "Needs" in the masthead and "Browse needs"
 * in the footer. On a page whose whole job is to be understood in fifteen
 * seconds, two names for one thing is two things.
 *
 * What is missing and why: "Post a need" and "Post an offer" are the design's
 * main calls to action and neither screen exists, so both columns below end
 * at "Create account" — which is the first real step either way. They come back
 * as their issues land.
 */
export const LANDING_LINKS: readonly LandingLink[] = [
  HOW_IT_WORKS,
  TRUST,
  BROWSE,
  SIGN_IN,
  REGISTER,
];

/** The masthead, left to right. */
export const NAV: readonly LandingLink[] = [
  HOW_IT_WORKS,
  TRUST,
  BROWSE,
  SIGN_IN,
  REGISTER,
];

/**
 * The footer, in columns.
 *
 * The design has three — Use Farhand, Trust, Legal. Legal is empty until
 * there are terms and a privacy policy to point at, and a heading above no
 * links is worse than no column, so there are two. The third comes back with
 * its pages.
 */
export const FOOTER: readonly {
  readonly heading: string;
  readonly links: readonly LandingLink[];
}[] = [
  { heading: "Use Farhand", links: [BROWSE, SIGN_IN, REGISTER] },
  { heading: "Understand it", links: [HOW_IT_WORKS, TRUST] },
];
