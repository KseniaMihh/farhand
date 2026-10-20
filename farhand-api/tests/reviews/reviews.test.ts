import type { Deal, DealStatus, Need } from "@prisma/client";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { prisma } from "../../src/db.js";
import {
  MAX_COMMENT_LENGTH,
  REVIEW_WINDOW_DAYS,
} from "../../src/services/reviews.js";
import { DELETED_DISPLAY_NAME } from "../../src/services/erasure.js";
import { PASSWORD, signUpVerifiedAndLogIn } from "../helpers/auth.js";
import type { TestUser } from "../helpers/auth.js";
import { withoutRequestId } from "../helpers/http.js";
import { createCategory, createDealFor, needBody } from "../helpers/needs.js";
import { statementsDuring } from "../helpers/queries.js";

/**
 * Reviews (#83).
 *
 *   POST  /deals/:id/review
 *   PATCH /deals/:id/review
 *   GET   /users/:id/reviews
 *
 * and the deal's own answer, which carries what this caller may see.
 *
 * THE BLIND WINDOW IS WHAT THESE TESTS ARE MOSTLY ABOUT. Neither side sees the
 * other's review until both have written one, and writing CLOSES when the
 * window does — otherwise the second person can wait for the first review to
 * publish itself, read it, and answer with a revenge rating, which is the one
 * thing a blind window exists to prevent.
 *
 * Time is controlled through the data rather than through a fake clock: a deal
 * "completed 15 days ago" is a `COMPLETED` event with an older `createdAt`,
 * which is the same place `autoCompleteDeals` reads its dates from.
 */

const app = createApp();

let kadri: TestUser; // requester
let yuki: TestUser; // helper
let stranger: TestUser;
let categoryId: string;

beforeEach(async () => {
  kadri = await signUpVerifiedAndLogIn(app, "kadri@example.com", "Kadri");
  yuki = await signUpVerifiedAndLogIn(app, "yuki@example.com", "Yuki");
  stranger = await signUpVerifiedAndLogIn(app, "sam@example.com", "Sam");
  categoryId = (await createCategory()).id;
});

interface ReviewView {
  id: string;
  rating: number;
  comment: string | null;
  createdAt: string;
  author: { id: string; displayName: string };
  dealId: string;
  published: boolean;
}
interface ReviewBody {
  review: ReviewView;
}
interface DealBody {
  deal: { id: string; reviews: ReviewView[] };
}
interface PageBody {
  items: ReviewView[];
  nextCursor: string | null;
}

const DAY = 24 * 60 * 60 * 1000;

/**
 * A deal between Kadri and Yuki at `status`, completed `daysAgo` days ago.
 *
 * The completion time is the `COMPLETED` event, not a column — the same thing
 * the review deadline is measured from, so a test that wants an expired window
 * says `completedDeal(15)` and nothing else.
 */
async function dealAt(status: DealStatus, daysAgo = 0): Promise<Deal> {
  const created = await request(app)
    .post("/needs")
    .set("Cookie", kadri.cookie)
    .send(await needBody(categoryId));
  expect(created.status).toBe(201);
  const need = (created.body as { need: Need }).need;

  const deal = await createDealFor(need, yuki.id, status);

  if (status === "COMPLETED") {
    await prisma.dealEvent.create({
      data: {
        dealId: deal.id,
        actorId: kadri.id,
        fromStatus: "DELIVERED",
        toStatus: "COMPLETED",
        createdAt: new Date(Date.now() - daysAgo * DAY),
      },
    });
  }

  return deal;
}

function review(
  dealId: string,
  user: TestUser,
  body: { rating: number; comment?: string | null } = { rating: 5 },
) {
  return request(app)
    .post(`/deals/${dealId}/review`)
    .set("Cookie", user.cookie)
    .send(body);
}

function editReview(
  dealId: string,
  user: TestUser,
  body: { rating: number; comment?: string | null },
) {
  return request(app)
    .patch(`/deals/${dealId}/review`)
    .set("Cookie", user.cookie)
    .send(body);
}

/** Writes a review and fails the test if it was refused. */
async function reviewed(
  dealId: string,
  user: TestUser,
  body: { rating: number; comment?: string | null } = { rating: 5 },
): Promise<ReviewView> {
  const response = await review(dealId, user, body);
  expect(response.status).toBe(201);
  return (response.body as ReviewBody).review;
}

/** What `viewer` sees on the deal. */
async function reviewsOnDealAsSeenBy(
  dealId: string,
  viewer: TestUser,
): Promise<ReviewView[]> {
  const response = await request(app)
    .get(`/deals/${dealId}`)
    .set("Cookie", viewer.cookie);

  expect(response.status).toBe(200);
  return (response.body as DealBody).deal.reviews;
}

/** What anybody sees about a person. No session: a stranger has none. */
async function reviewsAbout(userId: string, query = ""): Promise<PageBody> {
  const response = await request(app).get(`/users/${userId}/reviews${query}`);

  expect(response.status).toBe(200);
  return response.body as PageBody;
}

/** A review row put in directly, for windows the API would now refuse. */
async function reviewRow(deal: Deal, author: TestUser, rating = 4) {
  return prisma.review.create({
    data: {
      dealId: deal.id,
      authorId: author.id,
      targetId: author.id === kadri.id ? yuki.id : kadri.id,
      rating,
    },
  });
}

describe("writing one", () => {
  it("is for a participant of a completed deal, about the other side", async () => {
    const deal = await dealAt("COMPLETED");

    const response = await review(deal.id, kadri, {
      rating: 4,
      comment: "Bought exactly the right thing and sent it the same week.",
    });

    expect(response.status).toBe(201);
    const written = (response.body as ReviewBody).review;
    expect(written).toMatchObject({
      rating: 4,
      author: { id: kadri.id, displayName: "Kadri" },
      dealId: deal.id,
      published: false,
    });

    const row = await prisma.review.findFirstOrThrow({
      where: { dealId: deal.id },
    });
    // The target is derived from the deal, never sent: a client that could
    // name it could name itself.
    expect(row).toMatchObject({ authorId: kadri.id, targetId: yuki.id });
  });

  it("ignores a target somebody tries to name in the body", async () => {
    const deal = await dealAt("COMPLETED");

    await request(app)
      .post(`/deals/${deal.id}/review`)
      .set("Cookie", kadri.cookie)
      .send({ rating: 5, targetId: kadri.id, authorId: yuki.id });

    const row = await prisma.review.findFirstOrThrow({
      where: { dealId: deal.id },
    });
    expect(row).toMatchObject({ authorId: kadri.id, targetId: yuki.id });
  });

  it("is open to both sides of the deal", async () => {
    const deal = await dealAt("COMPLETED");

    await reviewed(deal.id, kadri, { rating: 5 });
    await reviewed(deal.id, yuki, { rating: 3 });

    const rows = await prisma.review.findMany({ where: { dealId: deal.id } });
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => [r.authorId, r.targetId]).sort()).toEqual(
      [
        [kadri.id, yuki.id],
        [yuki.id, kadri.id],
      ].sort(),
    );
  });

  it("refuses a rating outside one to five", async () => {
    const deal = await dealAt("COMPLETED");

    for (const rating of [0, 6, 2.5, -1]) {
      expect((await review(deal.id, kadri, { rating })).status).toBe(422);
    }
    expect(await prisma.review.count()).toBe(0);
  });

  it(`refuses a comment longer than ${String(MAX_COMMENT_LENGTH)}`, async () => {
    const deal = await dealAt("COMPLETED");

    const tooLong = await review(deal.id, kadri, {
      rating: 5,
      comment: "x".repeat(MAX_COMMENT_LENGTH + 1),
    });
    expect(tooLong.status).toBe(422);

    // And the limit itself is fine, which is what makes the refusal mean
    // something.
    expect(
      (
        await review(deal.id, kadri, {
          rating: 5,
          comment: "x".repeat(MAX_COMMENT_LENGTH),
        })
      ).status,
    ).toBe(201);
  });

  it("takes no comment at all", async () => {
    const deal = await dealAt("COMPLETED");

    const written = await reviewed(deal.id, kadri, { rating: 5 });

    expect(written.comment).toBeNull();
  });

  it("refuses a second one from the same person", async () => {
    const deal = await dealAt("COMPLETED");
    await reviewed(deal.id, kadri);

    const second = await review(deal.id, kadri, { rating: 1 });

    expect(second.status).toBe(409);
    expect(await prisma.review.count()).toBe(1);
  });

  it("lets the DATABASE refuse the second one, not a look-first read", async () => {
    const deal = await dealAt("COMPLETED");

    const statements = await statementsDuring(async () => {
      await reviewed(deal.id, kadri);
    });

    // A check-then-write passes twice when two taps arrive together (#19).
    // The unique index on (dealId, authorId) is what actually holds, so the
    // INSERT must come before anything that reads Review — if the first
    // mention of the table is a SELECT, the rule is being enforced in
    // JavaScript and this test is why that is not good enough.
    const touchingReview = statements.filter((sql) => sql.includes('"Review"'));
    expect(touchingReview[0]).toMatch(/INSERT/i);
  });
});

describe("when a review may be written at all", () => {
  describe.each<DealStatus>([
    "MATCHED",
    "QUOTE_AGREED",
    "PRODUCT_PAID",
    "PURCHASED",
    "SHIPPED",
    "DELIVERED",
    "CANCELLED",
    "DISPUTED",
  ])("a %s deal", (status) => {
    it("cannot be reviewed", async () => {
      const deal = await dealAt(status);

      expect((await review(deal.id, kadri)).status).toBe(409);
      expect(await prisma.review.count()).toBe(0);
    });
  });

  it(`cannot be reviewed once ${String(REVIEW_WINDOW_DAYS)} days have passed`, async () => {
    const deal = await dealAt("COMPLETED", REVIEW_WINDOW_DAYS + 1);

    const refused = await review(deal.id, kadri, { rating: 1 });

    // THE REVENGE CASE. By the time anybody can read a review, nobody can
    // write one: otherwise the second person waits for the first to publish
    // itself, reads it, and answers with one star.
    expect(refused.status).toBe(409);
    expect(await prisma.review.count()).toBe(0);
  });

  it("can still be written on the last day of the window", async () => {
    const deal = await dealAt("COMPLETED", REVIEW_WINDOW_DAYS - 1);

    expect((await review(deal.id, kadri)).status).toBe(201);
  });

  it("is not something a stranger can do, or tell exists", async () => {
    const deal = await dealAt("COMPLETED");

    const refused = await review(deal.id, stranger);
    const missing = await review("cm0doesnotexist000000000", stranger);

    expect(refused.status).toBe(404);
    expect(withoutRequestId(refused.body)).toEqual(
      withoutRequestId(missing.body),
    );
  });

  it("is not something a moderator can do either", async () => {
    const mo = await signUpVerifiedAndLogIn(app, "mo@example.com", "Mo");
    await prisma.user.update({
      where: { id: mo.id },
      data: { role: "MODERATOR" },
    });
    const deal = await dealAt("COMPLETED");

    // 403 rather than 404, as for a receipt (#82): they can read this deal,
    // so refusing tells them nothing they did not already know. Reviewing is
    // for the two people who did the trade.
    expect((await review(deal.id, mo)).status).toBe(403);
    expect(await prisma.review.count()).toBe(0);
  });

  it("is not something to do signed out", async () => {
    const deal = await dealAt("COMPLETED");

    expect(
      (await request(app).post(`/deals/${deal.id}/review`).send({ rating: 5 }))
        .status,
    ).toBe(401);
  });
});

describe("the blind window", () => {
  it("hides a lone review from the other side, and shows it to its author", async () => {
    const deal = await dealAt("COMPLETED");
    const written = await reviewed(deal.id, kadri, { rating: 2 });

    // Its author sees it, and sees that nobody else does.
    expect(await reviewsOnDealAsSeenBy(deal.id, kadri)).toEqual([
      { ...written, published: false },
    ]);
    // The person it is about sees nothing at all — not a placeholder, not a
    // count, nothing that would tell them a bad review is waiting.
    expect(await reviewsOnDealAsSeenBy(deal.id, yuki)).toEqual([]);
    expect((await reviewsAbout(yuki.id)).items).toEqual([]);
  });

  it("publishes both the moment the second one lands", async () => {
    const deal = await dealAt("COMPLETED");
    await reviewed(deal.id, kadri, { rating: 2 });
    await reviewed(deal.id, yuki, { rating: 5 });

    for (const viewer of [kadri, yuki]) {
      const seen = await reviewsOnDealAsSeenBy(deal.id, viewer);
      expect(seen).toHaveLength(2);
      expect(seen.every((one) => one.published)).toBe(true);
    }

    expect((await reviewsAbout(yuki.id)).items).toHaveLength(1);
    expect((await reviewsAbout(kadri.id)).items).toHaveLength(1);
  });

  it("publishes a lone review once the window has closed", async () => {
    const deal = await dealAt("COMPLETED", REVIEW_WINDOW_DAYS + 1);
    // Written inside the window, back when the API would still accept it.
    const row = await reviewRow(deal, kadri, 2);

    const seen = await reviewsAbout(yuki.id);

    expect(seen.items.map((one) => one.id)).toEqual([row.id]);
    expect(seen.items[0]?.published).toBe(true);

    // This reads the public list, so it exercises the rule's QUERY form only.
    // A variant run proved the point by breaking the JavaScript form and
    // leaving this green — "the two spellings agree" at the bottom of the file
    // is what covers the other one, which is why that test exists.
  });

  it("keeps a lone review hidden until the very last day", async () => {
    const deal = await dealAt("COMPLETED", REVIEW_WINDOW_DAYS - 1);
    await reviewRow(deal, kadri, 2);

    expect((await reviewsAbout(yuki.id)).items).toEqual([]);
  });
});

describe("editing", () => {
  it("is allowed while nobody else can read it", async () => {
    const deal = await dealAt("COMPLETED");
    await reviewed(deal.id, kadri, { rating: 2, comment: "Written in temper" });

    const changed = await editReview(deal.id, kadri, {
      rating: 4,
      comment: "Slept on it",
    });

    expect(changed.status).toBe(200);
    expect((changed.body as ReviewBody).review).toMatchObject({
      rating: 4,
      comment: "Slept on it",
      published: false,
    });
    expect(await prisma.review.count()).toBe(1);
  });

  it("stops the moment the other side writes theirs", async () => {
    const deal = await dealAt("COMPLETED");
    await reviewed(deal.id, kadri, { rating: 2 });
    await reviewed(deal.id, yuki, { rating: 5 });

    const refused = await editReview(deal.id, kadri, { rating: 5 });

    // It is a public statement now, and somebody may have acted on it.
    expect(refused.status).toBe(409);
    expect(
      (await prisma.review.findFirstOrThrow({ where: { authorId: kadri.id } }))
        .rating,
    ).toBe(2);
  });

  it("stops when the window closes, even if nobody else wrote", async () => {
    const deal = await dealAt("COMPLETED", REVIEW_WINDOW_DAYS + 1);
    await reviewRow(deal, kadri, 2);

    expect((await editReview(deal.id, kadri, { rating: 5 })).status).toBe(409);

    // Which of the two rules refuses it: a variant run showed this case is
    // held by the DEADLINE check that every review request passes through,
    // not by the published check inside the edit. Both give the right answer
    // and the outer one gets there first. Said here so that nobody reads this
    // test as cover for the inner rule — "both sides have written" above is
    // what covers that.
  });

  it("is refused to somebody who has not written one", async () => {
    const deal = await dealAt("COMPLETED");
    await reviewed(deal.id, kadri);

    expect((await editReview(deal.id, yuki, { rating: 1 })).status).toBe(404);
  });

  it("obeys the same rules about what a review may say", async () => {
    const deal = await dealAt("COMPLETED");
    await reviewed(deal.id, kadri);

    expect((await editReview(deal.id, kadri, { rating: 9 })).status).toBe(422);
  });
});

describe("nothing deletes a review", () => {
  it("there is no endpoint for it, deliberately", async () => {
    const deal = await dealAt("COMPLETED");
    await reviewed(deal.id, kadri);

    const response = await request(app)
      .delete(`/deals/${deal.id}/review`)
      .set("Cookie", kadri.cookie);

    expect(response.status).toBe(404);
    expect(await prisma.review.count()).toBe(1);
  });
});

describe("reading what was said about somebody", () => {
  it("needs no session: a stranger is exactly who this is for", async () => {
    const deal = await dealAt("COMPLETED");
    await reviewed(deal.id, kadri, { rating: 5 });
    await reviewed(deal.id, yuki, { rating: 4 });

    const response = await request(app).get(`/users/${yuki.id}/reviews`);

    expect(response.status).toBe(200);
    expect((response.body as PageBody).items).toHaveLength(1);
  });

  it("is newest first, and pages like every other list", async () => {
    const written: string[] = [];
    for (let i = 0; i < 3; i++) {
      const deal = await dealAt("COMPLETED");
      written.push((await reviewed(deal.id, kadri, { rating: 5 })).id);
      await reviewed(deal.id, yuki, { rating: 5 });
    }

    const first = await reviewsAbout(yuki.id, "?limit=2");
    expect(first.items.map((one) => one.id)).toEqual(
      [...written].reverse().slice(0, 2),
    );
    expect(first.nextCursor).not.toBeNull();

    const second = await reviewsAbout(
      yuki.id,
      `?limit=2&cursor=${String(first.nextCursor)}`,
    );
    expect(second.items.map((one) => one.id)).toEqual([written[0]]);
    expect(second.nextCursor).toBeNull();
  });

  it("still reads correctly when its author has left", async () => {
    const deal = await dealAt("COMPLETED");
    await reviewed(deal.id, kadri, { rating: 5, comment: "All good" });
    await reviewed(deal.id, yuki, { rating: 5 });

    const deleted = await request(app)
      .delete("/me")
      .set("Cookie", kadri.cookie)
      .send({ password: PASSWORD });
    expect(deleted.status).toBe(204);

    // The review survives the author leaving (#66): what was said about Yuki
    // is about Yuki, and was true when it was written.
    const seen = await reviewsAbout(yuki.id);
    expect(seen.items).toHaveLength(1);
    expect(seen.items[0]).toMatchObject({
      comment: "All good",
      author: { displayName: DELETED_DISPLAY_NAME },
    });
  });

  it("says nothing at all about somebody nobody has reviewed", async () => {
    const seen = await reviewsAbout(stranger.id);

    // Empty, not an error and not a zero score: #84 decides what no reviews
    // looks like on a profile, and it is not "nought out of five".
    expect(seen).toEqual({ items: [], nextCursor: null });
  });
});

describe("the two spellings of the rule agree", () => {
  it("the deal's answer and the public list publish the same reviews", async () => {
    // Three deals, one in each state the rule can be in.
    const both = await dealAt("COMPLETED");
    await reviewed(both.id, kadri, { rating: 5 });
    await reviewed(both.id, yuki, { rating: 5 });

    const lonelyAndFresh = await dealAt("COMPLETED");
    await reviewed(lonelyAndFresh.id, kadri, { rating: 3 });

    const lonelyAndExpired = await dealAt("COMPLETED", REVIEW_WINDOW_DAYS + 1);
    const expired = await reviewRow(lonelyAndExpired, kadri, 1);

    // What the public list says is published, about Yuki.
    const published = new Set(
      (await reviewsAbout(yuki.id)).items.map((one) => one.id),
    );

    // What the per-review flag says, seen by the author of each.
    const flagged = new Set<string>();
    for (const deal of [both, lonelyAndFresh, lonelyAndExpired]) {
      for (const one of await reviewsOnDealAsSeenBy(deal.id, kadri)) {
        if (one.published && one.author.id === kadri.id) flagged.add(one.id);
      }
    }

    // One is a `where` in a query and the other is a function in JavaScript,
    // and #84 will average with the first while the API answers with the
    // second. Two spellings of one rule is how rules drift.
    expect([...flagged].sort()).toEqual([...published].sort());
    expect(published.has(expired.id)).toBe(true);
  });
});

describe("the database holds the rules too", () => {
  it("refuses a rating of six even when the API is bypassed", async () => {
    const deal = await dealAt("COMPLETED");

    // The CHECK constraint from the first week, proven rather than assumed —
    // the route's 422 above is a courtesy, this is the rule.
    await expect(
      prisma.review.create({
        data: {
          dealId: deal.id,
          authorId: kadri.id,
          targetId: yuki.id,
          rating: 6,
        },
      }),
    ).rejects.toThrow();
  });

  it("refuses a second review from one author even when the API is bypassed", async () => {
    const deal = await dealAt("COMPLETED");
    await reviewRow(deal, kadri);

    await expect(reviewRow(deal, kadri, 1)).rejects.toThrow();
  });
});
