import { prisma } from "../db.js";
import { logger } from "../logger.js";
import { drain } from "../services/jobs.js";

/**
 * Runs whatever is waiting on the queue, once, and stops (#85).
 *
 * The BACKSTOP, not the normal path. Normally the worker inside the API picks
 * a job up about two seconds after it is queued (src/worker.ts); this exists
 * for the case where that process is not running — asleep, crash-looping,
 * mid-deploy — so that "nothing is lost" does not depend on one process being
 * healthy.
 *
 * Run with `npm run job:drain`, scheduled in
 * .github/workflows/drain-queue.yml. Safe to run beside the in-process
 * worker: claiming is `FOR UPDATE SKIP LOCKED`, so two drainers take
 * different jobs rather than the same one twice.
 */
async function main(): Promise<void> {
  const done = await drain(new Date());

  logger.info({ done }, "queue drain finished");
}

main()
  .catch((error: unknown) => {
    logger.error({ error }, "queue drain failed");
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
