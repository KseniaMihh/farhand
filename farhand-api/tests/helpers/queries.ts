import { prisma } from "../../src/db.js";

/**
 * What the database was actually asked, while something was happening.
 *
 * Written for #102, where the cost of showing a page of images turned out to
 * be four statements per image instead of two — a fact no amount of reading
 * the code produced, because `include` looks like one query. Moved here by
 * #81, whose list answers have the same shape of risk: one query for a page
 * of needs' photos, never one per need.
 *
 * The client announces its statements while NODE_ENV is test (src/db.ts),
 * which is the same seam tests/helps/browse.test.ts uses to EXPLAIN the browse
 * query.
 */

interface QueryEvent {
  query: string;
  params: string;
}

/** The statements the shared client sent while `run` was happening. */
export async function statementsDuring(
  run: () => Promise<unknown>,
): Promise<string[]> {
  const seen: string[] = [];
  // The `$on` type only exists when query logging is on — hence the cast.
  const client = prisma as unknown as {
    $on: (event: "query", listener: (event: QueryEvent) => void) => void;
  };

  client.$on("query", (event) => {
    seen.push(event.query);
  });

  await run();
  // The event is emitted after the query resolves, so give it a tick to land.
  await new Promise((resolve) => setTimeout(resolve, 50));

  return seen;
}

/** Which tables were SELECTed, in order, once each. */
export function tablesRead(statements: string[]): string[] {
  const tables: string[] = [];
  for (const sql of statements) {
    if (!sql.includes("SELECT")) continue;
    const match = /FROM "public"\."(\w+)"/.exec(sql);
    if (match?.[1] && !tables.includes(match[1])) tables.push(match[1]);
  }
  return tables;
}

/** How many SELECTs touched one table. */
export function selectsOf(statements: string[], table: string): number {
  return statements.filter(
    (sql) => sql.includes("SELECT") && sql.includes(`FROM "public"."${table}"`),
  ).length;
}
