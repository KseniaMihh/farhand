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

/** Field name → the first message about it. */
export type FieldErrors = Record<string, string>;

/**
 * The per-field messages in a failure, or an empty object.
 *
 * TODO(#156):
 *   - not an `ApiFailure`, or no `details` → `{}`. An empty object means "no
 *     field is to blame", which is the right reading of a `409` or a `500`,
 *     and lets a form render the top-level message alone without asking what
 *     kind of failure it had.
 *   - two entries for one field → keep the FIRST. The API lists them in the
 *     order it checked, so the first is the one that actually stopped the
 *     request; showing the last would tell somebody about a rule their input
 *     never reached.
 */
export function fieldErrorsIn(_error: unknown): FieldErrors {
  // TODO(#156): narrow with `instanceof ApiFailure` from ./api.
  return {};
}

/**
 * Whether anything at all was blamed on a field.
 *
 * TODO(#156): a form uses this to decide between showing the API's top-level
 * sentence and letting the inputs speak for themselves. Saying both is how a
 * screen tells somebody "3 things to fix" and then marks one.
 */
export function hasFieldErrors(_errors: FieldErrors): boolean {
  // TODO(#156)
  return false;
}
