/**
 * Turning a `422` into something a form can draw.
 *
 * The API answers a failed body with `details`, one entry per field that was
 * wrong (#4, docs/06-api-contract.md):
 *
 *     { "error": { "code": "VALIDATION_FAILED", "message": "…",
 *                  "details": [{ "field": "email", "message": "…" }] } }
 *
 * A form wants the opposite shape — "what is wrong with THIS input" — so the
 * flip happens once, here, and every form in the product reads the same way.
 * Doing it per screen is how two forms end up disagreeing about what a
 * missing `details` means.
 */

import { ApiFailure } from "./api";

/** Field name → the first message about it. */
export type FieldErrors = Record<string, string>;

/**
 * The per-field messages in a failure, or an empty object.
 *
 * `details` is the one part of the error envelope `lib/api.ts` does NOT
 * validate — `errorIn` checks `code` and `message` and passes the rest
 * through as it arrived — so every entry is checked here before it is
 * believed. Not paranoia about our own API: a proxy, a cache or a later
 * version sending something close but not identical would otherwise put the
 * string "undefined" under an input, which looks like a bug in the form.
 */
export function fieldErrorsIn(error: unknown): FieldErrors {
  if (!(error instanceof ApiFailure)) return {};

  const details: unknown = error.error.details;
  if (!Array.isArray(details)) return {};

  // A Map, not an object literal, for two reasons that are the same reason:
  // `"toString" in errors` is true on a plain object, so an "is this field
  // already spoken for?" check would silently drop a field called `toString`;
  // and assigning `__proto__` on one sets the prototype instead of a key.
  // `Object.fromEntries` then builds a plain object with both as own keys.
  const found = new Map<string, string>();

  for (const entry of details as unknown[]) {
    if (typeof entry !== "object" || entry === null) continue;

    const { field, message } = entry as { field?: unknown; message?: unknown };

    if (typeof field !== "string" || field === "") continue;
    if (typeof message !== "string") continue;

    // The API lists them in the order it checked, so the first is the rule
    // the input actually broke. Showing the last would tell somebody about a
    // rule their value never reached — "at most 50 characters" for a field
    // they left empty.
    if (found.has(field)) continue;

    found.set(field, message);
  }

  return Object.fromEntries(found);
}

/**
 * Whether anything at all was blamed on a field.
 *
 * A form uses this to choose between showing the API's top-level sentence and
 * letting the inputs speak for themselves. Saying both is how a screen tells
 * somebody "3 things to fix" and then marks one.
 */
export function hasFieldErrors(errors: FieldErrors): boolean {
  return Object.keys(errors).length > 0;
}
