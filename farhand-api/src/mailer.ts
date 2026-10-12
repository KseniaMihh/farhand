import { env } from "./env.js";
import { logger } from "./logger.js";
import { reportError } from "./observability.js";
import { EMAIL_VERIFICATION_TTL_MS, PASSWORD_RESET_TTL_MS } from "./tokens.js";

/**
 * Outgoing email.
 *
 * ONE FILE KNOWS ABOUT THE MAIL PROVIDER, the same seam as src/storage.ts for
 * S3 and src/observability.ts for Sentry. Nothing that calls `mailer` knows
 * who delivers the message, and #86's notification emails will not need to
 * either.
 *
 * It is Brevo, over its HTTP API, because Render's free plan blocks the SMTP
 * ports and because its free tier needs no card — the two constraints that
 * chose it (docs/10-decisions/0014-brevo-for-email.md). The key and the
 * sender are settings, not constants: the day Farhand has a domain of its
 * own, the change is in Render.
 *
 * Why an object with methods rather than exported functions: tests replace a
 * method with `vi.spyOn(mailer, "sendVerificationEmail")` to capture the token
 * that would have been emailed. ES module exports are read-only bindings and
 * cannot be spied on; properties of an exported object can. `transport` below
 * exists for the same reason, one layer down.
 */

/**
 * Brevo's HTTP endpoint for one transactional email.
 *
 * The path says `smtp` and this is not SMTP: it is an HTTPS POST, which is
 * what makes it usable at all. Render's free plan blocks ports 25, 465 and
 * 587 (docs/14-deployment.md).
 */
const BREVO_ENDPOINT = "https://api.brevo.com/v3/smtp/email";

/** How long we wait for the provider before giving up on one message. */
export const SEND_TIMEOUT_MS = 5000;

/** What an inbox shows when MAIL_FROM_NAME is not set. */
const DEFAULT_FROM_NAME = "Farhand";

/** One message, in the only shape this project needs: a person, and words. */
export interface OutgoingMail {
  to: string;
  subject: string;
  /** Plain text. No HTML: a confirmation code does not need a layout. */
  text: string;
}

/** A token's life in whole hours, for a sentence a person has to act on. */
function hours(ms: number): string {
  return String(ms / 3_600_000);
}

/**
 * The one thing that talks to Brevo.
 *
 * Separate from `mailer` so that tests can watch what WOULD be sent without a
 * network — `vi.spyOn(transport, "send")` is the fake provider — while one
 * test of its own pins the request this builds, with `fetch` stubbed. The
 * same division as `storage.put` and the services above it.
 *
 * Throws on anything but success. Deciding what to do about a failure is the
 * caller's job, and `deliver` below is the caller.
 */
export const transport = {
  async send(mail: OutgoingMail): Promise<void> {
    const key = env.MAIL_API_KEY;
    const from = env.MAIL_FROM;

    if (!key || !from) {
      // Unreachable through `deliver`, which checks first. Kept for the reason
      // storage.ts keeps the same guard: a second caller one day must not
      // discover the requirement by sending nothing.
      throw new Error("Mail is not configured (MAIL_* variables)");
    }

    // Our own clock, not `AbortSignal.timeout`: a plain timer is one a test
    // can advance, and a five-second wait in a test run is five seconds
    // nobody gets back. Cleared in `finally`, or it keeps the process alive
    // after the request is long gone.
    const controller = new AbortController();
    const giveUp = setTimeout(() => {
      controller.abort();
    }, SEND_TIMEOUT_MS);

    try {
      const response = await fetch(BREVO_ENDPOINT, {
        method: "POST",
        headers: { "api-key": key, "content-type": "application/json" },
        body: JSON.stringify({
          sender: {
            email: from,
            name: env.MAIL_FROM_NAME ?? DEFAULT_FROM_NAME,
          },
          to: [{ email: mail.to }],
          subject: mail.subject,
          textContent: mail.text,
          // Only when there is one. An absent field is not the same as an
          // empty one, and the default is absent on purpose (see env.ts).
          ...(env.MAIL_REPLY_TO
            ? { replyTo: { email: env.MAIL_REPLY_TO } }
            : {}),
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        // The STATUS and nothing else. Brevo quotes the request back when it
        // complains, and the request is the email, and the email is the token.
        throw new Error(
          `The mail provider answered ${String(response.status)}`,
        );
      }
    } finally {
      clearTimeout(giveUp);
    }
  },
};

/**
 * Sends one message, or explains to us why it could not.
 *
 * The three states, in order:
 *
 *   configured            really send, through `transport`
 *   not configured, dev   log the token, so a developer can copy it
 *   not configured, prod  log that nothing was sent, WITHOUT the token
 *
 * Keyed on whether mail is configured rather than on `isProduction`, which is
 * what it used to be. That lets the real settings be tried from a laptop
 * before they are trusted in Render, and the test suite — which configures
 * nothing — keeps exactly the behaviour it had.
 *
 * NEVER THROWS. A provider that is down, slow or rate-limiting must not turn
 * somebody's registration into a 500: `POST /auth/register` awaits this inside
 * a try that forgives only a duplicate address, so anything thrown here would
 * reach the caller. The account exists either way, and the way back is
 * `POST /auth/resend-verification` (#41).
 */
async function deliver(mail: OutgoingMail, token: string): Promise<void> {
  if (!env.MAIL_API_KEY || !env.MAIL_FROM) {
    if (env.NODE_ENV === "production") {
      // Loudly, so nobody mistakes this for working — and without the token,
      // which in a production log is a working credential in a place far more
      // people can read than can read the database.
      logger.warn(
        { to: mail.to, subject: mail.subject },
        "No mail provider configured: email not sent",
      );
      return;
    }

    logger.info(
      { to: mail.to, token },
      `Email (development only — not actually sent): ${mail.subject}`,
    );
    return;
  }

  try {
    await transport.send(mail);
    logger.info({ to: mail.to }, "Email sent");
  } catch (error) {
    const because = redact(error, token);

    logger.error({ to: mail.to, because }, "Could not send email");
    // Visible rather than swallowed (#29). A new Error rather than the
    // original: what Sentry stores is its message, and `redact` is the only
    // thing standing between that store and a token.
    reportError(new Error(`Could not send email: ${because}`), {});
  }
}

/**
 * What went wrong, with the token taken out of it.
 *
 * Nothing this file writes contains the token, so this is defence in depth
 * against the one thing we do not write: a provider, or a library, that
 * quotes the request back inside its error.
 */
function redact(error: unknown, token: string): string {
  const text =
    error instanceof Error
      ? `${error.name}: ${error.message}`
      : "unknown error";

  return text.replaceAll(token, "[token]");
}

export const mailer = {
  /**
   * Sends the code that proves the user owns their address.
   *
   * `token` is the RAW token — the only moment the plaintext exists outside
   * the user's inbox. The database holds a hash of it.
   *
   * WHAT THE EMAIL CARRIES IS A CODE, NOT A LINK, and that is not laziness: a
   * link has to land on a page, `APP_ORIGIN` is still the API's own address
   * because there is no frontend (#93), and an inbox cannot follow a link to
   * `POST /auth/verify-email`. A `GET` that verified would be spent by the
   * first link prefetcher that saw it. #93 is where this becomes a link.
   */
  sendVerificationEmail(to: string, token: string): Promise<void> {
    return deliver(
      {
        to,
        subject: "Confirm your email address",
        text: [
          "Welcome to Farhand.",
          "",
          "Your confirmation code is:",
          "",
          token,
          "",
          `The code is good for ${hours(EMAIL_VERIFICATION_TTL_MS)} hours. Farhand will ask for it to finish setting up your account.`,
          "",
          "If you did not sign up, you can ignore this message — the address will not be used.",
        ].join("\n"),
      },
      token,
    );
  },

  /**
   * Sends the code that lets someone choose a new password.
   *
   * A reset token is more powerful than a verification token — whoever holds
   * it can take over the account — which is why it lasts an hour rather than
   * a day, and why the same rule about logs matters more.
   */
  sendPasswordResetEmail(to: string, token: string): Promise<void> {
    return deliver(
      {
        to,
        subject: "Reset your Farhand password",
        text: [
          "Somebody asked to reset the password for this address.",
          "",
          "Your reset code is:",
          "",
          token,
          "",
          `The code is good for ${hours(PASSWORD_RESET_TTL_MS)} hour, and using it signs out every device.`,
          "",
          "If this was not you, nothing has changed and you can ignore this message.",
        ].join("\n"),
      },
      token,
    );
  },
};
