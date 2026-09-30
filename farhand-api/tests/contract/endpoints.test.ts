import { describe, expect, it } from "vitest";
import {
  describeMarkerMismatch,
  describeMissing,
  documentedEndpoints,
  liveEndpoints,
  MARKER_GUARDS,
  NOT_A_GUARD,
  parseEndpointRows,
} from "../helpers/contract.js";

/**
 * The contract and the code, checked against each other — issue #69.
 *
 * These tests are the specification. They fail until the TODOs in
 * tests/helpers/contract.ts are filled in.
 *
 *   npm run test:watch -- endpoints
 *
 * Version 1 was declared feature-complete with five endpoints documented and
 * never built. Every one of them was somebody's afternoon, and none of them was
 * anybody's mistake: the document and the code simply had nothing holding them
 * together. This file is that thing.
 *
 * It touches no database and starts no server — it builds the app only to read
 * its routing table. So it is the fastest file in the suite, and the one most
 * likely to fail on a pull request that forgot a document.
 */

const documented = documentedEndpoints();
const live = liveEndpoints();

const documentedRoutes = new Set(documented.map((e) => e.route));
const liveRoutes = new Set(live.map((e) => e.route));
const guardsOf = new Map(live.map((e) => [e.route, e.guards]));

/* ───────────────────────── reading the document ───────────────────────── */

describe("reading an endpoint table", () => {
  const TABLE = [
    "| Method | Path | Auth | Notes |",
    "|---|---|---|---|",
    "| GET | `/needs` | — | Only `OPEN` |",
    "| POST | `/needs` | AUTH | Limited to 5 per account |",
    "| DELETE | `/me` | AUTH | Anonymise. **Not built** — #66 |",
  ].join("\n");

  it("reads a row into a method, a path, a marker and a line number", () => {
    const rows = parseEndpointRows(TABLE);

    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({
      route: "GET /needs",
      marker: "—",
      notBuilt: false,
      issue: null,
      line: 3,
    });
  });

  it("keeps the document's own order", () => {
    expect(parseEndpointRows(TABLE).map((e) => e.route)).toEqual([
      "GET /needs",
      "POST /needs",
      "DELETE /me",
    ]);
  });

  it("reads a Not built marking and the issue beside it", () => {
    const row = parseEndpointRows(TABLE).at(-1);

    expect(row).toMatchObject({ notBuilt: true, issue: 66 });
  });

  it("reads a Not built marking with no issue as unexplained", () => {
    const rows = parseEndpointRows("| DELETE | `/me` | AUTH | **Not built** |");

    expect(rows[0]).toMatchObject({ notBuilt: true, issue: null });
  });

  /**
   * An issue number elsewhere in the notes is not a promise about this row.
   * Half the notes column cites an issue for context.
   */
  it("does not treat a passing mention of an issue as a marking", () => {
    const rows = parseEndpointRows("| GET | `/needs` | — | Paging as in #16 |");

    expect(rows[0]).toMatchObject({ notBuilt: false, issue: null });
  });

  /**
   * The sharp version of the test above. Half the notes column cites an issue
   * for context, so "the number in the notes" and "the number this marking
   * names" are different questions — and a parser that scans the whole cell
   * answers the first while looking like it answered the second.
   */
  it("takes the issue beside the marking, not an earlier mention", () => {
    const rows = parseEndpointRows(
      "| GET | `/admin/users` | MOD | As sketched in #27. **Not built** — #67 |",
    );

    expect(rows[0]).toMatchObject({ notBuilt: true, issue: 67 });
  });

  it("reads a marking with no issue as unexplained, however the notes read", () => {
    const rows = parseEndpointRows(
      "| DELETE | `/me` | AUTH | Anonymise, see #10. **Not built** |",
    );

    expect(rows[0]).toMatchObject({ notBuilt: true, issue: null });
  });

  /** The query-parameter tables have the same pipes and no method. */
  it("ignores a table that is not about endpoints", () => {
    const rows = parseEndpointRows(
      [
        "| Query | Meaning |",
        "|---|---|",
        "| `buyCountry` | Two letters |",
        "| `limit` | 1–50, default 20 |",
      ].join("\n"),
    );

    expect(rows).toEqual([]);
  });

  it("ignores prose that happens to mention a method", () => {
    const rows = parseEndpointRows(
      "A `GET /needs` request returns only open needs.",
    );

    expect(rows).toEqual([]);
  });

  /**
   * The one that must not be quiet. A row written without backticks looks like
   * an endpoint and parses like nothing, so it would vanish from every
   * comparison below — this file's own failure mode, arriving as silence.
   * Refusing it is the difference between a guard and a decoration.
   */
  it("refuses a row that looks like an endpoint but has no backticks", () => {
    expect(() =>
      parseEndpointRows(
        ["| Method | Path |", "|---|---|", "| GET | /needs | — | Open |"].join(
          "\n",
        ),
      ),
    ).toThrow();
  });

  it("says which line the unreadable row is on", () => {
    let message = "";
    try {
      parseEndpointRows(["", "", "| GET | /needs | — | Open |"].join("\n"));
    } catch (error) {
      message = error instanceof Error ? error.message : "";
    }

    expect(message).toContain("3");
  });
});

/* ──────────────────── the two lists were actually read ──────────────────── */

describe("the two lists were actually read", () => {
  /**
   * The most important tests in the file, and the least interesting to read.
   *
   * Everything below compares two lists. If either parser quietly stops
   * matching — a table gains a column, Express renames its router, a file moves
   * — then both lists come back empty, every comparison passes, and the guard is
   * off with nothing to show it. A test that cannot fail is worse than no test
   * (CLAUDE.md).
   *
   * The numbers are a floor, not a count: this must not be a test that has to be
   * edited every time an endpoint is added.
   */
  it("found a plausible number of documented endpoints", () => {
    expect(documented.length).toBeGreaterThan(40);
  });

  it("found a plausible number of live endpoints", () => {
    expect(live.length).toBeGreaterThan(40);
  });

  /** A walk that never recursed into the mounted routers would find nothing. */
  it("found routes from more than one router", () => {
    const areas = new Set(
      [...liveRoutes].map((route) => route.split(" ")[1]?.split("/")[1]),
    );

    expect(areas.size).toBeGreaterThan(5);
  });

  it("found the guards, not just the paths", () => {
    const guarded = live.filter((e) => e.guards.includes("requireAuth"));

    expect(guarded.length).toBeGreaterThan(20);
  });

  /**
   * "optionalAuth is not a guard" is a rule with two halves: the walk has to
   * see it, and the comparison has to ignore it. An implementation can satisfy
   * the second half by accident — by never collecting it in the first place —
   * and then the rule is not being followed, it is being avoided. So both
   * halves are named here, on the two routes that actually use it.
   *
   * If either route stops reading the session, this test fails and should: a
   * requester who can no longer see their own drafts through `GET /needs/:id`
   * is a behaviour change (#16), not an implementation detail.
   */
  it.each(["GET /needs/:id", "GET /helps/:id"])(
    "sees optionalAuth in front of %s, and still calls it public",
    (route) => {
      expect(guardsOf.get(route)).toEqual(["optionalAuth"]);
      expect(NOT_A_GUARD.has("optionalAuth")).toBe(true);
    },
  );

  /** Rate limiters and handlers are middleware too, and are not guards. */
  it("counted only guards as guards", () => {
    const vocabulary = new Set([
      ...Object.values(MARKER_GUARDS).flat(),
      ...NOT_A_GUARD,
    ]);
    const strangers = live.flatMap((e) =>
      e.guards.filter((guard) => !vocabulary.has(guard)),
    );

    expect(strangers).toEqual([]);
  });
});

/* ─────────────────────── the comparison, both ways ─────────────────────── */

describe("every documented endpoint exists", () => {
  it("or says which issue will build it", () => {
    const missing = documented
      .filter((e) => !e.notBuilt && !liveRoutes.has(e.route))
      .map((e) => e.route);

    expect(
      missing,
      describeMissing(
        "Documented but not built",
        missing,
        "Build it, or mark the row **Not built** — #NN if the gap is deliberate.",
      ),
    ).toEqual([]);
  });

  /**
   * The other direction of the same marking. A gap that gets filled and left
   * marked is a document lying in the safer-sounding direction, and a reader
   * still does not know what the API answers.
   */
  it("and nothing is still marked Not built after being built", () => {
    const stale = documented
      .filter((e) => e.notBuilt && liveRoutes.has(e.route))
      .map((e) => e.route);

    expect(
      stale,
      describeMissing(
        "Marked Not built, but built",
        stale,
        "Delete the marking: the endpoint answers requests.",
      ),
    ).toEqual([]);
  });

  /**
   * A marking has to name the issue that will build it, or "not built" becomes
   * a way of switching this test off one row at a time — and a gap with no
   * issue is a gap nobody has decided about.
   */
  it("and every Not built marking names an issue", () => {
    const unexplained = documented
      .filter((e) => e.notBuilt && e.issue === null)
      .map((e) => `${e.route}  (line ${String(e.line)})`);

    expect(
      unexplained,
      describeMissing(
        "Marked Not built without an issue number",
        unexplained,
        'Write it as "**Not built** — #NN", naming the issue that will build it.',
      ),
    ).toEqual([]);
  });
});

describe("every endpoint that exists is documented", () => {
  it("with no undocumented routes answering requests", () => {
    const undocumented = [...liveRoutes].filter(
      (route) => !documentedRoutes.has(route),
    );

    expect(
      undocumented,
      describeMissing(
        "Built but not documented",
        undocumented,
        "Add a row to the right table in docs/06-api-contract.md. There is no OpenAPI file — that document is the specification.",
      ),
    ).toEqual([]);
  });
});

/* ───────────────────────────── the auth column ───────────────────────────── */

describe("the auth column matches the guards in front of the route", () => {
  it("uses only markers the contract defines", () => {
    const unknown = documented
      .filter((e) => MARKER_GUARDS[e.marker] === undefined)
      .map((e) => `${e.route}  marker "${e.marker}"  (line ${String(e.line)})`);

    expect(unknown).toEqual([]);
  });

  /**
   * One test per endpoint rather than one for all of them: when this fails, the
   * name of the failing test is already half the answer, and a second mismatch
   * is not hidden behind the first.
   *
   * Skipped for rows honestly marked as not built — they have no guards to
   * check, and the test above is the one that watches them.
   */
  const checkable = documented.filter(
    (e) => !e.notBuilt && MARKER_GUARDS[e.marker] !== undefined,
  );

  it.each(checkable.map((e) => [e.route, e.marker] as const))(
    "%s is %s",
    (route, marker) => {
      const expected = MARKER_GUARDS[marker] ?? [];
      const actual = (guardsOf.get(route) ?? []).filter(
        (guard) => !NOT_A_GUARD.has(guard),
      );

      expect(
        actual,
        describeMarkerMismatch(route, marker, expected, actual),
      ).toEqual(expected);
    },
  );

  /**
   * The lists above are compared in order, which is easy to dismiss as
   * pedantry. It is not: requireVerified and requireActive both call getAuth(),
   * which throws if requireAuth has not run — so a route whose guards are in the
   * wrong order answers 500 where it meant to answer 401
   * (src/middleware/auth.ts).
   */
  it("never puts a real guard before requireAuth", () => {
    const wrong = live
      .filter((e) => {
        const real = e.guards.filter((guard) => !NOT_A_GUARD.has(guard));
        return real.length > 0 && real[0] !== "requireAuth";
      })
      .map((e) => `${e.route}  [${e.guards.join(", ")}]`);

    expect(wrong).toEqual([]);
  });
});

/* ──────────────────────── the message it fails with ──────────────────────── */

describe("the failure message", () => {
  /**
   * Asserted directly, because nothing else can. Every use of these messages is
   * inside an expectation that passes, so a version of them that returned an
   * empty string would leave the whole suite green and every future failure
   * unreadable.
   */
  it("names the count, every route, and what to do", () => {
    const message = describeMissing(
      "Documented but not built",
      ["DELETE /me", "GET /admin/users"],
      "Mark the row if the gap is deliberate.",
    );

    expect(message).toContain("Documented but not built");
    expect(message).toContain("(2)");
    expect(message).toContain("DELETE /me");
    expect(message).toContain("GET /admin/users");
    expect(message).toContain("Mark the row if the gap is deliberate.");
  });

  it("says nothing when there is nothing missing", () => {
    expect(describeMissing("Documented but not built", [], "advice")).toBe("");
  });

  it("names the route, the marker and both lists of guards", () => {
    const message = describeMarkerMismatch(
      "GET /admin/reports",
      "MOD",
      ["requireAuth", "requireVerified", "requireActive", "requireRole"],
      ["requireAuth"],
    );

    expect(message).toContain("GET /admin/reports");
    expect(message).toContain("MOD");
    expect(message).toContain("requireVerified");
    expect(message).toContain("requireRole");
    expect(message).toContain("requireAuth");
  });

  it("writes an empty list of guards as words, not as a blank", () => {
    const message = describeMarkerMismatch(
      "GET /needs",
      "—",
      [],
      ["requireAuth"],
    );

    expect(message).toContain("no guards");
  });
});
