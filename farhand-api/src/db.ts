import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { env } from "./env.js";

/**
 * The Prisma client, created once and shared by the whole app.
 *
 * Prisma 7 dropped the Rust query engine binary in favour of a WASM query
 * compiler, which means it no longer talks to the database itself — it hands
 * the generated SQL to a *driver adapter*. For PostgreSQL that adapter is
 * @prisma/adapter-pg, wrapping the node-postgres connection pool.
 *
 * One client for the process is important: each `new PrismaClient()` opens its
 * own pool, and a handful of those will exhaust Postgres's connection limit.
 */
const adapter = new PrismaPg({ connectionString: env.DATABASE_URL });

export const prisma = new PrismaClient({ adapter });

/** Cheap round-trip to prove the database is reachable. Used by /health. */
export async function pingDatabase(): Promise<void> {
  await prisma.$queryRaw`SELECT 1`;
}
