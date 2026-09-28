import type { DealStatus } from "@prisma/client";

/**
 * The transition table — the one in docs/04-deal-lifecycle.md, in code.
 *
 * "Any transition not in this table is invalid, including going backwards."
 * That sentence is only true if there is exactly ONE table, so this is it:
 * the routes validate against it, the service enforces it, and the tests walk
 * it. Nothing anywhere else may decide that a status change is allowed.
 *
 * transition table: see docs/04-deal-lifecycle.md
 *
 * A row says four things, and the fourth is what makes the table worth having
 * as data rather than as a chain of if-statements:
 *
 *   from     which statuses this may run from
 *   to       where it lands
 *   who      which side may ask for it
 *   requires which extra fields the request must carry
 *
 * The side effects in the document — "need may reopen", "reviews unlock",
 * "requester notified" — are NOT here. They belong to the issues that build
 * them (#25 and later), and an engine that also performed them would be two
 * things at once.
 */

/** Which side of a deal may ask for a transition. */
export type TransitionActor = "requester" | "helper" | "either" | "moderator";

/** The extra fields a transition can demand. */
export const TRANSITION_FIELDS = [
  "note",
  "trackingNumber",
  "shippingActual",
] as const;

export type TransitionField = (typeof TRANSITION_FIELDS)[number];

export interface TransitionRule {
  from: DealStatus[];
  to: DealStatus;
  who: TransitionActor;
  requires: TransitionField[];
}

export const TRANSITIONS: TransitionRule[] = [
  { from: ["MATCHED"], to: "QUOTE_AGREED", who: "requester", requires: [] },
  {
    from: ["QUOTE_AGREED"],
    to: "PRODUCT_PAID",
    who: "requester",
    requires: [],
  },
  { from: ["PRODUCT_PAID"], to: "PURCHASED", who: "helper", requires: [] },
  {
    from: ["PURCHASED"],
    to: "SHIPPED",
    who: "helper",
    requires: ["trackingNumber", "shippingActual"],
  },
  { from: ["SHIPPED"], to: "DELIVERED", who: "requester", requires: [] },
  // "Or automatically after 14 days" is a system actor, and belongs to #25.
  { from: ["DELIVERED"], to: "COMPLETED", who: "requester", requires: [] },
  // "Any state before SHIPPED". DISPUTED is deliberately not in this list: the
  // moderator's way out of a dispute is the last row.
  {
    from: ["MATCHED", "QUOTE_AGREED", "PRODUCT_PAID", "PURCHASED"],
    to: "CANCELLED",
    who: "either",
    requires: ["note"],
  },
  // "Any state from PRODUCT_PAID to SHIPPED".
  {
    from: ["PRODUCT_PAID", "PURCHASED", "SHIPPED"],
    to: "DISPUTED",
    who: "either",
    requires: ["note"],
  },
  { from: ["DISPUTED"], to: "CANCELLED", who: "moderator", requires: ["note"] },
  // The other half of "CANCELLED or previous state" (#25). Only these three
  // can ever be the previous state, because they are the only states a dispute
  // can start from — and WHICH of them is allowed for a given deal is not
  // something a table can say: it depends on that deal's own history. The
  // service checks it against the event log.
  {
    from: ["DISPUTED"],
    to: "PRODUCT_PAID",
    who: "moderator",
    requires: ["note"],
  },
  {
    from: ["DISPUTED"],
    to: "PURCHASED",
    who: "moderator",
    requires: ["note"],
  },
  {
    from: ["DISPUTED"],
    to: "SHIPPED",
    who: "moderator",
    requires: ["note"],
  },
];

/**
 * The rule for one move, or undefined if the table does not allow it.
 */
export function findTransition(
  from: DealStatus,
  to: DealStatus,
): TransitionRule | undefined {
  return TRANSITIONS.find((rule) => rule.to === to && rule.from.includes(from));
}

/**
 * Whether this person may ask for this transition.
 */
export function mayTransition(
  rule: TransitionRule,
  side: "requester" | "helper" | "moderator" | null,
): boolean {
  if (side === null) return false;

  // "either" means the deal's two people, and not a moderator: a moderator
  // resolving a dispute has a row of its own.
  if (rule.who === "either") return side === "requester" || side === "helper";

  return rule.who === side;
}
