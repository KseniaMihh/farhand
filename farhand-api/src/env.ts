import "dotenv/config";
import { z } from "zod";

/**
 * Every environment variable the API needs, described once.
 *
 * The point of this file is fail-fast: if DATABASE_URL is missing or PORT is
 * "banana", the process dies at startup with a readable message, instead of
 * throwing something cryptic on the first request an hour later.
 *
 * Everywhere else in the codebase, import `env` from here rather than reading
 * `process.env` directly — that way the values are validated and typed.
 */
/**
 * An optional setting where "set, but empty" means "not set" (#119).
 *
 * Only for settings that are genuinely optional. A dashboard makes it easy to
 * add a variable and save it blank, and for a display name or a reply address
 * the forgiving reading is the right one: the alternative is an API that
 * refuses to boot because somebody left a decoration empty. The halves of a
 * required pair are NOT wrapped in this — blank there means a configuration
 * somebody meant to set and got wrong, which should stop the deploy.
 *
 * Found by a test, not by thinking: `MAIL_REPLY_TO=""` took the whole API
 * down in `tests/env.test.ts` before this existed.
 */
function blankIsAbsent<T extends z.ZodType>(schema: T) {
  // `preprocess` and not `transform().pipe()`: the empty string has to become
  // `undefined` BEFORE `optional()` looks at it. The other way round, the key
  // is present, so `optional()` never applies and the inner schema is handed
  // an undefined it rightly refuses — which is exactly what the first version
  // of this did.
  return z.preprocess(
    (value: unknown) =>
      typeof value === "string" && value.trim() === "" ? undefined : value,
    schema.optional(),
  );
}

const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),

  PORT: z.coerce.number().int().positive().max(65535).default(3000),

  DATABASE_URL: z
    .string()
    .min(1, "DATABASE_URL is required — copy .env.example to .env")
    .refine(
      (url) => url.startsWith("postgres://") || url.startsWith("postgresql://"),
      "DATABASE_URL must be a PostgreSQL connection string",
    ),

  // Rate limiting is on everywhere except the test suite, where a hundred
  // requests from one address is normal and not an attack. The tests that
  // cover rate limiting turn it back on for themselves.
  RATE_LIMIT_ENABLED: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),

  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),

  /**
   * The one place the frontend is served from.
   *
   * Used twice: CORS allows exactly this origin and no other, and a write
   * whose `Origin` is anything else is refused (docs/09-environment.md). One
   * value rather than a list, because "the intended frontend origin only" is
   * the requirement, and a list is how that turns into "whatever we forgot to
   * take out".
   */
  APP_ORIGIN: z.url().default("http://localhost:5173"),

  /**
   * Where unexpected errors are reported, when there is anywhere to report
   * them. Absent in development and in the test suite, which is what keeps
   * both of them entirely offline (issue #29).
   */
  SENTRY_DSN: z.url().optional(),

  /**
   * The commit this process was deployed from. Render sets it on every
   * deploy; nothing sets it locally or in the test suite. `GET /health`
   * reports it, which is how the deploy job tells the new version from the
   * old one (docs/14-deployment.md, decision 0010).
   */
  RENDER_GIT_COMMIT: z.string().min(1).optional(),

  /**
   * The origin check on writes, off in the test suite for the same reason rate
   * limiting is: four hundred tests post without a browser to set an Origin
   * header. tests/security/csrf.test.ts turns it on for itself.
   */
  CSRF_ENABLED: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),

  /**
   * Where uploaded files' bytes live: any S3-compatible store. Backblaze B2 in
   * production, S3Proxy in docker-compose and CI (decision 0011).
   *
   * Optional, like SENTRY_DSN: without them the API starts and serves
   * everything except files, so a fresh clone needs no storage to run. All
   * five or none — half a configuration is refused below rather than failing
   * on the first upload an hour later.
   */
  STORAGE_ENDPOINT: z.url().optional(),
  STORAGE_REGION: z.string().min(1).optional(),
  STORAGE_BUCKET: z.string().min(1).optional(),
  STORAGE_ACCESS_KEY_ID: z.string().min(1).optional(),
  STORAGE_SECRET_ACCESS_KEY: z.string().min(1).optional(),

  /**
   * How email is sent, and who it appears to come from (#119).
   *
   * Optional, on the same terms as the storage set: without them the API
   * starts, registering works, and the verification token is logged in
   * development instead of delivered. What is NOT optional is the pair —
   * a key with no sender, or a sender with no key, is refused below.
   *
   * Every one of these is a SETTING rather than a constant, because the
   * sender is the part most likely to change: today it is a project address
   * that Brevo has verified, and the day Farhand has a domain of its own it
   * becomes `no-reply@that-domain`, which should be a change in Render and
   * not a pull request.
   */
  MAIL_API_KEY: z.string().min(1).optional(),
  MAIL_FROM: z.string().trim().pipe(z.email()).optional(),
  /** What an inbox shows instead of the address. Defaults to "Farhand". */
  MAIL_FROM_NAME: blankIsAbsent(z.string().trim().min(1)),
  /**
   * Where replies go, if anywhere.
   *
   * Deliberately optional and deliberately empty by default. The sender
   * address is rewritten by the provider while Farhand has no domain
   * (decision 0014), so a reply to the visible From goes nowhere — and the
   * alternative, putting a personal address here, shows it to every stranger
   * who registers. A verification email does not need replies. Set it only
   * when there is an address that belongs to the project rather than to a
   * person.
   */
  MAIL_REPLY_TO: blankIsAbsent(z.string().trim().pipe(z.email())),
});

const STORAGE_KEYS = [
  "STORAGE_ENDPOINT",
  "STORAGE_REGION",
  "STORAGE_BUCKET",
  "STORAGE_ACCESS_KEY_ID",
  "STORAGE_SECRET_ACCESS_KEY",
] as const;

/**
 * The mail settings that stand or fall together (#119).
 *
 * `MAIL_FROM_NAME` and `MAIL_REPLY_TO` are not here on purpose: a key and a
 * sender are what sending requires, while a display name has a default and a
 * reply address is a choice.
 */
const MAIL_KEYS = ["MAIL_API_KEY", "MAIL_FROM"] as const;

/**
 * A set of variables that only means anything complete.
 *
 * Written once and used twice since #119. The alternative — failing on the
 * first upload, or on the first registration an hour after a deploy — is the
 * thing `env.ts` exists to prevent (#2).
 */
function allOrNone(
  values: Record<string, unknown>,
  ctx: z.core.$RefinementCtx,
  keys: readonly string[],
  prefix: string,
): void {
  const set = keys.filter((key) => values[key] !== undefined);
  if (set.length === 0 || set.length === keys.length) return;

  for (const key of keys.filter((k) => !set.includes(k))) {
    ctx.addIssue({
      code: "custom",
      path: [key],
      message: `${key} is required when any ${prefix} variable is set`,
    });
  }
}

const parsed = envSchema
  .superRefine((values, ctx) => {
    allOrNone(values, ctx, STORAGE_KEYS, "STORAGE_");
    allOrNone(values, ctx, MAIL_KEYS, "MAIL_");
  })
  .safeParse(process.env);

if (!parsed.success) {
  // Can't use the logger here — the logger itself depends on env.
  console.error("Invalid environment configuration:");
  for (const issue of parsed.error.issues) {
    console.error(`  ${issue.path.join(".")}: ${issue.message}`);
  }
  process.exit(1);
}

export const env = parsed.data;

export const isProduction = env.NODE_ENV === "production";
export const isTest = env.NODE_ENV === "test";
