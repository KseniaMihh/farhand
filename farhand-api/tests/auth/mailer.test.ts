import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/app.js";
import { prisma } from "../../src/db.js";
import { env } from "../../src/env.js";
import { logger } from "../../src/logger.js";
import { mailer, SEND_TIMEOUT_MS, transport } from "../../src/mailer.js";
import * as observability from "../../src/observability.js";
import { runQueuedJobs } from "../helpers/jobs.js";
import {
  EMAIL_VERIFICATION_TTL_MS,
  PASSWORD_RESET_TTL_MS,
} from "../../src/tokens.js";

/**
 * Sending email for real (#119).
 *
 * Until now `mailer.ts` delivered nothing anywhere and the suite was happy:
 * every auth test either spies on `mailer` — intercepting before the body runs
 * — or sets `emailVerifiedAt` directly. 118 tests pass against a mailer that
 * does nothing at all, which is precisely why these exist.
 *
 * Nothing here sends anything. There are two seams, one per question:
 *
 *   transport.send   spied on, to ask "what message was composed?"
 *   global fetch     stubbed, to ask "what request would Brevo receive?"
 *
 * The second is the fake provider. It is not a test of an SDK, because there
 * is no SDK: the provider is one `fetch` to one URL, which is the whole reason
 * it can be checked this way.
 *
 * SINCE #85, three of these say the opposite of what they said when they were
 * written, and the describe blocks below explain why one at a time: #119's
 * mailer swallowed a failure because a route was waiting on it, and the queue
 * that waits on it now has to be told. What did not reverse is the redaction —
 * a token belongs in an inbox and nowhere else, and there is one more place it
 * must not reach than there used to be.
 */

const app = createApp();

/** Unusual on purpose, so a match in a log or an error is never a coincidence. */
const TOKEN = "raw-token-7f3c-nobody-should-log-this";
const TO = "nell@example.com";

/** The settings a configured mailer has. */
const KEY = "brevo-key-xyz";
const FROM = "farhand.app@example.com";

let saved: Record<string, unknown>;

beforeEach(() => {
  saved = {
    MAIL_API_KEY: env.MAIL_API_KEY,
    MAIL_FROM: env.MAIL_FROM,
    MAIL_FROM_NAME: env.MAIL_FROM_NAME,
    MAIL_REPLY_TO: env.MAIL_REPLY_TO,
    NODE_ENV: env.NODE_ENV,
  };
});

afterEach(() => {
  Object.assign(env, saved);
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** Mail configured, as Render has it. */
function configured(extra: Record<string, string> = {}) {
  env.MAIL_API_KEY = KEY;
  env.MAIL_FROM = FROM;
  env.MAIL_FROM_NAME = undefined;
  env.MAIL_REPLY_TO = undefined;
  Object.assign(env, extra);
}

/** Mail not configured — the state of every other test file, and of CI. */
function notConfigured() {
  env.MAIL_API_KEY = undefined;
  env.MAIL_FROM = undefined;
  env.MAIL_FROM_NAME = undefined;
  env.MAIL_REPLY_TO = undefined;
}

interface SeenRequest {
  url: string;
  method: string | undefined;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

/**
 * Stands in for Brevo. Records what it was asked, answers how it is told to.
 */
function stubProvider(answer: { status?: number; body?: string } = {}) {
  const seen: SeenRequest[] = [];

  const fetchStub = vi.fn((url: string | URL, init?: RequestInit) => {
    seen.push({
      url: String(url),
      method: init?.method,
      headers: (init?.headers ?? {}) as Record<string, string>,
      // A string, or the assertions below see `{}` and fail — which is the
      // right outcome: the body has to be JSON we built, not an object handed
      // to `fetch` to stringify however it likes.
      body: JSON.parse(
        typeof init?.body === "string" ? init.body : "{}",
      ) as Record<string, unknown>,
    });

    return Promise.resolve(
      new Response(answer.body ?? '{"messageId":"<1@brevo>"}', {
        status: answer.status ?? 201,
      }),
    );
  });

  vi.stubGlobal("fetch", fetchStub);
  return { seen, fetchStub };
}

/** One message, as `transport.send` takes it. */
const message = {
  to: TO,
  subject: "Confirm your email address",
  text: `Your code is ${TOKEN}`,
};

/** Everything a spy recorded, flattened, so a token cannot hide in an object. */
function everythingLogged(
  ...spies: { mock: { calls: unknown[][] } }[]
): string {
  // Errors are unwrapped by hand, and that is the point of this helper:
  // `JSON.stringify(new Error("secret"))` is `{}`, so the first version of it
  // reported "no token anywhere" about a log line that carried the provider's
  // error verbatim. A check that cannot see what it forbids is worse than none.
  return spies
    .map((spy) =>
      JSON.stringify(spy.mock.calls, (_key, value: unknown) =>
        value instanceof Error
          ? `${value.name}: ${value.message} ${value.stack ?? ""}`
          : value,
      ),
    )
    .join(" ");
}

describe("the request Brevo receives", () => {
  it("is an HTTPS POST to the email API, with the key in a header", async () => {
    configured();
    const { seen } = stubProvider();

    await transport.send(message);

    expect(seen).toHaveLength(1);
    const sent = seen[0];
    if (!sent) throw new Error("expected one request");

    expect(sent.url).toBe("https://api.brevo.com/v3/smtp/email");
    expect(sent.method).toBe("POST");
    expect(sent.headers["api-key"]).toBe(KEY);
    expect(sent.headers["content-type"]).toBe("application/json");

    // The path says `smtp` and the protocol is HTTPS, which is the point:
    // Render's free plan blocks ports 25, 465 and 587, so the real SMTP is
    // not available to us at all (docs/14-deployment.md).
    expect(new URL(sent.url).protocol).toBe("https:");
  });

  it("names the sender from the settings, with a default display name", async () => {
    configured();
    const { seen } = stubProvider();

    await transport.send(message);

    expect(seen[0]?.body.sender).toEqual({ email: FROM, name: "Farhand" });
  });

  it("uses the configured display name when there is one", async () => {
    configured({ MAIL_FROM_NAME: "Farhand (test)" });
    const { seen } = stubProvider();

    await transport.send(message);

    expect(seen[0]?.body.sender).toEqual({
      email: FROM,
      name: "Farhand (test)",
    });
  });

  it("leaves replyTo out entirely when none is configured", async () => {
    configured();
    const { seen } = stubProvider();

    await transport.send(message);

    // Absent, not null and not empty. A verification email does not need
    // replies, and the alternative — a person's own address — would be shown
    // to every stranger who registers (#119).
    expect(seen[0]?.body).not.toHaveProperty("replyTo");
  });

  it("carries replyTo when an address is configured", async () => {
    configured({ MAIL_REPLY_TO: "hello@farhand.example" });
    const { seen } = stubProvider();

    await transport.send(message);

    expect(seen[0]?.body.replyTo).toEqual({ email: "hello@farhand.example" });
  });

  it("sends the recipient, the subject and plain text — no HTML", async () => {
    configured();
    const { seen } = stubProvider();

    await transport.send(message);

    expect(seen[0]?.body).toMatchObject({
      to: [{ email: TO }],
      subject: message.subject,
      textContent: message.text,
    });
    expect(seen[0]?.body).not.toHaveProperty("htmlContent");
  });

  it("throws when the provider refuses, saying the status and nothing else", async () => {
    configured();
    // Brevo echoes what it was given when it complains, so its answer can
    // hold the whole email — and the email holds the token.
    stubProvider({
      status: 401,
      body: JSON.stringify({ code: "unauthorized", payload: message.text }),
    });

    await expect(transport.send(message)).rejects.toThrow(/401/);
    await expect(transport.send(message)).rejects.not.toThrow(
      new RegExp(TOKEN),
    );
  });

  it(`gives up after ${String(SEND_TIMEOUT_MS)}ms rather than holding the request`, async () => {
    configured();
    vi.useFakeTimers();

    // A provider that accepts the connection and then says nothing. The only
    // way out is our own clock, so the implementation has to carry one — and
    // it has to be a plain `setTimeout`, because `AbortSignal.timeout` runs on
    // a timer Vitest cannot advance, which would make this test a five-second
    // wait in every run.
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              reject(new Error("aborted"));
            });
          }),
      ),
    );

    const sending = transport.send(message);
    const settled = vi.fn();
    void sending.catch(settled);

    await vi.advanceTimersByTimeAsync(SEND_TIMEOUT_MS - 1);
    expect(settled).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2);
    await expect(sending).rejects.toThrow();
  });

  it("leaves no timer behind when the send succeeds", async () => {
    configured();
    vi.useFakeTimers();
    stubProvider();

    await transport.send(message);

    // A timer nobody cleared keeps the process alive after everything else is
    // done, which on a server is a handle that never closes.
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("what the messages say", () => {
  it("gives the verification code, and names the hours it lasts", async () => {
    configured();
    const send = vi.spyOn(transport, "send").mockResolvedValue();

    await mailer.sendVerificationEmail(TO, TOKEN);

    expect(send).toHaveBeenCalledTimes(1);
    const sent = send.mock.calls[0]?.[0];
    expect(sent?.to).toBe(TO);
    expect(sent?.subject).toMatch(/confirm/i);
    expect(sent?.text).toContain(TOKEN);
    // Read from the constant, so the words cannot drift from the database:
    // 24 hours is what `EMAIL_VERIFICATION_TTL_MS` grants.
    expect(sent?.text).toContain(String(EMAIL_VERIFICATION_TTL_MS / 3_600_000));
  });

  it("is a code rather than a link, because there is no page to land on", async () => {
    configured();
    const send = vi.spyOn(transport, "send").mockResolvedValue();

    await mailer.sendVerificationEmail(TO, TOKEN);

    // `APP_ORIGIN` is still the API's own address — there is no frontend yet
    // (#93) — and an inbox cannot follow a link to `POST /auth/verify-email`.
    // A link would either 404 or need a GET that verifies, which a link
    // prefetcher would spend on the user's behalf. #93 is where this changes.
    expect(send.mock.calls[0]?.[0].text).not.toMatch(/https?:\/\//);
  });

  it("says a reset code is good for one hour", async () => {
    configured();
    const send = vi.spyOn(transport, "send").mockResolvedValue();

    await mailer.sendPasswordResetEmail(TO, TOKEN);

    const sent = send.mock.calls[0]?.[0];
    expect(sent?.subject).toMatch(/password/i);
    expect(sent?.text).toContain(TOKEN);
    expect(sent?.text).toContain(String(PASSWORD_RESET_TTL_MS / 3_600_000));
    expect(sent?.text).toMatch(/hour/i);
  });
});

describe("when mail is not configured", () => {
  it("logs the token in development, so a developer can copy it", async () => {
    notConfigured();
    env.NODE_ENV = "development";
    const written = vi.spyOn(logger, "info");
    const { fetchStub } = stubProvider();

    await mailer.sendVerificationEmail(TO, TOKEN);

    expect(everythingLogged(written)).toContain(TOKEN);
    // And nothing was asked of anybody: there is nobody configured to ask.
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("refuses to pretend in production, and still never logs the token", async () => {
    notConfigured();
    env.NODE_ENV = "production";
    const warned = vi.spyOn(logger, "warn");
    const written = vi.spyOn(logger, "info");
    const failed = vi.spyOn(logger, "error");

    // THROWS, where #119 returned quietly. The caller used to be a route and
    // is now the queue (#85), where a quiet return would mark the job `doneAt`
    // and lose the email for good. This is also the state the GitHub Actions
    // backstop runs in — MAIL_API_KEY lives in Render, not in Actions secrets
    // — so "not configured" has to mean "I cannot do this job", leaving the
    // row for a process that can.
    await expect(mailer.sendVerificationEmail(TO, TOKEN)).rejects.toThrow(
      /no mail provider/i,
    );
    await expect(mailer.sendPasswordResetEmail(TO, TOKEN)).rejects.toThrow(
      /no mail provider/i,
    );

    // Loudly as well as unsuccessfully: somebody has to be able to see it.
    expect(warned).toHaveBeenCalledTimes(2);
    expect(everythingLogged(warned)).toContain(TO);
    // The rule this file inherited and must not lose: a token in a production
    // log is a working credential, in a place far more people can read than
    // can read the database.
    expect(everythingLogged(warned, written, failed)).not.toContain(TOKEN);
  });
});

describe("when the provider is unwell", () => {
  it("hands the failure back, for the queue to do something about", async () => {
    configured();
    vi.spyOn(transport, "send").mockRejectedValue(new Error("502 from Brevo"));

    // The REVERSE of what #119 asserted here, and the caller is the reason.
    // Then a route awaited this, and a provider having a bad minute must not
    // turn somebody's registration into a 500, so the failure was swallowed.
    // Now the only caller is the queue, and swallowing would tell it the email
    // went out: the job marked done, the message gone, and every retry in
    // services/jobs.ts left as code that can never run.
    await expect(mailer.sendVerificationEmail(TO, TOKEN)).rejects.toThrow(
      /could not send email/i,
    );
  });

  it("puts no token in what it throws, or in what it logs", async () => {
    configured();
    vi.spyOn(transport, "send").mockRejectedValue(
      new Error(`502 while sending ${TOKEN}`),
    );
    const failed = vi.spyOn(logger, "error");

    const because = await mailer
      .sendVerificationEmail(TO, TOKEN)
      .then(() => "it did not throw")
      .catch((error: unknown) =>
        error instanceof Error ? error.message : String(error),
      );

    // Even when the provider's own error quotes the message back at us, what
    // we log must not — and nor must what we throw, because since #85 that
    // string is what lands in `Job.lastError` and goes on to #29's reporting.
    // `redact` is the whole distance between a database column and a working
    // credential.
    expect(because).not.toContain(TOKEN);
    expect(because).toContain("[token]");
    expect(failed).toHaveBeenCalledTimes(1);
    expect(everythingLogged(failed)).not.toContain(TOKEN);
  });

  it("owes the email rather than losing it, and reports nothing yet", async () => {
    configured();
    // Rejecting with the MESSAGE ITSELF, not with the TOKEN constant the
    // tests above use: the token in play here is the one the handler just
    // generated for this account, and nothing in the test knows it. An error
    // quoting the request back is exactly what Brevo does when it complains,
    // and it is the only way a token could reach `Job.lastError`.
    let composed = "";
    vi.spyOn(transport, "send").mockImplementation((mail) => {
      composed = mail.text;
      return Promise.reject(new Error(`502 while sending ${mail.text}`));
    });
    const reported = vi.spyOn(observability, "reportError");

    const response = await request(app).post("/auth/register").send({
      email: "sam@example.com",
      password: "a long enough password",
      displayName: "Sam",
      countryCode: "EE",
    });

    // Still a 201, and now for a sturdier reason than #119's: the route sends
    // nothing, so there is nothing for a provider to spoil. The account is
    // really there either way — a third party being unwell must not undo work
    // that was already committed.
    expect(response.status).toBe(201);
    expect(
      await prisma.user.findUnique({ where: { email: "sam@example.com" } }),
    ).not.toBeNull();

    await runQueuedJobs();

    // One attempt spent, four to go, the row still waiting: the email is owed,
    // not lost. #119 reported at once and moved on; reporting now happens once
    // in `recordFailure`, when the attempts run out, so a provider blip does
    // not become five Sentry issues.
    const job = await prisma.job.findFirstOrThrow();
    expect(job).toMatchObject({ attempts: 1, doneAt: null, failedAt: null });
    expect(reported).not.toHaveBeenCalled();

    // And the column that now holds the provider's words holds no token. The
    // real one, read back out of the email it was put in: 43 characters of
    // base64url on a line of their own (src/tokens.ts).
    const raw = composed
      .split("\n")
      .find((line) => /^[\w-]{43}$/.test(line.trim()));
    expect(raw).toBeDefined();
    expect(job.lastError).not.toContain(raw);
    expect(job.lastError).toContain("[token]");
  });
});

describe("the whole way through", () => {
  it("reaches the provider exactly once when somebody registers", async () => {
    configured();
    const { seen } = stubProvider();

    const response = await request(app).post("/auth/register").send({
      email: "kadri@example.com",
      password: "a long enough password",
      displayName: "Kadri",
      countryCode: "EE",
    });

    expect(response.status).toBe(201);
    // The request queues; the worker reaches Brevo (#85).
    await runQueuedJobs();
    expect(seen).toHaveLength(1);
    expect(seen[0]?.body.to).toEqual([{ email: "kadri@example.com" }]);
    // Nothing in this chain was mocked except Brevo itself: route, service,
    // token, mailer, transport, HTTP body. Nothing covered that before.
  });

  it("sends nothing when the address is already taken", async () => {
    configured();
    const body = {
      email: "twice@example.com",
      password: "a long enough password",
      displayName: "Twice",
      countryCode: "EE",
    };

    // Stubbed BEFORE the first registration, not between the two. A variant
    // run caught this: the first one used to go out to the real api.brevo.com
    // with a nonsense key, and only passed because the mailer swallows what
    // the provider says. A test that quietly needs the internet is a test
    // that fails on a train.
    const { seen } = stubProvider();
    expect((await request(app).post("/auth/register").send(body)).status).toBe(
      201,
    );
    await runQueuedJobs();
    expect(seen).toHaveLength(1);
    seen.length = 0;

    expect((await request(app).post("/auth/register").send(body)).status).toBe(
      201,
    );
    await runQueuedJobs();

    // The identical answer is the anti-enumeration rule from #9; the silence
    // is the other half of it. An email saying "somebody tried to register
    // your address" is a notification nobody asked for, and the real owner
    // already has a token.
    expect(seen).toHaveLength(0);
  });
});
