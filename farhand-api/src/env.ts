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
   * The origin check on writes, off in the test suite for the same reason rate
   * limiting is: four hundred tests post without a browser to set an Origin
   * header. tests/security/csrf.test.ts turns it on for itself.
   */
  CSRF_ENABLED: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),
});

const parsed = envSchema.safeParse(process.env);

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
