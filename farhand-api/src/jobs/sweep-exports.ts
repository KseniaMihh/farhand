import { prisma } from "../db.js";
import { logger } from "../logger.js";
import { sweepExpiredExports, EXPORT_TTL_MS } from "../services/exports.js";

/**
 * Destroys data exports that have had their seven days (#89).
 *
 * Run with `npm run job:sweep-exports`, scheduled beside the deal sweep in
 * .github/workflows/auto-complete.yml — the same daily run, because both are
 * "a clock has passed, tidy up" and a second schedule would be a second
 * thing that can silently stop firing (#114's lesson).
 *
 * A finished export is a complete copy of somebody's personal history, so it
 * cannot sit in the database until the end of time. What goes is the payload;
 * the row stays, because "an export was made, and when" is itself something
 * somebody may ask about, and it is two timestamps rather than a copy of
 * their life.
 *
 * Safe to run twice: it only clears payloads whose date has passed, and a
 * payload already cleared is not matched.
 */
async function main(): Promise<void> {
  const cleared = await sweepExpiredExports(new Date());

  logger.info(
    { cleared, ttlDays: EXPORT_TTL_MS / (24 * 60 * 60 * 1000) },
    "export sweep finished",
  );
}

main()
  .catch((error: unknown) => {
    logger.error({ error }, "export sweep failed");
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
