import { prisma } from "../db.js";
import { logger } from "../logger.js";

/**
 * Deletes rate-limit windows that have ended (#91).
 *
 * The counters are rewritten in place while a window is live, so the only
 * rows that accumulate are the ones nobody came back for: an address that
 * tried once and never returned. They are harmless and they are not nothing —
 * one row per address per limiter per window, for ever.
 *
 * A clock rather than a trigger, in the same workflow and the same run as the
 * deal sweep and the export sweep (#101, #89): all three are "a clock has
 * passed, tidy up", and a second schedule is a second thing that can silently
 * stop firing, which is exactly what #114 found had happened to the first one.
 *
 * Deleting an expired row changes nothing a client can see — the next request
 * for that key starts a new window either way, because the statement in
 * middleware/rate-limit-store.ts restarts a window that has run out rather
 * than reading it.
 */
export async function sweepRateLimits(): Promise<number> {
  const { count } = await prisma.rateLimit.deleteMany({
    where: { expiresAt: { lte: new Date() } },
  });

  logger.info({ deleted: count }, "swept expired rate-limit windows");

  return count;
}

/**
 * The script the daily workflow runs.
 *
 * Safe to run twice, like the other two: it deletes rows whose deadline has
 * already passed, and a row already deleted is not matched.
 */
async function main(): Promise<void> {
  const deleted = await sweepRateLimits();

  logger.info({ deleted }, "rate-limit sweep finished");
}

// Imported by the test, run by the workflow — so main() only runs when this
// file IS the process, the same shape as the other sweeps.
if (process.argv[1]?.includes("sweep-rate-limits")) {
  main()
    .catch((error: unknown) => {
      logger.error({ error }, "rate-limit sweep failed");
      process.exitCode = 1;
    })
    .finally(() => {
      void prisma.$disconnect();
    });
}
