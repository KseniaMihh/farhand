import type { Deal, Need } from "@prisma/client";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { prisma } from "../../src/db.js";
import { PASSWORD, signUpVerifiedAndLogIn } from "../helpers/auth.js";
import type { TestUser } from "../helpers/auth.js";
import { createCategory, createDealFor, needBody } from "../helpers/needs.js";
import { statementsDuring } from "../helpers/queries.js";
import { REVIEW_WINDOW_DAYS } from "../../src/services/reviews.js";

/**
 * The rating summary on a public profile (#84).
 *
 * `GET /users/:id` was documented as "public profile plus review summary" from
 * the start; #65 built the profile and deleted the promise, because there was
 * nothing to summarise. #83 and #125 made the reviews, and left behind the one
 * rule this has to use: `countedWhere`. Anything else here shows up as a
 * number that disagrees with the list of reviews underneath it.
 */

const app = createApp();

let kadri: TestUser; // requester, and the author of most reviews here
let yuki: TestUser; // helper, and the person being rated
let mo: TestUser;
let categoryId: string;

beforeEach(async () => {
  kadri = await signUpVerifiedAndLogIn(app, "kadri@example.com", "Kadri");
  yuki = await signUpVerifiedAndLogIn(app, "yuki@example.com", "Yuki");
  mo = await signUpVerifiedAndLogIn(app, "mo@example.com", "Mo");
  await prisma.user.update({
    where: { id: mo.id },
    data: { role: "MODERATOR" },
  });
  categoryId = (await createCategory()).id;
});

interface Summary {
  count: number;
  average: number | null;
}
interface ProfileBody {
  user: { id: string; displayName: string; reviews: Summary };
}
interface ListBody {
  items: { id: string; removed: boolean }[];
}

const DAY = 24 * 60 * 60 * 1000;

/** A completed deal between Kadri and Yuki, finished `daysAgo` days ago. */
async function completedDeal(daysAgo: number): Promise<Deal> {
  const created = await request(app)
    .post("/needs")
    .set("Cookie", kadri.cookie)
    .send(needBody(categoryId));
  expect(created.status).toBe(201);
  const need = (created.body as { need: Need }).need;

  const deal = await createDealFor(need, yuki.id, "COMPLETED");
  await prisma.dealEvent.create({
    data: {
      dealId: deal.id,
      actorId: kadri.id,
      fromStatus: "DELIVERED",
      toStatus: "COMPLETED",
      createdAt: new Date(Date.now() - daysAgo * DAY),
    },
  });

  return deal;
}

/** A published review of Yuki with this rating: window closed, so it counts. */
async function ratedYuki(rating: number) {
  const deal = await completedDeal(REVIEW_WINDOW_DAYS + 1);

  return prisma.review.create({
    data: {
      dealId: deal.id,
      authorId: kadri.id,
      targetId: yuki.id,
      rating,
      comment: `A ${String(rating)} star deal`,
    },
  });
}

/** The profile as a stranger sees it — no session at all. */
async function profileOf(userId: string): Promise<ProfileBody["user"]> {
  const response = await request(app).get(`/users/${userId}`);

  expect(response.status).toBe(200);
  return (response.body as ProfileBody).user;
}

async function reviewsListedAbout(userId: string) {
  const response = await request(app).get(`/users/${userId}/reviews`);

  expect(response.status).toBe(200);
  return (response.body as ListBody).items;
}

describe("a profile with no reviews", () => {
  it("says none, and does not say nought out of five", async () => {
    const profile = await profileOf(yuki.id);

    // "Nobody has reviewed them" and "everybody gave them nothing" are
    // different facts, and a profile that confuses them libels a newcomer.
    expect(profile.reviews).toEqual({ count: 0, average: null });
  });

  it("is the shape every profile has, present and explainable", async () => {
    const profile = await profileOf(yuki.id);

    // Present rather than absent: `count: 0` is what explains the null beside
    // it. The contract's old note — "absent rather than present and always
    // null" — was about a feature that did not exist yet, not about this.
    expect(profile).toHaveProperty("reviews");
  });
});

describe("the number and the average", () => {
  it("counts the reviews and averages the ratings", async () => {
    await ratedYuki(5);
    await ratedYuki(4);
    await ratedYuki(4);

    expect((await profileOf(yuki.id)).reviews).toEqual({
      count: 3,
      average: 4.3,
    });
  });

  it("rounds to one decimal, decided once rather than per client", async () => {
    await ratedYuki(5);
    await ratedYuki(4);

    expect((await profileOf(yuki.id)).reviews.average).toBe(4.5);

    await ratedYuki(1);
    // 10 / 3 = 3.333…
    expect((await profileOf(yuki.id)).reviews.average).toBe(3.3);
  });

  it("is about this person, and nobody else", async () => {
    await ratedYuki(1);
    // A review Yuki wrote about Kadri must not land on Yuki's own profile.
    const deal = await completedDeal(REVIEW_WINDOW_DAYS + 1);
    await prisma.review.create({
      data: {
        dealId: deal.id,
        authorId: yuki.id,
        targetId: kadri.id,
        rating: 5,
      },
    });

    expect((await profileOf(yuki.id)).reviews).toEqual({
      count: 1,
      average: 1,
    });
    expect((await profileOf(kadri.id)).reviews).toEqual({
      count: 1,
      average: 5,
    });
  });

  it("still counts a review whose author has since left", async () => {
    await ratedYuki(5);

    const deleted = await request(app)
      .delete("/me")
      .set("Cookie", kadri.cookie)
      .send({ password: PASSWORD });
    expect(deleted.status).toBe(204);

    // What was said about Yuki is about Yuki, and was true when it was
    // written (#66 keeps the review and blanks the profile).
    expect((await profileOf(yuki.id)).reviews).toEqual({
      count: 1,
      average: 5,
    });
  });
});

describe("it uses the rule the reviews use", () => {
  it("ignores a review still inside its blind window", async () => {
    const deal = await completedDeal(1);
    await prisma.review.create({
      data: {
        dealId: deal.id,
        authorId: kadri.id,
        targetId: yuki.id,
        rating: 1,
      },
    });

    // Nobody but its author can read it, so nothing on a public profile may
    // be computed from it (#83).
    expect((await profileOf(yuki.id)).reviews).toEqual({
      count: 0,
      average: null,
    });
  });

  it("counts it the moment the other side writes theirs", async () => {
    const deal = await completedDeal(1);
    await prisma.review.create({
      data: {
        dealId: deal.id,
        authorId: kadri.id,
        targetId: yuki.id,
        rating: 2,
      },
    });
    await prisma.review.create({
      data: {
        dealId: deal.id,
        authorId: yuki.id,
        targetId: kadri.id,
        rating: 5,
      },
    });

    expect((await profileOf(yuki.id)).reviews).toEqual({
      count: 1,
      average: 2,
    });
  });

  it("leaves out a review a moderator removed, while the list keeps it", async () => {
    await ratedYuki(5);
    const removed = await ratedYuki(1);

    expect(
      (
        await request(app)
          .post(`/admin/content/REVIEW/${removed.id}/remove`)
          .set("Cookie", mo.cookie)
          .send({ reason: "Harassment" })
      ).status,
    ).toBe(201);

    // The number says one, the list shows two, and the tombstone in the list
    // is what explains the difference (decision 0018).
    expect((await profileOf(yuki.id)).reviews).toEqual({
      count: 1,
      average: 5,
    });
    expect(await reviewsListedAbout(yuki.id)).toHaveLength(2);
  });

  it("counts exactly the reviews a reader can still read", async () => {
    await ratedYuki(5);
    await ratedYuki(3);
    const removed = await ratedYuki(1);
    await request(app)
      .post(`/admin/content/REVIEW/${removed.id}/remove`)
      .set("Cookie", mo.cookie)
      .send({ reason: "Harassment" });

    const summary = (await profileOf(yuki.id)).reviews;
    const readable = (await reviewsListedAbout(yuki.id)).filter(
      (one) => !one.removed,
    );

    // The invariant worth holding: the number beside the average is the
    // number of reviews the average is made of, and every one of them is
    // visible underneath it.
    expect(summary.count).toBe(readable.length);
  });
});

describe("what it costs", () => {
  it("is one statement, however many reviews there are", async () => {
    for (const rating of [5, 4, 3, 2, 1]) {
      await ratedYuki(rating);
    }

    const statements = await statementsDuring(async () => {
      expect((await profileOf(yuki.id)).reviews.count).toBe(5);
    });

    // Averaged by the database. Fetching every review to divide by its length
    // is the shape #102 measured, and is why the rule has a query form.
    const touchingReview = statements.filter(
      (sql) => sql.includes("SELECT") && sql.includes('"Review"'),
    );
    expect(touchingReview).toHaveLength(1);
  });
});
