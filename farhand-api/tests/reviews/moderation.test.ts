import type { Deal, Need, Review } from "@prisma/client";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { prisma } from "../../src/db.js";
import { REVIEW_WINDOW_DAYS } from "../../src/services/reviews.js";
import { signUpVerifiedAndLogIn } from "../helpers/auth.js";
import type { TestUser } from "../helpers/auth.js";
import { withoutRequestId } from "../helpers/http.js";
import { createCategory, createDealFor, needBody } from "../helpers/needs.js";

/**
 * Reporting and removing a review (#125).
 *
 * #83 made reviews public, permanent and attached to a named person, and left
 * them unreachable by both moderation tools: `ReportTarget` had no `REVIEW`,
 * and the takedown endpoint knew needs, offers and messages. This closes that.
 *
 * Two rules that sound like one, and are not:
 *
 *   SHOWN    a removed review keeps its place, saying what happened to it.
 *            The same argument the contract makes for a removed message: a
 *            hole that says "removed" is honest, one that closes up is not
 *   COUNTED  it counts for nothing. If a review was abusive enough to take
 *            down, its one star is part of the same abuse
 *
 * And the asymmetry that makes the row worth keeping at all: a moderator sees
 * what was actually said. Evidence nobody may read is not evidence.
 */

const app = createApp();

let kadri: TestUser; // requester, and the author of the reviews here
let yuki: TestUser; // helper, and the person they are about
let stranger: TestUser;
let mo: TestUser;
let categoryId: string;

beforeEach(async () => {
  kadri = await signUpVerifiedAndLogIn(app, "kadri@example.com", "Kadri");
  yuki = await signUpVerifiedAndLogIn(app, "yuki@example.com", "Yuki");
  stranger = await signUpVerifiedAndLogIn(app, "sam@example.com", "Sam");
  mo = await signUpVerifiedAndLogIn(app, "mo@example.com", "Mo");
  await prisma.user.update({
    where: { id: mo.id },
    data: { role: "MODERATOR" },
  });
  categoryId = (await createCategory()).id;
});

interface ReviewView {
  id: string;
  rating: number | null;
  comment: string | null;
  published: boolean;
  removed: boolean;
  author: { id: string; displayName: string };
}
interface PageBody {
  items: ReviewView[];
}
interface ReportBody {
  report: { id: string; targetType: string; targetId: string };
  target: {
    id: string;
    rating: number;
    comment: string | null;
    removedAt: string | null;
  } | null;
}

const DAY = 24 * 60 * 60 * 1000;
const ABUSIVE =
  "Everything about this person is a lie, and here is their address";

/** A completed deal between Kadri and Yuki, finished `daysAgo` days ago. */
async function completedDeal(daysAgo = 0): Promise<Deal> {
  const created = await request(app)
    .post("/needs")
    .set("Cookie", kadri.cookie)
    .send(await needBody(categoryId));
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

/**
 * A published review of Yuki, written by Kadri.
 *
 * Published because the window has closed — which is also the only state a
 * review can be reported in, since nobody but its author can see one before
 * that.
 */
async function publishedReview(comment = ABUSIVE): Promise<Review> {
  const deal = await completedDeal(REVIEW_WINDOW_DAYS + 1);

  return prisma.review.create({
    data: {
      dealId: deal.id,
      authorId: kadri.id,
      targetId: yuki.id,
      rating: 1,
      comment,
    },
  });
}

function report(targetId: string, reporter: TestUser) {
  return request(app)
    .post("/reports")
    .set("Cookie", reporter.cookie)
    .send({ targetType: "REVIEW", targetId, reason: "HARASSMENT" });
}

function remove(reviewId: string, user: TestUser, reason = "Harassment") {
  return request(app)
    .post(`/admin/content/REVIEW/${reviewId}/remove`)
    .set("Cookie", user.cookie)
    .send({ reason });
}

async function reviewsAbout(userId: string): Promise<ReviewView[]> {
  const response = await request(app).get(`/users/${userId}/reviews`);
  expect(response.status).toBe(200);
  return (response.body as PageBody).items;
}

describe("reporting one", () => {
  it("is something anybody who can read it may do", async () => {
    const review = await publishedReview();

    const response = await report(review.id, stranger);

    expect(response.status).toBe(201);
    const row = await prisma.report.findFirstOrThrow();
    expect(row).toMatchObject({
      targetType: "REVIEW",
      targetId: review.id,
      reporterId: stranger.id,
    });
  });

  it("is something its subject may do, which is the usual case", async () => {
    const review = await publishedReview();

    expect((await report(review.id, yuki)).status).toBe(201);
  });

  it("is not something its author may do about their own words", async () => {
    const review = await publishedReview();

    expect((await report(review.id, kadri)).status).toBe(403);
  });

  it("is not possible for a review nobody else can see yet", async () => {
    // Inside the blind window: Kadri's review is Kadri's alone, so to anybody
    // else it does not exist — and reporting it would be a way to find out
    // that it does.
    const deal = await completedDeal(1);
    const hidden = await prisma.review.create({
      data: {
        dealId: deal.id,
        authorId: kadri.id,
        targetId: yuki.id,
        rating: 1,
        comment: ABUSIVE,
      },
    });

    const refused = await report(hidden.id, yuki);
    const missing = await report("cm0doesnotexist000000000", yuki);

    expect(refused.status).toBe(404);
    expect(withoutRequestId(refused.body)).toEqual(
      withoutRequestId(missing.body),
    );
  });

  it("is not possible twice for the same review by the same person", async () => {
    const review = await publishedReview();
    expect((await report(review.id, yuki)).status).toBe(201);

    // The rule from #26: one OPEN report per person per target.
    expect((await report(review.id, yuki)).status).toBe(409);
  });
});

describe("removing one", () => {
  it("is a moderator's to do, and is recorded against its author", async () => {
    const review = await publishedReview();

    const response = await remove(review.id, mo);

    expect(response.status).toBe(201);
    expect(
      await prisma.review.findUniqueOrThrow({ where: { id: review.id } }),
    ).toMatchObject({ removedAt: expect.any(Date) as Date });

    const action = await prisma.adminAction.findFirstOrThrow();
    expect(action).toMatchObject({
      adminId: mo.id,
      type: "REMOVE_CONTENT",
      contentType: "REVIEW",
      contentId: review.id,
      // A takedown is about who wrote the thing, as it is for a message.
      targetUserId: kadri.id,
      reason: "Harassment",
    });
  });

  it("is refused to everybody else", async () => {
    const review = await publishedReview();

    for (const user of [kadri, yuki, stranger]) {
      expect((await remove(review.id, user)).status).toBe(403);
    }
    expect(
      (await prisma.review.findUniqueOrThrow({ where: { id: review.id } }))
        .removedAt,
    ).toBeNull();
  });

  it("cannot be done twice", async () => {
    const review = await publishedReview();
    expect((await remove(review.id, mo)).status).toBe(201);

    expect((await remove(review.id, mo)).status).toBe(409);
    expect(await prisma.adminAction.count()).toBe(1);
  });

  it("answers 404 for a review that does not exist", async () => {
    expect((await remove("cm0doesnotexist000000000", mo)).status).toBe(404);
  });
});

describe("what a removed review looks like", () => {
  it("keeps its place, and says what happened to it", async () => {
    const review = await publishedReview();
    expect((await remove(review.id, mo)).status).toBe(201);

    const [seen] = await reviewsAbout(yuki.id);

    // A hole that says "removed" is honest; one that closes up makes the list
    // read as though nothing was ever written (06-api-contract.md says the
    // same thing about a removed message).
    expect(seen).toMatchObject({
      id: review.id,
      removed: true,
      rating: null,
      comment: null,
    });
  });

  it("takes its words with it, everywhere", async () => {
    const review = await publishedReview();
    await remove(review.id, mo);

    const everywhere = JSON.stringify([
      await reviewsAbout(yuki.id),
      (
        await request(app)
          .get(`/deals/${review.dealId}`)
          .set("Cookie", yuki.cookie)
      ).body,
      (
        await request(app)
          .get(`/deals/${review.dealId}`)
          .set("Cookie", kadri.cookie)
      ).body,
    ]);

    // Including from its own author: they know what they wrote, and showing
    // it back to them would read as though it were still standing.
    expect(everywhere).not.toContain(ABUSIVE);
  });

  it("is still one of the deal's reviews, not a gap", async () => {
    const review = await publishedReview();
    await remove(review.id, mo);

    const response = await request(app)
      .get(`/deals/${review.dealId}`)
      .set("Cookie", yuki.cookie);

    const reviews = (response.body as { deal: { reviews: ReviewView[] } }).deal
      .reviews;
    expect(reviews.map((one) => one.id)).toEqual([review.id]);
    expect(reviews[0]).toMatchObject({ removed: true, rating: null });

    // The deal's answer goes through the JavaScript form of the rule, which is
    // why this test and the public-list ones catch different breakages — and
    // why a removal that filtered reviews out of `allOnDeal` is caught here
    // rather than by the test about the pair.
  });
});

describe("what a removed review counts for", () => {
  it("nothing, while the ones around it still count", async () => {
    const removed = await publishedReview();
    const kept = await publishedReview("Perfectly ordinary review");
    await prisma.review.update({ where: { id: kept.id }, data: { rating: 5 } });

    await remove(removed.id, mo);

    // #84 averages with `countedWhere`, which is `publishedWhere` and not
    // removed. The list below it shows two entries and the count says one:
    // the tombstone is what explains the difference.
    const counted = await prisma.review.count({
      where: await countedFor(yuki.id),
    });
    expect(counted).toBe(1);
    expect(await reviewsAbout(yuki.id)).toHaveLength(2);
  });

  it("and the rule that counts is not the rule that lists", async () => {
    const removed = await publishedReview();
    await remove(removed.id, mo);

    // Two rules, two answers, deliberately (#125). If these were one `where`,
    // removing a review would make it vanish — which is the behaviour this
    // issue decided against.
    expect(
      await prisma.review.count({ where: await countedFor(yuki.id) }),
    ).toBe(0);
    expect(await reviewsAbout(yuki.id)).toHaveLength(1);
  });
});

describe("the pair rule remembers what was written", () => {
  it("a removal does not unpublish the other side's review", async () => {
    // Both sides write inside the window, so both publish at once.
    const deal = await completedDeal(1);
    const kadrisReview = await prisma.review.create({
      data: {
        dealId: deal.id,
        authorId: kadri.id,
        targetId: yuki.id,
        rating: 1,
        comment: ABUSIVE,
      },
    });
    await prisma.review.create({
      data: {
        dealId: deal.id,
        authorId: yuki.id,
        targetId: kadri.id,
        rating: 5,
        comment: "No trouble at all",
      },
    });
    expect(await reviewsAbout(kadri.id)).toHaveLength(1);

    // Asserted, or this test passes while removal does nothing at all.
    expect((await remove(kadrisReview.id, mo)).status).toBe(201);

    // "Both sides have written" is a fact about the past and a takedown does
    // not unmake it. Otherwise this is a trick: write something abusive about
    // the person you expect to review you badly, get it removed, and their
    // honest review of you disappears until the deadline.
    //
    // This reads the public list, so it holds the rule's QUERY form. A variant
    // run proved the distinction matters: filtering removed reviews out of the
    // JavaScript form left this green and failed a different test instead.
    // Aimed at the query's pair clause, it is this one that goes red.
    expect(await reviewsAbout(kadri.id)).toHaveLength(1);
    expect((await reviewsAbout(kadri.id))[0]?.removed).toBe(false);
  });
});

describe("a moderator can read what was taken down", () => {
  it("sees the original words and stars in the report", async () => {
    const review = await publishedReview();
    expect((await report(review.id, yuki)).status).toBe(201);
    const reported = await prisma.report.findFirstOrThrow();

    await remove(review.id, mo);

    const response = await request(app)
      .get(`/admin/reports/${reported.id}`)
      .set("Cookie", mo.cookie);

    expect(response.status).toBe(200);
    const body = response.body as ReportBody;
    // The row is kept "as evidence" — and evidence the only permitted reader
    // cannot read is not evidence. This is the whole reason the admin view
    // has a mapping of its own rather than reusing the public one.
    expect(body.target).toMatchObject({
      id: review.id,
      rating: 1,
      comment: ABUSIVE,
    });
    expect(body.target?.removedAt).not.toBeNull();
  });

  it("sees it before it is removed too, which is how they decide", async () => {
    const review = await publishedReview();
    await report(review.id, yuki);
    const reported = await prisma.report.findFirstOrThrow();

    const response = await request(app)
      .get(`/admin/reports/${reported.id}`)
      .set("Cookie", mo.cookie);

    expect((response.body as ReportBody).target).toMatchObject({
      comment: ABUSIVE,
      removedAt: null,
    });
  });

  it("and nobody else can open that report", async () => {
    const review = await publishedReview();
    await report(review.id, yuki);
    const reported = await prisma.report.findFirstOrThrow();

    const response = await request(app)
      .get(`/admin/reports/${reported.id}`)
      .set("Cookie", yuki.cookie);

    expect(response.status).toBe(403);
  });
});

/**
 * `countedWhere` as the database sees it, without importing the service's
 * clock: the tests above only ever use deals whose window has closed.
 */
async function countedFor(targetId: string) {
  const { countedWhere } = await import("../../src/services/reviews.js");
  return countedWhere(targetId, new Date());
}
