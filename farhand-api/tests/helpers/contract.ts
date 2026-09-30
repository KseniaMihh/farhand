import { readFileSync } from "node:fs";
import { createApp } from "../../src/app.js";

/**
 * The two lists issue #69 compares: what `docs/06-api-contract.md` promises,
 * and what the running app actually answers.
 *
 * Version 1 finished with five documented endpoints that had never been built.
 * Nobody noticed for weeks, because nothing was looking. This is the thing that
 * looks — `docs/README.md` rule 3 ("a change to behaviour and the document
 * describing it belong in the same commit"), enforced instead of remembered.
 *
 * Both halves are read rather than listed. A hand-written list of endpoints
 * would be a third place to forget: it would go stale the same way the document
 * did, and the test would keep passing while it did.
 */

/** Where the contract lives, relative to `farhand-api`. */
export const CONTRACT_PATH = "../docs/06-api-contract.md";

/** The methods an endpoint table row may begin with. */
export const METHODS = ["GET", "POST", "PATCH", "PUT", "DELETE"] as const;

/**
 * The guards a marker stands for, in the order a route lists them.
 *
 * Copied from the marker table at the top of the contract, which is the
 * authority — if the two disagree, the table is right and this is the bug
 * (docs/06-api-contract.md, "Who may call an endpoint").
 */
export const MARKER_GUARDS: Record<string, string[]> = {
  "—": [],
  SESSION: ["requireAuth"],
  AUTH: ["requireAuth", "requireVerified", "requireActive"],
  MOD: ["requireAuth", "requireVerified", "requireActive", "requireRole"],
};

/**
 * Middleware that appears in front of a route and grants or refuses nothing.
 *
 * `optionalAuth` notices who is asking without insisting on it — a requester
 * seeing their own drafts through `GET /needs/:id` (#16). A route using it is
 * still marked `—`, because nobody is turned away, so it must not count as a
 * guard when the marker is checked. It must still be *collected*: a walk that
 * never looks for it satisfies the rule by avoiding it, and the test says so.
 */
export const NOT_A_GUARD = new Set(["optionalAuth"]);

/** One row of one endpoint table in the contract. */
export interface DocumentedEndpoint {
  /** `"GET /users/:id"` — method and path, exactly as the document writes it. */
  route: string;
  /** The auth column: `—`, `SESSION`, `AUTH` or `MOD`. */
  marker: string;
  /** The notes column, unparsed. */
  notes: string;
  /** `**Not built**` is in the notes: this endpoint is a promise, not a fact. */
  notBuilt: boolean;
  /** The issue named beside a `**Not built**` marking, if it names one. */
  issue: number | null;
  /** The line it was found on, so a failure can point somebody at it. */
  line: number;
}

/** One route the built app actually answers. */
export interface LiveEndpoint {
  /** `"GET /users/:id"`, in the same shape as DocumentedEndpoint.route. */
  route: string;
  /**
   * The named middleware in front of it, in order — the guards, plus anything
   * in NOT_A_GUARD. Rate limiters and the handler itself are neither of those,
   * and are not here.
   */
  guards: string[];
}

/**
 * Every endpoint row in a piece of Markdown.
 *
 * Takes the text rather than reading the file, and that is not an accident
 * to tidy away: it is what lets the awkward rows be tested as three lines of
 * fixture instead of by editing the real contract. Inlining readFileSync
 * here would look like a simplification and would quietly delete a third of
 * this file's coverage — including the row that has to be refused rather
 * than skipped.
 *
 * A table row is the only thing read. The `###` sections below the tables
 * describe the same endpoints in prose, and prose is not a list: parsing
 * both would mean two answers to one question.
 */
export function parseEndpointRows(markdown: string): DocumentedEndpoint[] {
  const lines = markdown.split("\n");
  const endpoints: DocumentedEndpoint[] = [];

  // entries() rather than an index: with noUncheckedIndexedAccess, lines[i] is
  // string | undefined and needs an assertion to use. This has neither.
  for (const [index, line] of lines.entries()) {
    const lineNumber = index + 1;

    if (!line.trimStart().startsWith("|")) continue;

    // "| GET | `/users/:id` | AUTH | notes |" splits into
    // ["", "GET", "`/users/:id`", "AUTH", "notes", ""] — drop the two empty
    // cells the row's own leading and trailing pipe produce.
    let cells = line.split("|").map((c) => c.trim());
    if (cells[0] === "") cells = cells.slice(1);
    if (cells[cells.length - 1] === "") cells = cells.slice(0, -1);

    const method = cells[0];
    const path = cells[1];
    const marker = cells[2];
    // Cell 4 onward is the notes, rejoined with "|": a notes cell may
    // contain one, and splitting it apart is what this line undoes.
    const notes = cells.slice(3).join("|").trim();

    // Not a method at all: the header row, the separator row, or a
    // query-parameter table. Silently not an endpoint row.
    if (
      method === undefined ||
      !(METHODS as readonly string[]).includes(method)
    ) {
      continue;
    }

    // A method IS present, so this row claims to be an endpoint. If the path
    // isn't in backticks, that's a documentation mistake worth failing loudly
    // for — skipping it would hide a real endpoint from every comparison.
    if (path === undefined || !/^`[^`]+`$/.test(path)) {
      throw new Error(
        `${CONTRACT_PATH}:${String(lineNumber)}: expected the path to be wrapped in backticks, got "${path ?? ""}"`,
      );
    }
    if (marker === undefined) {
      throw new Error(
        `${CONTRACT_PATH}:${String(lineNumber)}: expected a marker cell (—, SESSION, AUTH or MOD)`,
      );
    }

    const cleanPath = path.slice(1, -1);
    const notBuiltIndex = notes.indexOf("**Not built**");
    const notBuilt = notBuiltIndex !== -1;

    // The issue number counts only when it sits beside the "Not built"
    // marking itself — one mentioned earlier in the notes for context is not
    // a promise about this row.
    let issue: number | null = null;
    if (notBuilt) {
      const match = /#(\d+)/.exec(notes.slice(notBuiltIndex));
      if (match) issue = Number(match[1]);
    }

    endpoints.push({
      route: `${method} ${cleanPath}`,
      marker,
      notes,
      notBuilt,
      issue,
      line: lineNumber,
    });
  }

  return endpoints;
}

/** The same, for the real contract. */
export function documentedEndpoints(): DocumentedEndpoint[] {
  return parseEndpointRows(readFileSync(CONTRACT_PATH, "utf8"));
}

/**
 * Every route the app really answers, read from the app itself.
 */
const ALL_GUARD_NAMES = new Set(Object.values(MARKER_GUARDS).flat());

interface ExpressLayer {
  route?: {
    path: string;
    methods: Record<string, boolean>;
    stack: ExpressLayer[];
  };
  handle?: { stack?: ExpressLayer[] };
  name?: string;
}

/**
 * Every route the app really answers, read from the app itself.
 *
 * `createApp()` and then its router, rather than a scan of
 * `src/routes/*.ts`: a router file that exists but was never mounted in
 * `app.ts` answers no requests at all, and a text scan would call it built.
 * What is reachable is the only meaningful answer to "does this endpoint
 * exist" — and a whole router left unmounted is one of the variants this
 * test was checked against.
 *
 * The price is one Express internal. `app.router` was `app._router` before
 * Express 5, so a major upgrade may move it again. That is a deliberate
 * trade: if it moves, this test fails loudly on the next run instead of
 * quietly passing forever, which is the right way round for a test whose
 * whole job is noticing.
 */
export function liveEndpoints(): LiveEndpoint[] {
  const app = createApp();
  const endpoints: LiveEndpoint[] = [];

  function walk(stack: ExpressLayer[]): void {
    for (const layer of stack) {
      if (layer.route) {
        const { path, methods, stack: routeStack } = layer.route;

        const guards: string[] = [];
        for (const middlewareLayer of routeStack) {
          const name = middlewareLayer.name;
          if (!name) continue;
          // requireRole arrives as "requireRole:MODERATOR" — compare and
          // store the part before the colon, so it matches MARKER_GUARDS.
          const baseName = name.split(":")[0] ?? name;
          if (ALL_GUARD_NAMES.has(baseName) || NOT_A_GUARD.has(baseName)) {
            guards.push(baseName);
          }
        }

        for (const method of Object.keys(methods)) {
          endpoints.push({ route: `${method.toUpperCase()} ${path}`, guards });
        }
      } else if (layer.handle?.stack) {
        walk(layer.handle.stack);
      }
    }
  }

  walk((app.router as unknown as { stack: ExpressLayer[] }).stack);

  return endpoints;
}

/**
 * The failure message for a set of routes missing from one side.
 *
 * The message is the product here, not the formatting. A test that says
 * `expected [] to equal [2 items]` has found the drift and told nobody what
 * it was — and the person reading it is usually somebody whose unrelated
 * pull request has just gone red, with no idea what a contract test is. So:
 * the heading, how many, which ones, and what to do about it.
 */
export function describeMissing(
  heading: string,
  routes: string[],
  advice: string,
): string {
  if (routes.length === 0) return "";

  const list = routes.map((route) => `  ${route}`).join("\n");
  return `${heading} (${String(routes.length)}):\n${list}\n${advice}`;
}

/**
 * The failure message for one route whose guards are not what its marker says.
 */
export function describeMarkerMismatch(
  route: string,
  marker: string,
  expected: string[],
  actual: string[],
): string {
  const format = (guards: string[]): string =>
    guards.length === 0 ? "no guards" : guards.join(", ");

  return (
    `${route} is documented ${marker}, which means\n` +
    `  ${format(expected)}\n` +
    `but the route runs\n` +
    `  ${format(actual)}\n` +
    "One of the two is wrong, and which one is a judgement: the marker table\n" +
    "at the top of docs/06-api-contract.md is what defines each marker. #69"
  );
}
