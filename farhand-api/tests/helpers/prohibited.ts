import { publishedList } from "../../src/services/prohibited.js";

/**
 * The version a posting has to tick, for the list the harness puts back after
 * every truncation (#87, `tests/setup/truncate.ts`).
 *
 * Read from the database rather than hard-coded, because a fingerprint written
 * into a test file is a number somebody has to recompute by hand the first
 * time the fixture wording changes — exactly the failure the computed version
 * exists to avoid.
 */
export async function currentProhibitedVersion(): Promise<string> {
  return (await publishedList()).version;
}
