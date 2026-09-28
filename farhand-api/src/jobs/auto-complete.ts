import { prisma } from "../db.js";
import { logger } from "../logger.js";
import { autoCompleteDeals, AUTO_COMPLETE_DAYS } from "../services/deals.js";

/**
 * Completes deals that have been delivered for AUTO_COMPLETE_DAYS.
 *
 * Run with `npm run job:auto-complete`. In production whatever schedules work
 * runs this — a cron entry, a platform scheduler — which is decided when the
 * API is deployed (#31). Deliberately NOT a timer inside the API process: two
 * instances would both fire it, and a web process should serve requests.
 *
 * Safe to run as often as you like. It only ever moves deals that are already
 * past the deadline, and the guarded update means running two copies at once
 * completes each deal exactly once.
 */
async function main(): Promise<void> {
  const completed = await autoCompleteDeals(new Date());

  logger.info(
    { completed, afterDays: AUTO_COMPLETE_DAYS },
    "auto-complete finished",
  );
}

main()
  .catch((error: unknown) => {
    logger.error({ error }, "auto-complete failed");
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
