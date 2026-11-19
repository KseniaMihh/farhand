import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

/**
 * Settings that only mean anything complete (#119, and #79 before it).
 *
 * `src/env.ts` refuses to load a half-configured file store or a half-
 * configured mail provider, and refusing means `process.exit(1)` — which a
 * test cannot do in-process without taking the runner with it. So each case
 * loads `src/env.ts` in a CHILD process with an environment of its own and
 * reads what it said on the way out.
 *
 * Node runs the TypeScript file directly, so there is nothing to build first.
 *
 * The storage half of this has been true since #79 and untested since #79.
 * #119 added the second group and, with it, the reason to write the test that
 * holds both.
 */

const run = promisify(execFile);

/** Every variable in a group, so a stray one from .env.test cannot leak in. */
const GROUPED = [
  "STORAGE_ENDPOINT",
  "STORAGE_REGION",
  "STORAGE_BUCKET",
  "STORAGE_ACCESS_KEY_ID",
  "STORAGE_SECRET_ACCESS_KEY",
  "MAIL_API_KEY",
  "MAIL_FROM",
  "MAIL_FROM_NAME",
  "MAIL_REPLY_TO",
];

/** The least that has to be set for anything to load at all. */
const REQUIRED = {
  DATABASE_URL: "postgresql://farhand:farhand@localhost:5432/farhand_test",
  SESSION_SECRET: "s".repeat(40),
  APP_ORIGIN: "http://localhost:3000",
  NODE_ENV: "development",
};

interface Loaded {
  ok: boolean;
  complaint: string;
}

// `string | undefined` so a case can say "and this one is NOT set",
// which is what #164 needs: absent is a legitimate state for the vouch
// secret and the one every laptop runs in.
async function load(
  overrides: Record<string, string | undefined> = {},
): Promise<Loaded> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    ...REQUIRED,
    // `src/env.ts` starts with `import "dotenv/config"`, so without this the
    // child also reads whatever `.env` happens to be on disk — and CI puts one
    // there (`cp .env.test .env`, ci.yml) holding a complete storage set. That
    // filled in the very variables a case had just removed, so "half a
    // configuration is refused" passed on a laptop and failed in CI. Pointed
    // at a file that cannot exist, the only environment is the one below.
    DOTENV_CONFIG_PATH: path.join(tmpdir(), "farhand-no-such-file.env"),
  };
  // The suite's own settings are in `process.env` (vitest.config.ts hands
  // them to every worker), and they include a complete storage set. Removing
  // the groups is what makes each case say only what it means to say.
  for (const key of GROUPED) env[key] = undefined;
  Object.assign(env, overrides);

  try {
    await run(process.execPath, ["src/env.ts"], { env, cwd: process.cwd() });
    return { ok: true, complaint: "" };
  } catch (error) {
    const failure = error as { stderr?: string; stdout?: string };
    return {
      ok: false,
      complaint: `${failure.stderr ?? ""}${failure.stdout ?? ""}`,
    };
  }
}

describe("a group of settings is all or none", () => {
  it("loads with neither group set at all", async () => {
    // The state of a fresh clone: no store, no mail, and an API that still
    // starts and serves everything that does not need them.
    expect(await load()).toMatchObject({ ok: true });
  });

  it("refuses a mail key with no sender, and names the sender", async () => {
    const { ok, complaint } = await load({ MAIL_API_KEY: "xkeysib-test" });

    expect(ok).toBe(false);
    expect(complaint).toContain("MAIL_FROM");
  });

  it("refuses a sender with no key, and names the key", async () => {
    const { ok, complaint } = await load({ MAIL_FROM: "farhand@example.com" });

    expect(ok).toBe(false);
    expect(complaint).toContain("MAIL_API_KEY");
  });

  it("loads with both halves of the mail pair", async () => {
    expect(
      await load({
        MAIL_API_KEY: "xkeysib-test",
        MAIL_FROM: "farhand@example.com",
      }),
    ).toMatchObject({ ok: true });
  });

  it("refuses a sender that is not an address", async () => {
    const { ok, complaint } = await load({
      MAIL_API_KEY: "xkeysib-test",
      MAIL_FROM: "farhand-at-example-dot-com",
    });

    expect(ok).toBe(false);
    expect(complaint).toContain("MAIL_FROM");
  });

  it("does not count the optional mail settings as part of the pair", async () => {
    // A display name on its own configures nothing and must not demand a key:
    // the pair is what sending needs, and these two are decoration and choice.
    expect(
      await load({ MAIL_FROM_NAME: "Farhand", MAIL_REPLY_TO: "" }),
    ).toMatchObject({ ok: true });
  });

  it("refuses one storage setting out of five, and names the other four", async () => {
    const { ok, complaint } = await load({ STORAGE_BUCKET: "farhand-files" });

    expect(ok).toBe(false);
    for (const missing of [
      "STORAGE_ENDPOINT",
      "STORAGE_REGION",
      "STORAGE_ACCESS_KEY_ID",
      "STORAGE_SECRET_ACCESS_KEY",
    ]) {
      expect(complaint).toContain(missing);
    }
  });
});

/**
 * The vouch secret — issue #164.
 *
 * It is deliberately NOT wrapped in `blankIsAbsent`, by the rule that
 * function documents: it is half of a pair, the other half living on the
 * Vercel project, so an empty value is a secret somebody meant to set and got
 * wrong. Degrading quietly there means every visitor silently shares one
 * rate-limit bucket, which is the bug #164 exists to fix — arriving by the
 * back door and much harder to notice the second time.
 *
 * This is also why `.env.example` keeps the line COMMENTED OUT. Copying that
 * file is how everyone starts, and an empty value in it would stop the API
 * from booting at all.
 */
describe("the secret the frontend proves itself with", () => {
  it("loads when it is absent, which is every laptop and the whole suite", async () => {
    expect(await load({ PROXY_VOUCH_SECRET: undefined })).toMatchObject({
      ok: true,
    });
  });

  it("loads with a long one", async () => {
    expect(await load({ PROXY_VOUCH_SECRET: "v".repeat(40) })).toMatchObject({
      ok: true,
    });
  });

  it("refuses an empty one rather than treating it as absent", async () => {
    const { ok, complaint } = await load({ PROXY_VOUCH_SECRET: "" });

    expect(ok).toBe(false);
    expect(complaint).toContain("PROXY_VOUCH_SECRET");
  });

  it("refuses a short one, because that is a typo and not a choice", async () => {
    const { ok, complaint } = await load({ PROXY_VOUCH_SECRET: "too-short" });

    expect(ok).toBe(false);
    expect(complaint).toContain("PROXY_VOUCH_SECRET");
  });
});
