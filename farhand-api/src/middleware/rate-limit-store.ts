import type { ClientRateLimitInfo, Options, Store } from "express-rate-limit";
import { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { logger } from "../logger.js";

/**
 * The counters, in the database every instance shares (#91).
 *
 * Why this exists: the limits were counted in one process's memory, so two
 * instances meant two tallies and every documented number doubled — 20 login
 * attempts per address became 40, and somebody refused by one machine could
 * simply try again and be served by the other. That, rather than the hosting
 * plan, was the thing in the code standing between this project and a second
 * machine (docs/14-deployment.md).
 *
 * A table rather than Redis, for decision 0019's argument about the job
 * queue, repeated: a second piece of infrastructure is a second thing to run,
 * pay for and watch, and the database is already shared by every instance.
 * The whole argument is in
 * docs/10-decisions/0027-counters-that-survive-a-second-machine.md.
 *
 * THE WHOLE STORE IS ONE STATEMENT. A limiter is a read-modify-write, and two
 * requests arriving together must not both read 19 and both write 20.
 * `INSERT … ON CONFLICT DO UPDATE … RETURNING` reads, decides and writes
 * inside one statement, so PostgreSQL's row lock settles the race instead of
 * a transaction of ours — and the answer comes back from the row that was
 * actually written.
 *
 * The same statement also has to restart a window that has run out, and the
 * only clock allowed to decide that is the database's own `now()`. Several
 * instances means several clocks, and a deadline two machines disagree about
 * is a counter that resets whenever the request lands on the fast one (#85
 * learned the same thing about job rows).
 */
export class PostgresRateLimitStore implements Store {
  /**
   * Tells the library these counters are not per-process, which turns off its
   * "you have used one store for two limiters" warning — and says the thing
   * this issue is about in one word.
   */
  localKeys = false;

  /**
   * One table holds every limiter's counters, so the limiter's name is part
   * of the key: `login-ip:1.2.3.4`. Two limiters counting the same address
   * must not share a budget.
   */
  prefix: string;

  /** Set by `init`, which the library calls with the limiter's options. */
  private windowMs = 60_000;

  constructor(name: string) {
    this.prefix = `${name}:`;
  }

  /**
   * The row this key belongs in.
   *
   * `prefix` is declared for the library's double-counting check, which reads
   * it — it does NOT prepend it. The store has to, and until it did, every
   * limiter counting by address wrote into one row: spending the login budget
   * spent the registration one too. Two tests in tests/auth/rate-limit.test.ts
   * caught it, which is what they were written for in #14.
   */
  private rowKey(key: string): string {
    return `${this.prefix}${key}`;
  }

  init(options: Options): void {
    this.windowMs = options.windowMs;
  }

  async increment(key: string): Promise<ClientRateLimitInfo> {
    const windowSeconds = this.windowMs / 1000;

    try {
      // `now()` and the interval are the DATABASE's, start to finish. The
      // CASE is the window rolling over: a row whose deadline has passed is
      // not incremented, it is started again at one.
      const [row] = await prisma.$queryRaw<
        { count: number; expiresAt: Date }[]
      >(Prisma.sql`
        INSERT INTO "RateLimit" ("key", "count", "expiresAt")
        VALUES (${this.rowKey(key)}, 1, now() + make_interval(secs => ${windowSeconds}))
        ON CONFLICT ("key") DO UPDATE SET
          "count" = CASE
            WHEN "RateLimit"."expiresAt" <= now() THEN 1
            ELSE "RateLimit"."count" + 1
          END,
          "expiresAt" = CASE
            WHEN "RateLimit"."expiresAt" <= now()
            THEN now() + make_interval(secs => ${windowSeconds})
            ELSE "RateLimit"."expiresAt"
          END
        RETURNING "count", "expiresAt"
      `);

      if (!row) throw new Error("the counter wrote no row");

      return { totalHits: row.count, resetTime: row.expiresAt };
    } catch (error) {
      return this.failOpen(error);
    }
  }

  /**
   * One off the count, for a request the limiter decided not to charge for.
   *
   * Nothing in this project uses `skipSuccessfulRequests`, so this is only
   * ever called if somebody turns one on. It still has to be right, and it
   * still must not go below zero or resurrect an expired window.
   */
  async decrement(key: string): Promise<void> {
    try {
      await prisma.rateLimit.updateMany({
        where: { key: this.rowKey(key), expiresAt: { gt: new Date() } },
        data: { count: { decrement: 1 } },
      });
    } catch (error) {
      this.failOpen(error);
    }
  }

  async resetKey(key: string): Promise<void> {
    try {
      await prisma.rateLimit.deleteMany({ where: { key: this.rowKey(key) } });
    } catch (error) {
      this.failOpen(error);
    }
  }

  async get(key: string): Promise<ClientRateLimitInfo | undefined> {
    try {
      const row = await prisma.rateLimit.findUnique({
        where: { key: this.rowKey(key) },
      });

      // An expired row is not a count any more: the next increment will
      // start it again, and saying so here keeps the two answers the same.
      if (!row || row.expiresAt <= new Date()) return undefined;

      return { totalHits: row.count, resetTime: row.expiresAt };
    } catch (error) {
      this.failOpen(error);
      return undefined;
    }
  }

  /**
   * The failure rule, and the decision this issue had to make (0027).
   *
   * **Open, and loudly.** The store is the application's own database, so a
   * counter that cannot be read means every endpoint behind it is already
   * answering 500 — refusing as well turns a database blip into a certain
   * outage rather than a likely one. What makes that defensible rather than
   * careless is the line: a limiter that has quietly stopped limiting is the
   * worst of both, so this is `logger.error`, not a debug line nobody reads.
   *
   * It reports one hit rather than zero: the request passes, and anything
   * reading `RateLimit` headers sees a budget that is being spent rather than
   * one that has reset.
   */
  private failOpen(error: unknown): ClientRateLimitInfo {
    logger.error(
      { err: error },
      "rate limit counter unreachable, allowing the request",
    );

    return { totalHits: 1, resetTime: new Date(Date.now() + this.windowMs) };
  }
}
