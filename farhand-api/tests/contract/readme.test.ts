import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  filesInTree,
  filesUnder,
  readme,
  testFilesInTable,
} from "../helpers/readme.js";

/**
 * The README and the project, checked against each other — issue #92.
 *
 * The source tree and the test table both stopped describing this project
 * around issue #18. Six route files, eight service files and fifteen test
 * files arrived afterwards and appeared in neither. Nobody noticed because
 * nothing was looking, which is word for word why tests/contract/endpoints
 * exists (#69) — so this is its neighbour, in the same folder, doing the same
 * job for the document somebody actually reads first.
 *
 * It checks EXISTENCE, both ways, and nothing else. Whether a description is
 * still fair is a judgment, and a test that tried to make it would be one
 * nobody could keep green. What this catches is a file arriving and nothing
 * saying so — which is exactly what happened.
 *
 * It touches no database and starts no server, like its neighbour.
 */

const markdown = readme();

const sourceFiles = filesUnder("src", (name) => name.endsWith(".ts"));
const testFiles = filesUnder("tests", (name) => name.endsWith(".test.ts"));

const inTree = filesInTree(markdown);
const describedSource = inTree.filter((file) => file.startsWith("src/"));
const describedTests = testFilesInTable(markdown);

describe("the source tree in the README", () => {
  it("names every source file", () => {
    const missing = sourceFiles.filter(
      (file) => !describedSource.includes(file),
    );

    expect(
      missing,
      `Add these to the tree under "## Project structure": ${missing.join(", ")}`,
    ).toEqual([]);
  });

  /**
   * Everything the tree names, not only the `src` half: a config file that
   * was renamed and a test folder that moved are the same kind of lie as a
   * service that was never there.
   */
  it("names nothing that is not there", () => {
    const imaginary = inTree.filter((file) => !existsSync(file));

    expect(
      imaginary,
      `The tree names files that do not exist: ${imaginary.join(", ")}`,
    ).toEqual([]);
  });

  it("reads the tree rather than trusting it, which is the half that could go wrong", () => {
    // If the parsing silently found nothing, the two tests above would pass
    // by comparing empty lists — the failure mode of every checker that reads
    // a document. A number and three names are the cheapest guard against it.
    expect(describedSource.length).toBeGreaterThan(50);
    expect(describedSource).toContain("src/app.ts");
    expect(describedSource).toContain("src/services/needs.ts");
    // Two files with one name, in different branches: the reason the tree is
    // read as paths and not as names.
    expect(describedSource).toContain("src/routes/needs.ts");
  });
});

describe("the test table in the README", () => {
  it("has a row for every test file", () => {
    const missing = testFiles.filter((file) => !describedTests.includes(file));

    expect(
      missing,
      `Add a row under "## Tests" for: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("has no row for a test that does not exist", () => {
    const imaginary = describedTests.filter(
      (file) => !testFiles.includes(file),
    );

    expect(
      imaginary,
      `The table has rows for files that do not exist: ${imaginary.join(", ")}`,
    ).toEqual([]);
  });

  it("says what each one is for, in a sentence rather than a word", () => {
    const rows = markdown
      .split("\n")
      .filter((line) => line.startsWith("|") && line.includes(".test.ts`"));
    const thin = rows.filter(
      (row) => (row.split("|")[2] ?? "").trim().split(" ").length < 4,
    );

    // The table is a map of what is covered. A row reading "tests things"
    // satisfies both tests above and tells nobody anything, so the one
    // judgment this file does make is that a description is a sentence.
    expect(thin, `These rows say too little: ${thin.join(" / ")}`).toEqual([]);
  });
});
