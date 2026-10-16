import { drain } from "../../src/services/jobs.js";

/**
 * Runs whatever the last request queued, the way the worker would a second
 * later (#85).
 *
 * Needed by every test that reads a token out of the mailer: since #85 the
 * request enqueues and answers, and the email is the worker's to send. A test
 * that asks for a reset link and then looks at the mailer is standing in for
 * two seconds passing.
 */
export function runQueuedJobs(): Promise<number> {
  return drain(new Date());
}
