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
 *   who      everybody who may ask for it
 *   requires which extra fields the request must carry
 *
 * ONE ROW PER (from, to) PAIR. `findTransition` returns the first match, so
 * a second row for a move that is already in the table is dead code the
 * compiler cannot see. When two kinds of actor may make the same move, they
 * share a row; when they may make it from different states, the row splits —
 * which is what #134 did to cancellation, because a moderator may end a deal
 * nobody has paid for and may not end one somebody has.
 *
 * The side effects in the document — "need may reopen", "reviews unlock",
 * "requester notified" — are NOT here. They belong to the issues that build
 * them (#25 and later), and an engine that also performed them would be two
 * things at once.
 */

/** Who may ask for a transition. */
export type TransitionActor = "requester" | "helper" | "moderator";

/**
 * The two people in the deal, which is what the document's "Either side"
 * means. Written out rather than spelled `"either"` because #134 needed a
 * row for "either side, or a moderator", and a magic value that stands for
 * two of the three actors cannot be added to.
 */
export const EITHER_SIDE: TransitionActor[] = ["requester", "helper"];

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
  /**
   * Everybody who may ask. A set, and the rows below are the argument for
   * that: `findTransition` finds ONE rule per (from, to) pair, so two rows
   * for the same move with different actors would leave the second one
   * unreachable and nothing would say so (#134).
   */
  who: TransitionActor[];
  requires: TransitionField[];
}

export const TRANSITIONS: TransitionRule[] = [
  { from: ["MATCHED"], to: "QUOTE_AGREED", who: ["requester"], requires: [] },
  {
    from: ["QUOTE_AGREED"],
    to: "PRODUCT_PAID",
    who: ["requester"],
    requires: [],
  },
  { from: ["PRODUCT_PAID"], to: "PURCHASED", who: ["helper"], requires: [] },
  {
    from: ["PURCHASED"],
    to: "SHIPPED",
    who: ["helper"],
    requires: ["trackingNumber", "shippingActual"],
  },
  { from: ["SHIPPED"], to: "DELIVERED", who: ["requester"], requires: [] },
  // "Or automatically after 14 days" is a system actor, and belongs to #25.
  { from: ["DELIVERED"], to: "COMPLETED", who: ["requester"], requires: [] },
  // BEFORE ANY MONEY HAS MOVED a moderator may end it outright, and this is
  // the whole of #134's direct power. Nobody has paid for anything at
  // MATCHED or QUOTE_AGREED, so cancelling says only what is true: it ended
  // without delivery. The deadlock it breaks is an erasure (#88) that waits
  // on a stranger choosing to press a button.
  {
    from: ["MATCHED", "QUOTE_AGREED"],
    to: "CANCELLED",
    who: [...EITHER_SIDE, "moderator"],
    requires: ["note"],
  },
  // AFTER IT HAS, the two people keep the cancellation to themselves. A
  // moderator's way in is the row below — freeze it, look, then end it with
  // a note — and this split is decision 0030.
  {
    from: ["PRODUCT_PAID", "PURCHASED"],
    to: "CANCELLED",
    who: EITHER_SIDE,
    requires: ["note"],
  },
  // "Any state from PRODUCT_PAID to SHIPPED" — plus a moderator, who could
  // not reach a live deal at all before #134. This is the one row that makes
  // every live state settleable by somebody who is not in the deal: freeze
  // here, then end it through the next row.
  {
    from: ["PRODUCT_PAID", "PURCHASED", "SHIPPED"],
    to: "DISPUTED",
    who: [...EITHER_SIDE, "moderator"],
    requires: ["note"],
  },
  {
    from: ["DISPUTED"],
    to: "CANCELLED",
    who: ["moderator"],
    requires: ["note"],
  },
  // The other half of "CANCELLED or previous state" (#25). Only these three
  // can ever be the previous state, because they are the only states a dispute
  // can start from — and WHICH of them is allowed for a given deal is not
  // something a table can say: it depends on that deal's own history. The
  // service checks it against the event log.
  {
    from: ["DISPUTED"],
    to: "PRODUCT_PAID",
    who: ["moderator"],
    requires: ["note"],
  },
  {
    from: ["DISPUTED"],
    to: "PURCHASED",
    who: ["moderator"],
    requires: ["note"],
  },
  {
    from: ["DISPUTED"],
    to: "SHIPPED",
    who: ["moderator"],
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
 *
 * `null` is a stranger, and a stranger never may — though they are told
 * `404` rather than `403`, because whether a deal exists is not their
 * business either (../routes/deals.ts).
 */
export function mayTransition(
  rule: TransitionRule,
  side: "requester" | "helper" | "moderator" | null,
): boolean {
  if (side === null) return false;

  return rule.who.includes(side);
}
