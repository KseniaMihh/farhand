import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { FOOTER, LANDING_LINKS, NAV, SECTIONS } from "./landing-links";

/**
 * The landing page's one rule, held by two tests — issue #168.
 *
 * TESTS THAT READ THE PROJECT RATHER THAN CALL A FUNCTION, which is unusual
 * enough here to deserve its reason. The thing that can go wrong on a page
 * made of prose is not a miscalculation; it is a link to a screen somebody
 * meant to build. No type checks that, no unit test reaches it, and clicking
 * every link by hand is exactly the check that stops happening in month two.
 * The filesystem knows which routes exist. So ask it.
 *
 *   npm test -- landing-links
 */

const WEB = fileURLToPath(new URL("..", import.meta.url));

/**
 * Every route the app actually serves, read from `app/`.
 *
 * A route is a directory holding a `page.tsx`, minus the route groups: the
 * parentheses in `(site)` and `(landing)` are Next's way of arranging files
 * without touching a URL, so they are dropped. `app/(landing)/page.tsx` is
 * therefore `/`, and `app/(site)/needs/page.tsx` is `/needs`.
 */
function routesOnDisk(): string[] {
  const app = join(WEB, "app");

  return readdirSync(app, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name === "page.tsx")
    .map((entry) => {
      const dir = relative(app, entry.parentPath);
      const segments = dir
        .split(sep)
        .filter((part) => part !== "" && !part.startsWith("("));

      return "/" + segments.join("/");
    })
    .map((route) => (route === "/" ? "/" : route.replace(/\/$/, "")));
}

/** Every file that draws part of the landing page. */
function landingSources(): { name: string; text: string }[] {
  const folders = [
    join(WEB, "app", "(landing)"),
    join(WEB, "components", "landing"),
  ];

  return folders.flatMap((folder) =>
    readdirSync(folder, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".tsx"))
      .map((entry) => {
        const file = join(entry.parentPath, entry.name);
        return { name: relative(WEB, file), text: readFileSync(file, "utf8") };
      }),
  );
}

describe("no link on the landing page is dead", () => {
  /**
   * THE TEST THIS PAGE EXISTS FOR.
   *
   * The design's masthead and footer offer seven destinations that do not
   * exist — Post an offer, Browse offers, Trust & safety as a page,
   * Prohibited items, Community rules, How disputes work, Legal. The product
   * header carries five dead links of its own on purpose, with
   * `app/not-found.tsx` behind them. The front door may not, because it is
   * read by people deciding whether this is a real thing.
   *
   * This fails the day somebody puts "Browse offers" back before that screen
   * is built, which is precisely the day it would otherwise ship.
   */
  it("points every one at a route that exists", () => {
    const routes = routesOnDisk();
    const pages = LANDING_LINKS.filter((link) => !link.href.includes("#"));

    expect(routes).toContain("/");
    expect(pages.length).toBeGreaterThan(0);

    for (const link of pages) {
      expect(routes, `${link.label} → ${link.href}`).toContain(link.href);
    }
  });

  /**
   * A jump link is the dead link nothing catches: no 404, no error, the
   * browser simply does nothing. So the ids are a named list and the page
   * reads them, and a link to one that was never declared fails here.
   */
  it("jumps only to sections this page declares", () => {
    const ids: string[] = Object.values(SECTIONS);
    const jumps = LANDING_LINKS.filter((link) => link.href.includes("#"));

    expect(jumps.length).toBe(ids.length);

    for (const link of jumps) {
      const id = link.href.slice(link.href.indexOf("#") + 1);
      expect(ids, `${link.label} → ${link.href}`).toContain(id);
    }
  });

  /**
   * THE OTHER END OF THE SAME ROPE. The test above says every jump names a
   * declared section; this one says every declared section is actually drawn
   * by something. Without it, `SECTIONS` can list an id that no element on
   * the page carries, and the link still passes while scrolling nowhere.
   */
  it("declares no section that nothing on the page carries", () => {
    const sources = landingSources();

    for (const key of Object.keys(SECTIONS)) {
      const drawn = sources.some(({ text }) =>
        text.includes(`id={SECTIONS.${key}}`),
      );

      expect(drawn, `SECTIONS.${key} is declared and never used`).toBe(true);
    }
  });

  /**
   * The jump links are written as `/#id` rather than `#id` so they work from
   * anywhere — the masthead is in the layout, and `#how-it-works` on a page
   * that has no such section scrolls nowhere.
   */
  it("writes a jump as a path and a fragment, not a bare fragment", () => {
    for (const link of LANDING_LINKS.filter((l) => l.href.includes("#"))) {
      expect(link.href.startsWith("/#"), link.href).toBe(true);
    }
  });
});

/**
 * WHAT MAKES THE TEST ABOVE COMPLETE.
 *
 * Checking the list is worth nothing if a component can write its own
 * `href`, because then the list is not the links — it is some of them. The
 * cheapest way to make the list total is to forbid the alternative, and the
 * cheapest way to forbid it is to read the files.
 */
describe("the landing page writes no link of its own", () => {
  it("has no literal href anywhere in its components", () => {
    const offenders = landingSources()
      .filter(({ text }) => /href=(?:"|'|\{`)/.test(text))
      .map(({ name }) => name);

    expect(offenders).toEqual([]);
  });

  it("reads several files, so a passing run is not an empty one", () => {
    expect(landingSources().length).toBeGreaterThan(5);
  });
});

describe("the arrangements are made of the same links", () => {
  /**
   * The masthead and the footer are two views of one set. If a link can be
   * in the footer without being in `LANDING_LINKS`, the checks above stop
   * covering the footer — quietly, and only for the link that was added
   * last.
   */
  it("draws nothing that is not in the list", () => {
    const known = new Set(LANDING_LINKS.map((link) => link.href));

    for (const link of NAV) expect(known).toContain(link.href);
    for (const column of FOOTER) {
      for (const link of column.links) expect(known).toContain(link.href);
    }
  });

  /**
   * The design calls one destination "Needs" in the masthead and "Browse
   * needs" in the footer. On a page whose job is to be understood quickly,
   * two names for one place is two places.
   */
  it("gives each destination one label", () => {
    const labels = new Map<string, string>();

    for (const link of [...NAV, ...FOOTER.flatMap((c) => c.links)]) {
      const seen = labels.get(link.href);
      if (seen !== undefined) expect(seen).toBe(link.label);
      labels.set(link.href, link.label);
    }
  });
});
