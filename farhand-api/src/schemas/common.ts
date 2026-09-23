import { z } from "zod";

/**
 * Field rules more than one router needs.
 *
 * Two letters, three letters — trivial on their own, and exactly the kind of
 * thing that drifts when it is written twice: one endpoint accepting "eesti"
 * because someone relaxed a regex there and not here.
 */

/** ISO 3166-1 alpha-2, upper-cased. */
export const countryCode = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{2}$/, "Must be a two-letter country code");

/** ISO 4217, upper-cased. */
export const currencyCode = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{3}$/, "Must be a three-letter currency code");
