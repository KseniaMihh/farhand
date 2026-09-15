import { createApp } from "./app.js";
import { prisma, pingDatabase } from "./db.js";
import { env } from "./env.js";
import { logger } from "./logger.js";

/**
 * Starts the API.
 *
 * Two things here are easy to skip and annoying to add later: checking the
 * database before announcing readiness, and shutting down gracefully.
 */
async function main(): Promise<void> {
  // Fail loudly at startup rather than on the first request. If the database
  // is unreachable, a crash-looping container is a much clearer signal than an
  // API that accepts traffic and 500s on everything.
  await pingDatabase();
  logger.info("Database connection established");

  const app = createApp();

  const server = app.listen(env.PORT, () => {
    logger.info(
      { port: env.PORT, env: env.NODE_ENV },
      `Farhand API listening on http://localhost:${env.PORT}`,
    );
  });

  /**
   * Graceful shutdown.
   *
   * When a platform redeploys, it sends SIGTERM and then kills the process a
   * few seconds later. Without this handler, requests that were mid-flight are
   * simply severed. With it, the server stops accepting new connections,
   * finishes what it is doing, closes the database pool, then exits.
   *
   * Note for testing on Windows: this path cannot be exercised from Git Bash.
   * `kill -TERM` there force-terminates the process rather than delivering a
   * POSIX signal, so the handler never runs and you see no shutdown logs. It
   * works normally on Linux, which is where this actually runs in production.
   * Ctrl+C in the terminal does deliver SIGINT and will trigger it.
   */
  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, "Shutting down");

    // Don't hang forever if a connection refuses to close.
    const forceExit = setTimeout(() => {
      logger.error("Graceful shutdown timed out, forcing exit");
      process.exit(1);
    }, 10_000);
    forceExit.unref();

    try {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
      await prisma.$disconnect();
      logger.info("Shutdown complete");
      process.exit(0);
    } catch (error) {
      logger.error({ err: error }, "Error during shutdown");
      process.exit(1);
    }
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  // A rejected promise nobody caught means state is now unknown. Log it and
  // let the process die rather than limp along in a state we can't reason about.
  process.on("unhandledRejection", (reason) => {
    logger.fatal({ err: reason }, "Unhandled promise rejection");
    process.exit(1);
  });

  process.on("uncaughtException", (error) => {
    logger.fatal({ err: error }, "Uncaught exception");
    process.exit(1);
  });
}

main().catch((error: unknown) => {
  logger.fatal({ err: error }, "Failed to start the API");
  process.exit(1);
});
