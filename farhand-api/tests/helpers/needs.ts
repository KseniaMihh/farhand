import type { DealStatus, Need } from "@prisma/client";
import { prisma } from "../../src/db.js";
import { currentProhibitedVersion } from "./prohibited.js";

/**
 * Fixtures for need tests: a category to file a need under, and a deal to
 * stand in the way of deleting one.
 */

/** A category, since a need cannot exist without one and tests start empty. */
export async function createCategory(slug = "electronics") {
  return prisma.category.create({
    data: { slug, name: `${slug[0]?.toUpperCase() ?? ""}${slug.slice(1)}` },
  });
}

/**
 * A complete, valid request body for POST /needs. Override what matters.
 *
 * ASYNC SINCE #87, and that is the one awkward thing about this issue: a
 * public posting has to tick the current prohibited list, and the version is
 * a fingerprint of the list in the database rather than a constant anybody
 * can write down. So the body is read from the world, like the category id
 * above it.
 *
 * Overrides come last, so a test can send a stale version on purpose.
 */
export async function needBody(
  categoryId: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    categoryId,
    title: "Japanese sunscreen, 50 ml",
    description: "The Biore one that is not sold in Europe. Two bottles.",
    buyCountry: "JP",
    deliverCountry: "EE",
    currency: "EUR",
    estimatedPrice: 2400,
    prohibitedVersion: await currentProhibitedVersion(),
    ...overrides,
  };
}

/**
 * A deal on a need, which is what makes it undeletable.
 *
 * A deal cannot exist on its own: it hangs off a proposal, which is the single
 * junction between a need and a helper (docs/05-data-model.md). So this makes
 * both.
 */
export async function createDealFor(
  need: Need,
  helperId: string,
  // Any status, since #82: receipts are attached to deals that have got as far
  // as PRODUCT_PAID, and reaching one through the real transitions would be a
  // test of #23 rather than of receipts.
  status: DealStatus = "MATCHED",
) {
  const proposal = await prisma.proposal.create({
    data: {
      needId: need.id,
      helperId,
      initiatedBy: "HELPER",
      status: "ACCEPTED",
    },
  });

  return prisma.deal.create({
    data: {
      proposalId: proposal.id,
      needId: need.id,
      requesterId: need.requesterId,
      helperId,
      status,
      currency: need.currency,
    },
  });
}
