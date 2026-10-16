import type { Job, Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { logger } from "../logger.js";
import { mailer } from "../mailer.js";
import { reportError } from "../observability.js";
import {
  createPasswordResetToken,
  createVerificationToken,
} from "../tokens.js";

/**
 * Work that happens after the answer (#85).
 *
 * Three things wanted this, and the third is the one that decided its shape:
 *
 *   docs/08-scope.md         email "through a background job queue"
 *   #86                      notifications, which are the easy half
 *   docs/06-api-contract.md  "a real account costs one extra database write,
 *                             so it answers a few milliseconds slower than an
 *                             unknown email"
 *
 * That last one is a timing oracle: whatever the answer says, the clock tells
 * a stranger whether an address has an account here. The complete fix is for
 * the REQUEST to do the same work either way — write one row, say the same
 * sentence — and leave the deciding to something nobody is timing.
 *
 * A table of our own rather than a library, because a library brings its own
 * schema and its own migrations, and this project's first rule is that
 * `schema.prisma` describes the data model
 * (docs/10-decisions/0019-a-job-table-of-our-own.md).
 */

/** How many times a job is tried before it is left alone and reported. */
export const MAX_ATTEMPTS = 5;

/**
 * How long to wait after each failure: a minute, then five, then twenty-five.
 *
 * Exponential, because the usual reason a job fails is that somebody else's
 * service is having a bad minute, and trying again immediately is how a bad
 * minute becomes a bad hour.
 */
export const BACKOFF_BASE_MS = 60_000;

/** How often the worker looks for work when it found none last time. */
export const IDLE_POLL_MS = 2_000;

/**
 * What the queue can be asked to do.
 *
 * A string in the database and a union here: adding a kind should not be a
 * migration, but calling `enqueue("verifcation-email")` should not compile.
 */
export type JobKind = "verification-email" | "password-reset-email";

export interface JobPayloads {
  "verification-email": { email: string };
  "password-reset-email": { email: string };
}

/**
 * Puts work on the queue.
 *
 * One insert, and it costs the same whatever the payload says — that is the
 * whole timing argument. This does NOT look anything up, does not check
 * whether there is anybody to email, and does not care.
 *
 * Takes an optional client so a caller already inside a transaction can
 * enqueue in it: a job that exists for a row that was rolled back is a job
 * that will fail forever (the lesson #79 learned about bytes and rows).
 */
export async function enqueue<K extends JobKind>(
  kind: K,
  payload: JobPayloads[K],
  client: Prisma.TransactionClient = prisma,
): Promise<void> {
  await client.job.create({ data: { kind, payload } });
}

/**
 * Takes one job that is due, and leaves it taken.
 *
 * `FOR UPDATE SKIP LOCKED`, the standard way to hand rows to competing
 * workers: the row is locked by the transaction that claimed it, and another
 * worker looking at the same moment steps over it rather than queueing behind
 * it. This project already uses `FOR UPDATE` for the photo and receipt
 * limits; `SKIP LOCKED` is the half that makes it a queue rather than a line.
 *
 * THE CLAIM ALSO PUSHES `runAfter` FORWARD, and that is what makes a crashed
 * worker harmless: the row is not held by a lock that died with the process,
 * it is simply not due again for a while. Nothing is lost, only late.
 *
 * The lock is released the moment this returns, so the handler — which talks
 * to somebody else's server — does not hold a database connection while it
 * waits (#82's reasoning about where a transaction may not stretch).
 */
async function claimNext(now: Date): Promise<Job | null> {
  return prisma.$transaction(async (tx) => {
    const [due] = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM "Job"
      WHERE "doneAt" IS NULL AND "failedAt" IS NULL AND "runAfter" <= ${now}
      ORDER BY "runAfter" ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1`;

    if (!due) return null;

    return tx.job.update({
      where: { id: due.id },
      data: {
        attempts: { increment: 1 },
        // The lease: if this process dies before finishing, the job comes
        // back by itself rather than sitting there forever.
        runAfter: nextAttemptAt(now, 1),
      },
    });
  });
}

/** When a job that has failed `attempts` times may be tried again. */
function nextAttemptAt(now: Date, attempts: number): Date {
  return new Date(now.getTime() + BACKOFF_BASE_MS * 5 ** (attempts - 1));
}

/**
 * Runs one job, and decides what its failure means.
 *
 *   it worked        doneAt
 *   it failed        runAfter pushed back, lastError kept
 *   it failed MAX    failedAt, and #29 hears about it
 *
 * A failing job is never deleted and never silently dropped: the row is the
 * only evidence that somebody's email did not arrive.
 *
 * Returns whether there was anything to do, so the loop knows whether to
 * sleep.
 */
export async function runOne(now: Date): Promise<boolean> {
  const job = await claimNext(now);
  if (!job) return false;

  try {
    await run(job);
    await prisma.job.update({
      where: { id: job.id },
      data: { doneAt: new Date() },
    });
  } catch (error) {
    await recordFailure(job, error, now);
  }

  return true;
}

/** Hands a job to the handler for its kind. */
async function run(job: Job): Promise<void> {
  const handler = handlers[job.kind as JobKind] as
    ((payload: unknown) => Promise<void>) | undefined;

  if (!handler) {
    // A kind nobody handles is a deploy that went backwards, or a typo that
    // got past the union. Either way it is not retryable.
    throw new Error(`No handler for job kind "${job.kind}"`);
  }

  await handler(job.payload);
}

async function recordFailure(
  job: Job,
  error: unknown,
  now: Date,
): Promise<void> {
  const because =
    error instanceof Error ? `${error.name}: ${error.message}` : "unknown";
  const givenUp = job.attempts >= MAX_ATTEMPTS;

  await prisma.job.update({
    where: { id: job.id },
    data: {
      lastError: because.slice(0, 1000),
      failedAt: givenUp ? now : null,
      runAfter: givenUp ? job.runAfter : nextAttemptAt(now, job.attempts),
    },
  });

  logger.error(
    { jobId: job.id, kind: job.kind, attempts: job.attempts, because },
    givenUp ? "Job failed for the last time" : "Job failed, will try again",
  );

  if (givenUp) {
    // Nothing is silently swallowed (#29). Somebody's email never arrived,
    // and this is the moment anybody could find out.
    reportError(new Error(`Job "${job.kind}" gave up: ${because}`), {});
  }
}

/**
 * Runs everything that is due, and stops.
 *
 * What the GitHub Actions backstop calls, and what a test calls instead of
 * waiting for a loop. The in-process worker is this plus patience.
 *
 * `limit` is a ceiling on one pass, so a queue that is filling faster than it
 * drains cannot keep one call running forever.
 */
export async function drain(now: Date, limit = 100): Promise<number> {
  let done = 0;

  while (done < limit) {
    if (!(await runOne(now))) break;
    done += 1;
  }

  return done;
}

/**
 * What each kind of job actually does.
 *
 * The handler is where the deciding happens — including "is there anybody to
 * email at all", which is the question the request deliberately does not ask.
 * An address with no account is not an error: it is the answer, and the job
 * is done rather than failed. Otherwise every stranger's typo becomes an
 * incident report.
 */
const handlers: {
  [K in JobKind]: (payload: JobPayloads[K]) => Promise<void>;
} = {
  "verification-email": async ({ email }) => {
    const user = await prisma.user.findUnique({ where: { email } });

    // The same rule `POST /auth/resend-verification` used to hold: a real
    // account, not yet verified, not banned or deleted. `?.emailVerifiedAt
    // === null` is also "and the user exists", since undefined === null is
    // false — careful if it is ever changed to `!== null`.
    if (
      user?.emailVerifiedAt === null &&
      user.status !== "BANNED" &&
      user.status !== "DELETED"
    ) {
      const token = await createVerificationToken(prisma, user.id);
      await mailer.sendVerificationEmail(user.email, token);
    }
  },

  "password-reset-email": async ({ email }) => {
    const user = await prisma.user.findUnique({ where: { email } });

    // Unverified users DO get a code — using it proves they own the address,
    // the same as verification does. Banned and deleted accounts do not:
    // there is nothing useful a reset could do for an account nobody can
    // sign in to.
    if (user && user.status !== "BANNED" && user.status !== "DELETED") {
      const token = await createPasswordResetToken(prisma, user.id);
      await mailer.sendPasswordResetEmail(user.email, token);
    }
  },
};
