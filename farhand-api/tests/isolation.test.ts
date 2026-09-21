import { describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";

/**
 * Tests for the test harness itself.
 *
 * Isolation between tests is the kind of thing that appears to work right up
 * until a test passes alone and fails in the suite, at which point you are
 * debugging the runner instead of the product. These two tests fail loudly and
 * immediately if truncation ever stops happening.
 *
 * They are order-dependent on purpose — the second only means anything after
 * the first has written a row — which is safe because vitest.config.ts runs
 * tests within a file sequentially, in source order.
 */
describe("database isolation", () => {
  it("starts from an empty database and can write to it", async () => {
    expect(await prisma.category.count()).toBe(0);

    await prisma.category.create({
      data: { slug: "leftover", name: "Leftover" },
    });

    expect(await prisma.category.count()).toBe(1);
  });

  it("does not see the row the previous test wrote", async () => {
    expect(await prisma.category.count()).toBe(0);
  });
});
