import type { Job } from "@prisma/client";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/app.js";
import { prisma } from "../../src/db.js";
import { logger } from "../../src/logger.js";
import { mailer } from "../../src/mailer.js";
import * as observability from "../../src/observability.js";
import {
  BACKOFF_BASE_MS,
  drain,
  enqueue,
  MAX_ATTEMPTS,
  runOne,
} from "../../src/services/jobs.js";
import { signUpAndLogIn } from "../helpers/auth.js";
import { statementsDuring, tablesRead } from "../helpers/queries.js";

/**
 * The background job queue (#85).
 *
 * Three things wanted it, and the third decided its shape: a request that does
 * MORE work when an account exists tells a stranger that the account exists,
 * however carefully the answer is worded. `POST /auth/forgot-password` has
 * admitted to that in the contract since #13.
 *
 * So the request enqueues, always, and the worker decides. These tests are
 * mostly about the two halves of that: the queue being a real queue, and the
 * request path being identical either way.
 *
 * The LOOP is not tested — it is `setTimeout` around `drain`, and a test that
 * waits for it would be a test about timers. `drain` is what the tests call,
 * and what the GitHub Actions backstop calls too.
 */

const app = createApp();

/**
 * The clock these tests run on.
 *
 * A fixed instant, and safe to be fixed only because `due()` below pins every
 * row to it. Nothing here reads the real time.
 */
const NOW = new Date("2026-10-16T12:00:00.000Z");
const later = (ms: number) => new Date(NOW.getTime() + ms);

beforeEach(async () => {
  await signUpAndLogIn(app, "anna@example.com", "Anna");
});

afterEach(() => {
  vi.restoreAllMocks();
});

function jobs(): Promise<Job[]> {
  return prisma.job.findMany({ orderBy: { createdAt: "asc" } });
}

async function onlyJob(): Promise<Job> {
  const all = await jobs();
  expect(all).toHaveLength(1);
  if (!all[0]) throw new Error("expected one job");
  return all[0];
}

/** Registration leaves a verification job behind; clear it to test in peace. */
async function emptyQueue(): Promise<void> {
  await prisma.job.deleteMany({});
}

/**
 * Makes everything on the queue due at `at`, which is `NOW` unless a test
 * says otherwise.
 *
 * NEEDED BY EVERY TEST THAT DRAINS, and the reason is worth the paragraph.
 * `enqueue` leaves `runAfter` at the DATABASE's `now()`, while these tests
 * drain at a fixed `NOW` — so a job is only due if the real clock happens to
 * be behind that constant. The first version of this file left it at that: it
 * passed all morning here, then failed eleven tests in CI at 12:01 UTC, and
 * would have failed every run from then on. Worse, three of the tests that
 * still passed were passing for the wrong reason — "nothing was sent" is true
 * of a job nobody looked at.
 *
 * Pinning the row makes the file say what it means: time in these tests is
 * `NOW` and whatever a test does to it, never the wall clock.
 */
async function due(at: Date = NOW): Promise<void> {
  await prisma.job.updateMany({ data: { runAfter: at } });
}

describe("putting work on the queue", () => {
  it("writes one row, and does not do the work", async () => {
    await emptyQueue();
    const sent = vi.spyOn(mailer, "sendVerificationEmail");

    await enqueue("verification-email", { email: "anna@example.com" });

    expect(await onlyJob()).toMatchObject({
      kind: "verification-email",
      payload: { email: "anna@example.com" },
      attempts: 0,
      doneAt: null,
      failedAt: null,
    });
    expect(sent).not.toHaveBeenCalled();
  });

  it("carries nothing secret: the token is the worker's to make", async () => {
    await emptyQueue();
    await enqueue("password-reset-email", { email: "anna@example.com" });

    // A token in a queue row is a token at rest in a table that is not the
    // token table, with no expiry anybody enforces (#119's rule about where
    // tokens may live).
    const job = await onlyJob();
    expect(JSON.stringify(job.payload)).toBe(
      JSON.stringify({ email: "anna@example.com" }),
    );
  });

  it("can ride inside a transaction, and dies with it", async () => {
    await emptyQueue();

    await expect(
      prisma.$transaction(async (tx) => {
        await enqueue("verification-email", { email: "ghost@example.com" }, tx);
        throw new Error("the rest of the work failed");
      }),
    ).rejects.toThrow(
      // Named, or this passes while `enqueue` throws for some other reason
      // entirely and the empty table below means nothing.
      "the rest of the work failed",
    );

    // A job for a row that was rolled back is a job that fails forever —
    // #79's lesson about bytes and rows, in a new costume.
    expect(await jobs()).toEqual([]);
  });
});

describe("running what is due", () => {
  it("does the work and marks it done", async () => {
    await emptyQueue();
    const sent = vi.spyOn(mailer, "sendVerificationEmail");
    await enqueue("verification-email", { email: "anna@example.com" });
    await due();

    expect(await drain(NOW)).toBe(1);

    expect(sent).toHaveBeenCalledTimes(1);
    expect(sent.mock.calls[0]?.[0]).toBe("anna@example.com");
    expect(await onlyJob()).toMatchObject({ doneAt: expect.any(Date) as Date });
  });

  it("makes the token itself, which is why the request did not", async () => {
    await emptyQueue();
    await enqueue("verification-email", { email: "anna@example.com" });
    await due();

    await drain(NOW);

    const tokens = await prisma.verificationToken.findMany({
      where: { type: "EMAIL_VERIFICATION" },
    });
    expect(tokens).toHaveLength(1);
  });

  it("never runs a job twice", async () => {
    await emptyQueue();
    const sent = vi.spyOn(mailer, "sendVerificationEmail");
    await enqueue("verification-email", { email: "anna@example.com" });
    await due();

    await drain(NOW);
    expect(await drain(NOW)).toBe(0);

    expect(sent).toHaveBeenCalledTimes(1);
  });

  it("leaves alone a job whose time has not come", async () => {
    await emptyQueue();
    await enqueue("verification-email", { email: "anna@example.com" });
    await prisma.job.updateMany({ data: { runAfter: later(60_000) } });

    expect(await drain(NOW)).toBe(0);
    expect((await onlyJob()).doneAt).toBeNull();
  });

  it("finds nothing to do for an address with no account", async () => {
    await emptyQueue();
    const sent = vi.spyOn(mailer, "sendVerificationEmail");
    await enqueue("password-reset-email", { email: "nobody@example.com" });
    await due();

    expect(await drain(NOW)).toBe(1);

    // Not an error. "There is nobody to email" is the answer, and the job is
    // done rather than failed — otherwise every stranger's typo becomes an
    // incident report.
    expect(sent).not.toHaveBeenCalled();
    expect(await onlyJob()).toMatchObject({
      doneAt: expect.any(Date) as Date,
      failedAt: null,
      lastError: null,
    });
  });
});

describe("when a job fails", () => {
  /** Breaks the one thing the verification handler needs. */
  function breakTheMailer(message = "the provider is on fire") {
    return vi
      .spyOn(mailer, "sendVerificationEmail")
      .mockRejectedValue(new Error(message));
  }

  it("is tried again later, and remembers why", async () => {
    await emptyQueue();
    breakTheMailer();
    await enqueue("verification-email", { email: "anna@example.com" });
    await due();

    await drain(NOW);

    const job = await onlyJob();
    expect(job).toMatchObject({ attempts: 1, doneAt: null, failedAt: null });
    expect(job.lastError).toContain("on fire");
    expect(job.runAfter.getTime()).toBeGreaterThan(NOW.getTime());
  });

  it("waits longer after each failure", async () => {
    await emptyQueue();
    breakTheMailer();
    await enqueue("verification-email", { email: "anna@example.com" });
    await due();

    await drain(NOW);
    const first = (await onlyJob()).runAfter.getTime() - NOW.getTime();

    const second = later(first + 1);
    await drain(second);
    const gap = (await onlyJob()).runAfter.getTime() - second.getTime();

    // The usual reason a job fails is that somebody else's service is having
    // a bad minute, and trying again at once is how a bad minute becomes a
    // bad hour.
    expect(first).toBeGreaterThanOrEqual(BACKOFF_BASE_MS);
    expect(gap).toBeGreaterThan(first);
  });

  it(`gives up after ${String(MAX_ATTEMPTS)} tries, visibly`, async () => {
    await emptyQueue();
    breakTheMailer();
    const reported = vi.spyOn(observability, "reportError");
    const failed = vi.spyOn(logger, "error");
    await enqueue("verification-email", { email: "anna@example.com" });
    await due();

    let at = NOW;
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      await drain(at);
      at = later((await onlyJob()).runAfter.getTime() - NOW.getTime() + 1);
    }

    const job = await onlyJob();
    expect(job).toMatchObject({
      attempts: MAX_ATTEMPTS,
      failedAt: expect.any(Date) as Date,
      doneAt: null,
    });
    // Nothing is silently swallowed (#29): somebody's email never arrived,
    // and the only evidence is this row and that report.
    expect(reported).toHaveBeenCalled();
    expect(failed).toHaveBeenCalled();
  });

  it("stops trying once it has given up", async () => {
    await emptyQueue();
    breakTheMailer();
    await enqueue("verification-email", { email: "anna@example.com" });
    await prisma.job.updateMany({
      data: { attempts: MAX_ATTEMPTS, failedAt: NOW, runAfter: NOW },
    });

    expect(await drain(later(BACKOFF_BASE_MS * 1000))).toBe(0);
  });

  it("keeps the row, so somebody can see what never arrived", async () => {
    await emptyQueue();
    breakTheMailer();
    await enqueue("verification-email", { email: "anna@example.com" });
    await prisma.job.updateMany({
      data: { attempts: MAX_ATTEMPTS - 1, runAfter: NOW },
    });

    await drain(NOW);

    // Not deleted, and — the half this test is named for — still carrying why.
    // A row that survives with an empty `lastError` answers "did it arrive?"
    // and not "what happened?", and the second is the question somebody asks.
    const kept = (await jobs()).at(0);
    expect(await jobs()).toHaveLength(1);
    expect(kept?.failedAt).not.toBeNull();
    expect(kept?.lastError).toContain("on fire");
  });
});

describe("two workers, one job", () => {
  it("steps over a job another worker is holding, rather than queueing behind it", async () => {
    await emptyQueue();
    await enqueue("verification-email", { email: "anna@example.com" });
    await due();
    const job = await onlyJob();

    // A second worker, mid-claim: its transaction holds the row.
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM "Job" WHERE id = ${job.id} FOR UPDATE`;

      // Without SKIP LOCKED this waits for the transaction above to finish,
      // which in a real pair of workers means one of them doing nothing for
      // as long as the other's job takes. With it, there is simply no work.
      const found = await Promise.race([
        runOne(NOW),
        new Promise<"blocked">((resolve) =>
          setTimeout(() => {
            resolve("blocked");
          }, 3000),
        ),
      ]);

      expect(found).toBe(false);
    });
  });

  /*
   * The next two are a PAIR, and neither holds the lease on its own.
   *
   * The first says what a claim leaves behind while the job is in flight; the
   * second says what happens to a row in that state when nobody finishes it.
   * The faked state in the second is only legitimate because the first proves
   * a real claim produces exactly it.
   *
   * This started as one test that wrote the "crashed" row by hand and drained
   * it, and a variant run walked straight through it: with the lease removed
   * from the claim entirely — `runAfter: now` — all 23 tests still passed. It
   * was a test about `drain` reading a timestamp, wearing the name of a rule
   * it never touched.
   */
  it("leases a job while it runs, so a second worker cannot send it too", async () => {
    await emptyQueue();
    await enqueue("verification-email", { email: "anna@example.com" });
    await due();

    const inFlight: Job[] = [];
    const alsoFound: boolean[] = [];

    // Inside the handler is the only moment a worker can die with a job in
    // its hands, so it is the moment to look at the row.
    vi.spyOn(mailer, "sendVerificationEmail").mockImplementation(async () => {
      inFlight.push(await onlyJob());
      alsoFound.push(await runOne(NOW));
    });

    expect(await runOne(NOW)).toBe(true);

    const claimed = inFlight.at(0);
    // Taken: the attempt is spent before the work, not after, so a job that
    // kills the process cannot be retried forever.
    expect(claimed?.attempts).toBe(1);
    // And not due again for the length of one backoff. This is the whole
    // mechanism: the row is not held by a lock that dies with the process,
    // it is simply not due yet.
    expect(Number(claimed?.runAfter)).toBe(NOW.getTime() + BACKOFF_BASE_MS);
    // Which is also what stops the obvious disaster: two workers, one email,
    // sent twice.
    expect(alsoFound).toEqual([false]);
  });

  it("picks up a job whose holder died without finishing it", async () => {
    await emptyQueue();
    const sent = vi.spyOn(mailer, "sendVerificationEmail");
    await enqueue("verification-email", { email: "anna@example.com" });

    // What the claim above leaves, written out: one attempt spent, not due
    // again until the lease is over, and nothing that says it finished.
    await prisma.job.updateMany({
      data: { attempts: 1, runAfter: later(BACKOFF_BASE_MS) },
    });

    // Nobody touches it while the lease has time left — the worker that is
    // holding it may still be alive.
    expect(await drain(NOW)).toBe(0);

    // And then it comes back by itself. Nothing is lost, only late.
    expect(await drain(later(BACKOFF_BASE_MS + 1))).toBe(1);
    expect(sent).toHaveBeenCalledTimes(1);
  });
});

describe("the timing gap this issue exists to close", () => {
  /** Everything the request touched, as the database saw it. */
  async function workDoneBy(email: string): Promise<string[]> {
    return statementsDuring(async () => {
      const response = await request(app)
        .post("/auth/forgot-password")
        .send({ email });
      expect(response.status).toBe(200);
    });
  }

  it("does the same work for a real account and an unknown one", async () => {
    const real = await workDoneBy("anna@example.com");
    const unknown = await workDoneBy("nobody@example.com");

    // The contract used to admit: "a real account costs one extra database
    // write, so it answers a few milliseconds slower than an unknown email".
    // Whatever the words say, the clock said the rest.
    expect(tablesRead(real)).toEqual(tablesRead(unknown));
    expect(real.filter((sql) => sql.includes("INSERT")).length).toBe(
      unknown.filter((sql) => sql.includes("INSERT")).length,
    );
  });

  it("sends nothing from the request itself", async () => {
    await emptyQueue();
    const sent = vi.spyOn(mailer, "sendPasswordResetEmail");

    await request(app)
      .post("/auth/forgot-password")
      .send({ email: "anna@example.com" });

    expect(sent).not.toHaveBeenCalled();
    expect(await onlyJob()).toMatchObject({ kind: "password-reset-email" });
  });

  it("and the worker sends it a moment later", async () => {
    await emptyQueue();
    const sent = vi.spyOn(mailer, "sendPasswordResetEmail");
    await request(app)
      .post("/auth/forgot-password")
      .send({ email: "anna@example.com" });

    // Asserted BEFORE the drain, or this passes just as well against a route
    // that sent the mail itself and a queue that does nothing.
    expect(sent).not.toHaveBeenCalled();

    await due();
    await drain(NOW);

    expect(sent).toHaveBeenCalledTimes(1);
    expect(sent.mock.calls[0]?.[0]).toBe("anna@example.com");
  });

  it("queues for an unknown address too, and the job finds nothing", async () => {
    await emptyQueue();
    const sent = vi.spyOn(mailer, "sendPasswordResetEmail");

    await request(app)
      .post("/auth/forgot-password")
      .send({ email: "nobody@example.com" });

    // A queue that only holds jobs for real accounts is the same oracle one
    // table along.
    expect(await onlyJob()).toMatchObject({ kind: "password-reset-email" });
    await due();
    expect(await drain(NOW)).toBe(1);
    expect(sent).not.toHaveBeenCalled();
  });

  it("does the same for asking again to be verified", async () => {
    await emptyQueue();

    await request(app)
      .post("/auth/resend-verification")
      .send({ email: "nobody@example.com" });

    expect(await onlyJob()).toMatchObject({ kind: "verification-email" });
  });

  it("and registering enqueues rather than sending", async () => {
    await emptyQueue();
    const sent = vi.spyOn(mailer, "sendVerificationEmail");

    const response = await request(app).post("/auth/register").send({
      email: "new@example.com",
      password: "a long enough password",
      displayName: "Nell",
      countryCode: "EE",
    });

    expect(response.status).toBe(201);
    expect(sent).not.toHaveBeenCalled();
    expect(await onlyJob()).toMatchObject({
      kind: "verification-email",
      payload: { email: "new@example.com" },
    });
  });
});

describe("who is eligible is the worker's question", () => {
  it("a banned account gets no reset email", async () => {
    await emptyQueue();
    await prisma.user.updateMany({
      where: { email: "anna@example.com" },
      data: { status: "BANNED" },
    });
    const sent = vi.spyOn(mailer, "sendPasswordResetEmail");
    await enqueue("password-reset-email", { email: "anna@example.com" });
    await due();

    expect(await drain(NOW)).toBe(1);

    expect(sent).not.toHaveBeenCalled();
    expect((await onlyJob()).doneAt).not.toBeNull();
  });

  it("an already verified account gets no verification email", async () => {
    await emptyQueue();
    await prisma.user.updateMany({
      where: { email: "anna@example.com" },
      data: { emailVerifiedAt: NOW },
    });
    const sent = vi.spyOn(mailer, "sendVerificationEmail");
    await enqueue("verification-email", { email: "anna@example.com" });
    await due();

    // The job RAN — `toBe(1)` — and decided there was nothing to send. Without
    // that number this test also passes when the drain found nothing at all,
    // which is how it survived the clock bug above.
    expect(await drain(NOW)).toBe(1);

    expect(sent).not.toHaveBeenCalled();
    expect((await onlyJob()).doneAt).not.toBeNull();
  });
});
