import { logger } from "./logger.js";
import { drain, IDLE_POLL_MS } from "./services/jobs.js";

/**
 * The loop that runs the queue inside the API process (#85).
 *
 * NOT started by `createApp()`, and that is deliberate: every test in this
 * project builds an app, and a test suite that quietly starts a worker is a
 * test suite whose jobs run at unpredictable moments. `app.ts` builds, and
 * `server.ts` opens the port and starts this — the same division #1 made for
 * the same reason.
 *
 * Render's free plan has no background workers ($7 a month, and nothing here
 * is paid), so the work happens in the web service. It is awake because the
 * uptime monitor pings it every five minutes (docs/14-deployment.md), and the
 * GitHub Actions backstop drains anything left behind if it ever is not.
 */

let stopping = false;
let running: Promise<void> | null = null;

/** Starts the loop. Returns at once; the work happens behind it. */
export function startWorker(): void {
  if (running) return;

  stopping = false;
  running = loop();
  logger.info({ idlePollMs: IDLE_POLL_MS }, "Job worker started");
}

/**
 * Asks the loop to stop, and waits for the job in hand.
 *
 * Called from the shutdown handler in server.ts. A deploy sends SIGTERM and
 * kills the process a few seconds later; a job interrupted mid-flight is not
 * lost — it is a row whose `runAfter` the claim already pushed forward, so
 * the next process takes it. This is only so the common case ends tidily.
 */
export async function stopWorker(): Promise<void> {
  stopping = true;
  await running;
  running = null;
  logger.info("Job worker stopped");
}

async function loop(): Promise<void> {
  while (!stopping) {
    try {
      const done = await drain(new Date());
      // Work usually arrives in bursts: when there was some, look again at
      // once; when there was none, wait before asking the database again.
      if (done === 0) await sleep(IDLE_POLL_MS);
    } catch (error) {
      // `drain` already catches whatever a single job throws, so reaching
      // here means something underneath it — the database, most likely. A
      // worker that dies of one bad minute stops being a worker.
      logger.error({ error }, "Job worker stumbled, carrying on");
      await sleep(IDLE_POLL_MS);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    // `unref` so a waiting worker cannot be the reason the process refuses to
    // exit: at shutdown the timer is abandoned rather than waited for.
    setTimeout(resolve, ms).unref();
  });
}
