/* eslint-disable @typescript-eslint/no-unused-vars --
   The stubs at the bottom of this file do not use their arguments or the
   imports yet. DELETE THIS LINE once both functions are implemented — if it
   stops being necessary and stays, it hides real unused-variable bugs. */
import { hash, verify } from "@node-rs/argon2";

/**
 * Password hashing. The only file in the project that should import argon2.
 *
 * Keeping it in one place means the cost parameters are decided once, and
 * changing them later is a single edit rather than a search.
 *
 * Background, worth reading once: a password hash is deliberately SLOW. A fast
 * hash (SHA-256, MD5) can be computed billions of times per second on a GPU, so
 * a stolen database of them is a stolen database of passwords. argon2id is slow
 * *and* memory-hungry, which is what defeats GPUs — they have thousands of
 * cores but not gigabytes of memory per core.
 *
 * docs/07-trust-and-safety.md commits us to argon2id specifically.
 */

/**
 * argon2id, spelled as a number.
 *
 * The library exports an `Algorithm` enum, but it is an ambient `const enum`,
 * which TypeScript refuses to import while `verbatimModuleSyntax` is on — a
 * const enum is erased at compile time, and that flag forbids imports that
 * vanish. The values are part of the library's public API (Argon2d 0,
 * Argon2i 1, Argon2id 2), so naming it here is safe. The test suite pins it by
 * asserting the "$argon2id$" prefix on a real hash, so a wrong number cannot
 * pass silently.
 */
const ARGON2ID = 2;

/**
 * Cost parameters.
 *
 * These are OWASP's recommended minimum (19 MiB of memory, 2 passes, 1 thread),
 * which also happen to be this library's defaults. They are written out anyway:
 * a security property should be a decision in our code, not a default we
 * inherited and would never notice changing.
 *
 * Raising memoryCost is the effective lever if you want it stronger. It costs
 * ~19 MiB per concurrent hash, so it also bounds how many registrations the API
 * can process at once — that trade is the reason to think before changing it.
 */
const HASH_OPTIONS = {
  algorithm: ARGON2ID,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

/**
 * Hashes a plaintext password for storage.
 *
 * The returned string is self-describing: it carries the algorithm, the
 * parameters and a per-password random salt, all in one field. That is why
 * there is no separate salt column in the schema, and why raising the cost
 * parameters later does not invalidate existing hashes — each one remembers
 * how it was made.
 */
export async function hashPassword(plaintext: string): Promise<string> {
  return hash(plaintext, HASH_OPTIONS);
}

/**
 * Checks a plaintext password against a stored hash. Needed by login (#11);
 * here now so the pair lives together.
 *
 * Do NOT hash the input and compare strings — the salt is random per password,
 * so the digests would never match. argon2's `verify` reads the parameters and
 * salt out of the stored hash and does a constant-time comparison.
 *
 * TODO(#11): `return verify(storedHash, plaintext)` — one line. Then DELETE the
 * eslint-disable comment at the top of this file: nothing is unused any more.
 */
export async function verifyPassword(
  storedHash: string,
  plaintext: string,
): Promise<boolean> {
  // TODO(#11): replace this whole body.
  return Promise.reject(new Error("verifyPassword is not implemented yet"));
}

/**
 * A real argon2id hash of a random string nobody knows, made with the same
 * cost parameters as HASH_OPTIONS.
 *
 * Login uses it when the email does not match any account. Verifying the typed
 * password against THIS hash takes as long as verifying it against a real one,
 * so an unknown email and a wrong password take the same time to answer.
 * Without it, an unknown email would return in about a millisecond and a known
 * one in tens of milliseconds — and the speed alone would tell an attacker
 * which emails have accounts. Same lesson as hashing on the duplicate path in
 * registration.
 *
 * It can never match anything: the input that produced it was 32 random bytes,
 * generated once and thrown away. If HASH_OPTIONS ever changes, regenerate this
 * with the new parameters so the timing stays equal.
 */
export const DUMMY_PASSWORD_HASH =
  "$argon2id$v=19$m=19456,t=2,p=1$Yr1nY6lC5NZ7d0sqm4OGoQ$FJzxPvt5N4h0Em/7DQu3URuiLWloCyReHE1x4EE4dwE";
