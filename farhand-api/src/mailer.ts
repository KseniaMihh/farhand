import { isProduction } from "./env.js";
import { logger } from "./logger.js";

/**
 * Outgoing email.
 *
 * There is no mail provider yet — that arrives with the background job queue
 * in v2 (docs/08-scope.md). Until then, "sending" a verification email means
 * writing the token to the log in development, so you can copy it from the
 * terminal and call POST /auth/verify-email with it.
 *
 * Why an object with methods rather than exported functions: tests replace a
 * method with `vi.spyOn(mailer, "sendVerificationEmail")` to capture the token
 * that would have been emailed. ES module exports are read-only bindings and
 * cannot be spied on; properties of an exported object can.
 *
 * When a real provider arrives, only the bodies here change. Nothing that
 * calls `mailer` needs to know.
 */
export const mailer = {
  /**
   * Sends the link that proves the user owns their address.
   *
   * `token` is the RAW token — the only moment the plaintext exists outside
   * the user's inbox. The database holds a hash of it.
   */
  sendVerificationEmail(to: string, token: string): Promise<void> {
    if (isProduction) {
      // A token in a production log is a working verification credential in
      // a system many more people can read than can read the database. So in
      // production, with no provider configured, it is simply not delivered —
      // loudly, so nobody mistakes this for working.
      logger.warn(
        { to },
        "No mail provider configured: verification email not sent",
      );
      return Promise.resolve();
    }

    logger.info(
      { to, token },
      "Verification email (development only — not actually sent). " +
        'Confirm with: POST /auth/verify-email { "token": "<token>" }',
    );
    return Promise.resolve();
  },
};
