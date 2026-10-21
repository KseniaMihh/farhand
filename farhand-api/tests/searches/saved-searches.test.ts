import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/app.js";
import { prisma } from "../../src/db.js";
import { mailer } from "../../src/mailer.js";
import { MAX_SAVED_SEARCHES } from "../../src/services/saved-searches.js";
import { signUpVerifiedAndLogIn } from "../helpers/auth.js";
import type { TestUser } from "../helpers/auth.js";
import { runQueuedJobs } from "../helpers/jobs.js";
import { createCategory, needBody } from "../helpers/needs.js";
import { currentProhibitedVersion } from "../helpers/prohibited.js";

/**
 * Saved searches — issue #90.
 *
 * These tests are the specification. They fail until the TODOs in
 * src/services/saved-searches.ts are filled in.
 *
 *   npm run test:watch -- saved-searches
 *
 * Three things are being specified, and they fail for different reasons:
 *
 *   SAVING     what a person may keep, how many, and whose it is
 *   MATCHING   which listings a standing query catches, and which it does not
 *   TELLING    that a match emails ONCE, through the queue, to somebody who
 *              asked for it — the one exception decision 0020's rule allows
 *
 * Everything here goes through #85's queue. `runQueuedJobs()` stands in for
 * the two seconds before the worker picks the work up: once for the matching
 * job the publish enqueued, and again for the notification jobs the matching
 * enqueued. Two drains, and the second is easy to forget.
 */
const app = createApp();

let categoryId = "";
let otherCategoryId = "";
let kadri: TestUser; // posts needs
let yuki: TestUser; // offers help, and waits for sunscreen to appear
let sam: TestUser; // another waiting person

beforeEach(async () => {
  categoryId = (await createCategory()).id;
  otherCategoryId = (await createCategory("cosmetics")).id;
  kadri = await signUpVerifiedAndLogIn(app, "kadri@example.com", "Kadri");
  yuki = await signUpVerifiedAndLogIn(app, "yuki@example.com", "Yuki");
  sam = await signUpVerifiedAndLogIn(app, "sam@example.com", "Sam");
  // Registration queues a verification email. Clear it, or every count here
  // is one too many (tests/notifications/notifications.test.ts).
  await prisma.job.deleteMany({});
  await prisma.notification.deleteMany({});
});

/** The fake provider: what would have been emailed, to whom. */
function watchTheMail() {
  return vi.spyOn(mailer, "sendNotificationEmail").mockResolvedValue();
}

/** The publish, then the match, then the emails. */
async function runEverythingQueued(): Promise<void> {
  await runQueuedJobs();
  await runQueuedJobs();
}

function save(user: TestUser, body: Record<string, unknown>) {
  return request(app)
    .post("/me/searches")
    .set("Cookie", user.cookie)
    .send(body);
}

function listSaved(user: TestUser) {
  return request(app).get("/me/searches").set("Cookie", user.cookie);
}

interface SearchBody {
  search: {
    id: string;
    kind: string;
    name: string;
    notify: boolean;
    filters: Record<string, string>;
    createdAt: string;
  };
}

/** A need search for Japanese sunscreen coming to Estonia. */
function sunscreenSearch(overrides: Record<string, unknown> = {}) {
  return {
    kind: "NEED",
    name: "Sunscreen to Estonia",
    filters: { buyCountry: "JP", deliverCountry: "EE", q: "sunscreen" },
    ...overrides,
  };
}

/** Kadri posts a need, publicly. */
async function postNeed(overrides: Record<string, unknown> = {}) {
  const response = await request(app)
    .post("/needs")
    .set("Cookie", kadri.cookie)
    .send(await needBody(categoryId, overrides));
  expect(response.status).toBe(201);

  return (response.body as { need: { id: string; title: string } }).need;
}

describe("saving a search", () => {
  it("keeps the filters of the browse endpoint, in its own words", async () => {
    const response = await save(yuki, sunscreenSearch());
    const body = response.body as SearchBody;

    // What you POST is what you GET: a client can save the query string it
    // is already running and send it back unchanged (#16's filters).
    expect(response.status).toBe(201);
    expect(body.search).toMatchObject({
      kind: "NEED",
      name: "Sunscreen to Estonia",
      notify: true,
      filters: { buyCountry: "JP", deliverCountry: "EE", q: "sunscreen" },
    });
    expect(body.search.filters).not.toHaveProperty("country");
  });

  it("keeps an offers search in the offers list's words", async () => {
    const response = await save(yuki, {
      kind: "HELP",
      name: "Anybody in Japan",
      filters: { country: "JP", shipsTo: "EE", categoryId },
    });

    expect(response.status).toBe(201);
    expect((response.body as SearchBody).search.filters).toEqual({
      country: "JP",
      shipsTo: "EE",
      categoryId,
    });
  });

  /**
   * The promise in the issue is "the filters from the browse endpoints", and
   * a filter that endpoint does not have is a filter nothing would ever
   * apply. Silently dropping it would be worse than refusing: the person
   * would be waiting for a search that is narrower in their head than in the
   * database.
   */
  it("refuses a filter the list it stands over does not have", async () => {
    expect(
      (await save(yuki, sunscreenSearch({ filters: { country: "JP" } })))
        .status,
    ).toBe(422);
    expect(
      (
        await save(yuki, {
          kind: "HELP",
          name: "Words in an offer",
          filters: { q: "sunscreen" },
        })
      ).status,
    ).toBe(422);
  });

  it("allows a search with no filters at all", async () => {
    const response = await save(yuki, {
      kind: "NEED",
      name: "Anything new",
      filters: {},
    });

    // "Tell me about everything" is a thing somebody may want on a small
    // marketplace, and the per-account limit is what stops it being a
    // hundred standing queries. Null in every column means any.
    expect(response.status).toBe(201);
    expect((response.body as SearchBody).search.filters).toEqual({});
  });

  it("refuses an unknown category", async () => {
    const response = await save(
      yuki,
      sunscreenSearch({ filters: { categoryId: "cm0nope00000000000000" } }),
    );

    expect(response.status).toBe(400);
  });

  it("stops at the limit, naming it", async () => {
    for (let n = 0; n < MAX_SAVED_SEARCHES; n += 1) {
      expect(
        (await save(yuki, sunscreenSearch({ name: `Search ${String(n)}` })))
          .status,
      ).toBe(201);
    }

    const tooMany = await save(yuki, sunscreenSearch({ name: "One more" }));

    // The same refusal as the open-needs limit (#15): a 409 that says what
    // to do about it, not a 422 about the shape of the request.
    expect(tooMany.status).toBe(409);
    expect(
      (tooMany.body as { error: { message: string } }).error.message,
    ).toContain(String(MAX_SAVED_SEARCHES));
    expect(await prisma.savedSearch.count({ where: { userId: yuki.id } })).toBe(
      MAX_SAVED_SEARCHES,
    );
  });

  it("counts the limit per account, not across everybody", async () => {
    for (let n = 0; n < MAX_SAVED_SEARCHES; n += 1) {
      await save(yuki, sunscreenSearch({ name: `Search ${String(n)}` }));
    }

    expect((await save(sam, sunscreenSearch())).status).toBe(201);
  });

  it("is refused to somebody who has not verified their address", async () => {
    await prisma.user.update({
      where: { id: yuki.id },
      data: { emailVerifiedAt: null },
    });

    // The thing a saved search does is send email, and an unverified address
    // is one nobody has proved they own (#12).
    expect((await save(yuki, sunscreenSearch())).status).toBe(403);
  });

  it("is refused to a caller with no session", async () => {
    expect(
      (await request(app).post("/me/searches").send(sunscreenSearch())).status,
    ).toBe(401);
  });
});

describe("the searches somebody has", () => {
  it("lists their own, newest first, and nobody else's", async () => {
    await save(yuki, sunscreenSearch({ name: "First" }));
    await save(yuki, sunscreenSearch({ name: "Second" }));
    await save(sam, sunscreenSearch({ name: "Sam's" }));

    const response = await listSaved(yuki);
    const items = (response.body as { items: { name: string }[] }).items;

    expect(response.status).toBe(200);
    expect(items.map((item) => item.name)).toEqual(["Second", "First"]);
  });

  it("deletes one of their own", async () => {
    const saved = (await save(yuki, sunscreenSearch())).body as SearchBody;

    const response = await request(app)
      .delete(`/me/searches/${saved.search.id}`)
      .set("Cookie", yuki.cookie);

    expect(response.status).toBe(204);
    expect((await listSaved(yuki)).body).toEqual({ items: [] });
  });

  it("answers 404 for somebody else's, and leaves it alone", async () => {
    const saved = (await save(yuki, sunscreenSearch())).body as SearchBody;

    const response = await request(app)
      .delete(`/me/searches/${saved.search.id}`)
      .set("Cookie", sam.cookie);

    // 404 rather than 403, the rule #79 set for files: a row you may not
    // read is one you may not know exists.
    expect(response.status).toBe(404);
    expect(await prisma.savedSearch.count({ where: { userId: yuki.id } })).toBe(
      1,
    );
  });

  it("answers 404 for an id that never existed", async () => {
    const response = await request(app)
      .delete("/me/searches/cm0nope00000000000000")
      .set("Cookie", yuki.cookie);

    expect(response.status).toBe(404);
  });

  /** #66, and the acceptance criterion that says so. */
  it("goes when the account does", async () => {
    await save(yuki, sunscreenSearch());

    await request(app)
      .delete("/me")
      .set("Cookie", yuki.cookie)
      .send({ password: "a decent long passphrase" });

    expect(await prisma.savedSearch.count({ where: { userId: yuki.id } })).toBe(
      0,
    );
  });
});

describe("a listing that matches", () => {
  it("emails the person waiting for it, once", async () => {
    await save(yuki, sunscreenSearch());
    const sent = watchTheMail();

    const need = await postNeed();
    await runEverythingQueued();

    expect(sent).toHaveBeenCalledTimes(1);
    const [to, subject] = sent.mock.calls[0] ?? [];
    expect(to).toBe(yuki.email);
    expect(subject).toContain(need.title);

    const rows = await prisma.notification.findMany({
      where: { userId: yuki.id },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "saved-search-match",
      subjectType: "need",
      subjectId: need.id,
    });
    expect(rows[0]?.sentAt).not.toBeNull();
  });

  it("emails once however many of that person's searches match it", async () => {
    await save(yuki, sunscreenSearch({ name: "By country" }));
    await save(yuki, { kind: "NEED", name: "Everything", filters: {} });
    const sent = watchTheMail();

    await postNeed();
    await runEverythingQueued();

    // Two searches, one listing, one email: the unique index on
    // (userId, kind, subjectId) decides it, the same one that stops a deal
    // sending two (#86).
    expect(sent).toHaveBeenCalledTimes(1);
  });

  it("tells everybody whose search matches", async () => {
    await save(yuki, sunscreenSearch());
    await save(sam, {
      kind: "NEED",
      name: "Anything from Japan",
      filters: { buyCountry: "JP" },
    });
    const sent = watchTheMail();

    await postNeed();
    await runEverythingQueued();

    expect(sent.mock.calls.map((call) => call[0]).sort()).toEqual(
      [sam.email, yuki.email].sort(),
    );
  });

  it("does not tell somebody about their own listing", async () => {
    await save(kadri, sunscreenSearch());
    const sent = watchTheMail();

    await postNeed();
    await runEverythingQueued();

    // Nobody needs an email about the thing they have just posted — 0020's
    // "anything you did yourself", which half the deal table is silent for.
    expect(sent).not.toHaveBeenCalled();
  });

  it("sends nothing when the search asked not to be told", async () => {
    await save(yuki, sunscreenSearch({ notify: false }));
    const sent = watchTheMail();

    await postNeed();
    await runEverythingQueued();

    // The search still exists and still describes what they are looking for.
    // The switch is per search, because somebody may want ten standing
    // queries and email about one of them.
    expect(sent).not.toHaveBeenCalled();
    expect(
      await prisma.notification.count({ where: { userId: yuki.id } }),
    ).toBe(0);
  });

  it("obeys the account-wide switch too", async () => {
    await save(yuki, sunscreenSearch());
    await request(app)
      .patch("/me/notifications")
      .set("Cookie", yuki.cookie)
      .send({ emailNotifications: false });
    const sent = watchTheMail();

    await postNeed();
    await runEverythingQueued();

    // #86's one switch still wins: a saved search is an exception to what is
    // worth an email, not an exception to being able to stop it.
    expect(sent).not.toHaveBeenCalled();
  });
});

describe("a listing that does not match", () => {
  async function savedThenPosted(
    filters: Record<string, unknown>,
    overrides: Record<string, unknown> = {},
  ) {
    await save(yuki, sunscreenSearch({ filters }));
    const sent = watchTheMail();

    await postNeed(overrides);
    await runEverythingQueued();

    return sent;
  }

  it("is silent when a country is wrong", async () => {
    expect(await savedThenPosted({ buyCountry: "KR" })).not.toHaveBeenCalled();
  });

  it("is silent when the destination is wrong", async () => {
    expect(
      await savedThenPosted({ deliverCountry: "FI" }),
    ).not.toHaveBeenCalled();
  });

  it("is silent when the category is wrong", async () => {
    expect(
      await savedThenPosted({ categoryId: otherCategoryId }),
    ).not.toHaveBeenCalled();
  });

  it("is silent when the words are not in it", async () => {
    expect(await savedThenPosted({ q: "headphones" })).not.toHaveBeenCalled();
  });

  it("matches the words without caring about case, in title or description", async () => {
    await save(yuki, sunscreenSearch({ filters: { q: "SUNSCREEN" } }));
    await save(sam, sunscreenSearch({ filters: { q: "biore" } }));
    const sent = watchTheMail();

    await postNeed();
    await runEverythingQueued();

    // The same comparison GET /needs makes, from the other side: `contains`,
    // insensitive, over the title and the description (#16).
    expect(sent.mock.calls.map((call) => call[0]).sort()).toEqual(
      [sam.email, yuki.email].sort(),
    );
  });

  it("says nothing about a draft", async () => {
    await save(yuki, sunscreenSearch());
    const sent = watchTheMail();

    const draft = await request(app)
      .post("/needs")
      .set("Cookie", kadri.cookie)
      .send(await needBody(categoryId, { status: "DRAFT" }));
    expect(draft.status).toBe(201);
    await runEverythingQueued();

    // Nobody can see a draft, so there is nothing to be told about.
    expect(sent).not.toHaveBeenCalled();
  });

  it("tells them when that draft is published", async () => {
    await save(yuki, sunscreenSearch());
    const draft = await request(app)
      .post("/needs")
      .set("Cookie", kadri.cookie)
      .send(await needBody(categoryId, { status: "DRAFT" }));
    const draftId = (draft.body as { need: { id: string } }).need.id;
    const sent = watchTheMail();

    const published = await request(app)
      .patch(`/needs/${draftId}`)
      .set("Cookie", kadri.cookie)
      .send({
        status: "OPEN",
        prohibitedVersion: await currentProhibitedVersion(),
      });
    expect(published.status).toBe(200);
    await runEverythingQueued();

    // The match runs where the tick is asked for (#87): the moment a listing
    // becomes public, whichever way it got there.
    expect(sent).toHaveBeenCalledTimes(1);
  });

  it("says nothing about an offer to a need search, or the other way about", async () => {
    await save(yuki, {
      kind: "HELP",
      name: "Offers",
      filters: { country: "JP" },
    });
    const sent = watchTheMail();

    await postNeed();
    await runEverythingQueued();

    expect(sent).not.toHaveBeenCalled();
  });

  it("is silent when the need is closed before the worker runs", async () => {
    await save(yuki, sunscreenSearch());
    const sent = watchTheMail();

    const need = await postNeed();
    await prisma.need.update({
      where: { id: need.id },
      data: { status: "CLOSED" },
    });
    await runEverythingQueued();

    // The email is composed from the rows as they are NOW (#86). A listing
    // that is no longer public is nothing to tell anybody about.
    expect(sent).not.toHaveBeenCalled();
  });
});

describe("an offer that matches", () => {
  async function postHelp(overrides: Record<string, unknown> = {}) {
    const response = await request(app)
      .post("/helps")
      .set("Cookie", yuki.cookie)
      .send({
        country: "JP",
        shipsTo: ["EE", "FI"],
        description:
          "I live in Tokyo and post to the Baltics every other week.",
        categoryIds: [categoryId],
        prohibitedVersion: await currentProhibitedVersion(),
        ...overrides,
      });
    expect(response.status).toBe(201);

    return (response.body as { help: { id: string } }).help;
  }

  it("emails the person waiting for somebody in that country", async () => {
    await save(kadri, {
      kind: "HELP",
      name: "Anybody in Japan",
      filters: { country: "JP", shipsTo: "EE", categoryId },
    });
    const sent = watchTheMail();

    const help = await postHelp();
    await runEverythingQueued();

    expect(sent).toHaveBeenCalledTimes(1);
    expect(
      await prisma.notification.findFirst({ where: { userId: kadri.id } }),
    ).toMatchObject({ subjectType: "help", subjectId: help.id });
  });

  it("counts an offer that ships anywhere as shipping there", async () => {
    await save(kadri, {
      kind: "HELP",
      name: "To Estonia",
      filters: { shipsTo: "EE" },
    });
    const sent = watchTheMail();

    await postHelp({ shipsTo: [] });
    await runEverythingQueued();

    // The same rule GET /helps uses: an empty list means no restriction, so
    // it ships there too (#18).
    expect(sent).toHaveBeenCalledTimes(1);
  });

  it("is silent when the offer does not ship there", async () => {
    await save(kadri, {
      kind: "HELP",
      name: "To Latvia",
      filters: { shipsTo: "LV" },
    });
    const sent = watchTheMail();

    await postHelp();
    await runEverythingQueued();

    expect(sent).not.toHaveBeenCalled();
  });

  it("tells them when a paused offer is reactivated", async () => {
    await save(kadri, {
      kind: "HELP",
      name: "Anybody in Japan",
      filters: { country: "JP" },
    });
    const paused = await postHelp({ status: "PAUSED" });
    const sent = watchTheMail();

    const live = await request(app)
      .patch(`/helps/${paused.id}`)
      .set("Cookie", yuki.cookie)
      .send({
        status: "ACTIVE",
        prohibitedVersion: await currentProhibitedVersion(),
      });
    expect(live.status).toBe(200);
    await runEverythingQueued();

    // The `PAUSED` twin of publishing a draft (#87), and the same event.
    expect(sent).toHaveBeenCalledTimes(1);
  });
});

describe("how the matching runs", () => {
  it("never happens inside the request that published", async () => {
    await save(yuki, sunscreenSearch());
    const sent = watchTheMail();

    await postNeed();

    // The publish answers 201 having written one row on the queue and
    // nothing else: no notification, no email, no scan of everybody's
    // standing queries inside somebody's POST (#85).
    expect(sent).not.toHaveBeenCalled();
    expect(await prisma.notification.count()).toBe(0);
    expect(await prisma.job.findMany()).toMatchObject([
      { kind: "search-match" },
    ]);
  });

  it("writes nothing twice when the matching job runs again", async () => {
    await save(yuki, sunscreenSearch());
    const sent = watchTheMail();

    const need = await postNeed();
    await runEverythingQueued();

    // At-least-once, by construction (#85): a crash after the work is done
    // leaves the row to be claimed again, so running it twice must be the
    // same as running it once.
    const { matchListing } =
      await import("../../src/services/saved-searches.js");
    await matchListing("NEED", need.id);
    await runQueuedJobs();

    expect(sent).toHaveBeenCalledTimes(1);
    expect(
      await prisma.notification.count({ where: { userId: yuki.id } }),
    ).toBe(1);
  });

  it("is not a reason for the publish to fail", async () => {
    await save(yuki, sunscreenSearch());
    const sent = watchTheMail();
    sent.mockRejectedValueOnce(
      new Error("the provider is having a bad minute"),
    );

    const need = await postNeed();
    await runEverythingQueued();

    // The need exists and is public whatever the email did; the job carries
    // the retrying (#85), and the listing is not held hostage to it.
    expect(
      await prisma.need.findUniqueOrThrow({ where: { id: need.id } }),
    ).toMatchObject({ status: "OPEN" });
  });
});
