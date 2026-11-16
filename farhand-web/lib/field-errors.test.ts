import { describe, expect, it } from "vitest";
import { ApiFailure } from "./api.js";
import { fieldErrorsIn, hasFieldErrors } from "./field-errors.js";

/**
 * The specification for lib/field-errors.ts — issue #156.
 *
 * Every form in the product will paint its red text from this one function,
 * so what it does with a body that is not quite what was promised matters
 * more than what it does with a tidy one. `details` is the ONE part of the
 * error envelope that lib/api.ts does not validate: `errorIn` checks `code`
 * and `message` and passes the rest through as it arrived. So these tests
 * carry the whole weight of "and what if it is rubbish".
 */

/** An API failure carrying exactly these `details`. */
function blaming(details: unknown) {
  return new ApiFailure(422, {
    code: "VALIDATION_FAILED",
    message: "Some of that is not right",
    requestId: "51de6d13",
    details: details as { field: string; message: string }[],
  });
}

describe("what it makes of a failure", () => {
  it("maps each field to what was said about it", () => {
    const errors = fieldErrorsIn(
      blaming([
        { field: "email", message: "Enter a full email address" },
        { field: "password", message: "Use at least 8 characters" },
      ]),
    );

    expect(errors).toEqual({
      email: "Enter a full email address",
      password: "Use at least 8 characters",
    });
  });

  /**
   * The API lists them in the order it checked, so the first is the rule the
   * input actually broke. Showing the last would tell somebody about a rule
   * their value never reached — "must be under 50 characters" for a field
   * they left empty.
   */
  it("keeps the first thing said about a field, not the last", () => {
    const errors = fieldErrorsIn(
      blaming([
        { field: "displayName", message: "Enter a name" },
        { field: "displayName", message: "Use at most 50 characters" },
      ]),
    );

    expect(errors.displayName).toBe("Enter a name");
  });
});

describe("what it makes of everything else", () => {
  /**
   * An empty object means "no field is to blame", which is the true reading
   * of a 401, a 409 or a 500. It lets a form show the API's one sentence
   * without first asking what kind of failure it had.
   */
  it("blames no field when the failure has no details", () => {
    const failure = new ApiFailure(409, {
      code: "CONFLICT",
      message: "This deal has just changed",
    });

    expect(fieldErrorsIn(failure)).toEqual({});
  });

  it("blames no field when details is there but empty", () => {
    expect(fieldErrorsIn(blaming([]))).toEqual({});
  });

  it("blames no field when the thing thrown was not ours", () => {
    expect(fieldErrorsIn(new TypeError("Failed to fetch"))).toEqual({});
    expect(fieldErrorsIn("something went wrong")).toEqual({});
    expect(fieldErrorsIn(null)).toEqual({});
    expect(fieldErrorsIn(undefined)).toEqual({});
  });

  /**
   * `details` arrives unvalidated, so this is not paranoia about our own
   * API — it is about a proxy, a cache or a future version sending something
   * close but not identical. A form that trusted it would render the string
   * "undefined" under an input, which looks like a bug in the form.
   */
  it("ignores an entry that is not a field and a message", () => {
    const errors = fieldErrorsIn(
      blaming([
        { field: "email", message: "Enter a full email address" },
        { field: "password" },
        { message: "orphaned" },
        { field: 7, message: "a number is not a field name" },
        { field: "bio", message: null },
        "not an object at all",
        null,
      ]),
    );

    expect(errors).toEqual({ email: "Enter a full email address" });
    expect(Object.values(errors)).not.toContain(undefined);
  });

  it("blames no field when details is not a list", () => {
    expect(fieldErrorsIn(blaming({ email: "nope" }))).toEqual({});
    expect(fieldErrorsIn(blaming("nope"))).toEqual({});
  });

  /**
   * Field names come from the API, which means they come from whatever a
   * later endpoint calls its columns. Two of them are booby traps on a plain
   * object: `"toString" in errors` is true before anything is added, so a
   * first-wins check would silently drop that field, and assigning
   * `__proto__` sets the prototype instead of a key.
   *
   * No endpoint has a field called either today. The test is here because
   * the defence — building through a Map — is invisible, and an invisible
   * defence with no test is one somebody simplifies away.
   */
  it("handles a field named after something on Object's prototype", () => {
    const errors = fieldErrorsIn(
      blaming([
        { field: "toString", message: "Not a valid name" },
        { field: "constructor", message: "Nor that" },
        { field: "__proto__", message: "Nor that either" },
      ]),
    );

    // Read as entries rather than by property access: `errors.toString`
    // would resolve to Object's own method before it reached the key, which
    // is the very confusion this test is about.
    const entries = Object.entries(errors);

    expect(entries).toContainEqual(["toString", "Not a valid name"]);
    expect(entries).toContainEqual(["constructor", "Nor that"]);
    expect(entries).toContainEqual(["__proto__", "Nor that either"]);
    // An ordinary object, not one whose prototype has been replaced.
    expect(Object.getPrototypeOf(errors)).toBe(Object.prototype);
  });
});

/**
 * A form uses this to choose between showing the API's top-level sentence and
 * letting the inputs speak for themselves. Saying both is how a screen tells
 * somebody "3 things to fix" and then marks one.
 */
describe("whether anything was blamed on a field", () => {
  it("is false for nothing", () => {
    expect(hasFieldErrors({})).toBe(false);
  });

  it("is true for something", () => {
    expect(hasFieldErrors({ email: "Enter a full email address" })).toBe(true);
  });
});
