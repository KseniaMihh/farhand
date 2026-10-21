import { readdirSync, readFileSync } from "node:fs";
import { posix } from "node:path";

/**
 * The two lists issue #92 compares: what `README.md` says is in this project,
 * and what is actually in it.
 *
 * The README's source tree and test table both stopped at `helps.ts`, which is
 * issue #18. Six route files, eight service files and fifteen test files
 * arrived afterwards and appeared in neither — and nobody noticed, because
 * nothing was looking. The same shape of problem as the five documented
 * endpoints that had never been built, which is now tests/contract/endpoints
 * (#69).
 *
 * WHAT IS CHECKED, AND WHAT IS NOT. Existence, both ways: every file has a
 * line and every line names a file. NOT the descriptions beside them — no test
 * can tell whether "who may create, edit and close a need" is still a fair
 * summary, and one that tried would be a test nobody could keep green. The
 * drift this catches is the kind that actually happened: files arriving and
 * nothing saying so.
 */

/** Where the README lives, relative to `farhand-api`. */
export const README_PATH = "../README.md";

/** Reads the README. */
export function readme(): string {
  return readFileSync(README_PATH, "utf8");
}

/**
 * Every file under `directory` whose name `keep` accepts, as posix paths
 * relative to `farhand-api` — the directory the suite runs in.
 */
export function filesUnder(
  directory: string,
  keep: (name: string) => boolean,
): string[] {
  const found: string[] = [];

  const walk = (relative: string): void => {
    for (const entry of readdirSync(relative, { withFileTypes: true })) {
      const path = posix.join(relative, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (keep(entry.name)) found.push(path);
    }
  };

  walk(directory);
  return found.sort();
}

/** Every file the test table has a row for, as `tests/x/y.test.ts`. */
export function testFilesInTable(markdown: string): string[] {
  return rowsOfTableAfter(markdown, "## Tests")
    .map(firstCell)
    .filter((cell) => cell.endsWith(".test.ts"))
    .sort();
}

/**
 * Every `.ts` file the source tree names, as a path relative to
 * `farhand-api` — so the two lists are in the same units and can simply be
 * compared.
 *
 * Paths rather than names, because names are not unique: `needs.ts` is a
 * route and a service, `auth.ts` is a route and a middleware. A check on
 * names alone would pass while a file sat in the wrong branch of the tree.
 *
 * Everything is returned, including the config files and the test files the
 * tree also names. The caller decides what each list is for: every `src` file
 * must BE here (the tree is complete about the code), and everything here
 * must exist (the tree invents nothing). The tests under `tests/` are listed
 * by folder rather than one by one, because the table under "## Tests" is
 * where they are enumerated and twice is once too many.
 */
export function filesInTree(markdown: string): string[] {
  const found: string[] = [];
  // The directory open at each depth, rebuilt as the tree is read — the same
  // way a person reads one.
  const open: string[] = [];

  for (const line of fencedBlockAfter(markdown, "## Project structure").split(
    "\n",
  )) {
    const entry = entryOn(line);
    if (!entry) continue;

    if (entry.name.endsWith("/")) {
      open[entry.depth] = entry.name.slice(0, -1);
      open.length = entry.depth + 1;
      continue;
    }

    if (!entry.name.endsWith(".ts")) continue;

    const path = [...open.slice(0, entry.depth), entry.name].join("/");
    // The tree is drawn from the repository root; the suite runs one level
    // down, inside `farhand-api`. Anything outside it — a workflow, a script
    // — is somebody else's list to check.
    if (path.startsWith("farhand-api/")) {
      found.push(path.slice("farhand-api/".length));
    }
  }

  return found.sort();
}

/* ─────────────────────────── reading markdown ─────────────────────────── */

/**
 * The name and depth a tree line carries, or null if it is not an entry.
 *
 * A line is `│   ` or four spaces per level, then `├── ` or `└── `, then the
 * name, then the description. Four characters per level is what draws the
 * tree, so dividing by four is reading it back.
 */
function entryOn(line: string): { depth: number; name: string } | null {
  const match = /^([\s│]*)[├└]──\s+(\S+)/.exec(line);
  if (!match?.[2]) return null;

  return { depth: Math.floor((match[1] ?? "").length / 4), name: match[2] };
}

/** The rows of the first table under a heading, minus its header. */
function rowsOfTableAfter(markdown: string, heading: string): string[] {
  return sectionAfter(markdown, heading)
    .split("\n")
    .filter((line) => line.trimStart().startsWith("|"))
    .filter((line) => !/^\|[\s|-]+\|$/.test(line.trim()))
    .filter((line) => !line.includes("| What it does |"));
}

/** The contents of the first fenced block under a heading. */
function fencedBlockAfter(markdown: string, heading: string): string {
  const fenced = /```[^\n]*\n([\s\S]*?)```/.exec(
    sectionAfter(markdown, heading),
  );

  if (!fenced?.[1]) {
    throw new Error(`No fenced block under "${heading}" in the README`);
  }

  return fenced[1];
}

/** Everything between a heading and the next one of the same level. */
function sectionAfter(markdown: string, heading: string): string {
  const start = markdown.indexOf(`\n${heading}\n`);
  if (start === -1) throw new Error(`No "${heading}" heading in the README`);

  const rest = markdown.slice(start + heading.length + 2);
  const end = rest.indexOf("\n## ");

  return end === -1 ? rest : rest.slice(0, end);
}

/** The first cell of a table row, with its backticks taken off. */
function firstCell(row: string): string {
  return (row.split("|")[1] ?? "").trim().replace(/`/g, "");
}
