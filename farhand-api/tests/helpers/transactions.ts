import { vi } from "vitest";
import { prisma } from "../../src/db.js";

/**
 * Break one model's write from inside a real transaction.
 *
 * Spying on `prisma.dealEvent.create` does not work: inside `$transaction` the
 * service writes through a different client — the `tx` handed to the callback —
 * and the spy never fires. So this lets the real transaction begin and passes
 * the service a `tx` whose chosen model refuses to write. The rollback that
 * follows is Postgres's own, not something the test arranged.
 *
 * An implementation that never calls `$transaction` never reaches this: it
 * writes its rows one by one, they survive, and the assertions fail. That is
 * the point of it — this is how "all of it or none of it" is tested from the
 * outside.
 *
 * Restore with `vi.restoreAllMocks()`; the mock only applies to the next
 * transaction, so one call breaks one request.
 */
export function breakInsideTransaction(
  model:
    | "deal"
    | "dealEvent"
    | "quote"
    | "proposal"
    | "need"
    | "user"
    | "profile"
    | "session"
    | "help",
  method: "create" | "update" | "updateMany" = "create",
): { attempts: number } {
  const record = { attempts: 0 };
  const real = prisma.$transaction.bind(prisma) as (
    run: (tx: unknown) => Promise<unknown>,
  ) => Promise<unknown>;

  vi.spyOn(prisma, "$transaction").mockImplementationOnce(((
    run: (tx: unknown) => Promise<unknown>,
  ) =>
    real((tx) =>
      run(
        new Proxy(tx as object, {
          get(target, property) {
            if (property !== model) {
              return Reflect.get(target, property) as unknown;
            }

            const delegate = Reflect.get(target, property) as object;

            return new Proxy(delegate, {
              get(inner, call) {
                if (call !== method) {
                  return Reflect.get(inner, call) as unknown;
                }

                return () => {
                  record.attempts += 1;
                  return Promise.reject(
                    new Error(`${model}.${method} is on fire`),
                  );
                };
              },
            });
          },
        }),
      ),
    )) as never);

  return record;
}
