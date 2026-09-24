import type { Need } from "@prisma/client";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { prisma } from "../../src/db.js";
import { signUpVerifiedAndLogIn } from "../helpers/auth.js";
import type { TestUser } from "../helpers/auth.js";
import { createCategory } from "../helpers/needs.js";

/**
 * Conversations and messages — issue #21.
 *
 * These tests are the specification. They fail until the TODOs in
 * src/services/conversations.ts are filled in.
 *
 *   npm run test:watch -- conversations
 *
 * Kadri asked for something, Yuki offered to get it, and now they have
 * questions for each other. Marek is a third party, and Mo is a moderator.
 */
const app = createApp();

let categoryId = "";
let kadri: TestUser;
let yuki: TestUser;
let marek: TestUser;

beforeEach(async () => {
  categoryId = (await createCategory()).id;
  kadri = await signUpVerifiedAndLogIn(app, "kadri@example.com", "Kadri");
  yuki = await signUpVerifiedAndLogIn(app, "yuki@example.com", "Yuki");
  marek = await signUpVerifiedAndLogIn(app, "marek@example.com", "Marek");
});

async function makeModerator() {
  const mo = await signUpVerifiedAndLogIn(app, "mo@example.com", "Mo");
  await prisma.user.update({
    where: { id: mo.id },
    data: { role: "MODERATOR" },
  });
  return mo;
}

async function makeNeed(overrides: Partial<Need> = {}) {
  return prisma.need.create({
    data: {
      requesterId: kadri.id,
      categoryId,
      title: "Japanese sunscreen",
      description: "The one not sold in Europe",
      buyCountry: "JP",
      deliverCountry: "EE",
      currency: "EUR",
      estimatedPrice: 2400,
      status: "OPEN",
      ...overrides,
    },
  });
}

/** Kadri's need, Yuki's proposal on it, and no conversation yet. */
async function proposal() {
  const need = await makeNeed();
  await request(app)
    .post(`/needs/${need.id}/proposals`)
    .set("Cookie", yuki.cookie)
    .send({});

  return prisma.proposal.findFirstOrThrow();
}

function send(user: TestUser, proposalId: string, body: string) {
  return request(app)
    .post(`/proposals/${proposalId}/messages`)
    .set("Cookie", user.cookie)
    .send({ body });
}

function readThread(user: TestUser, conversationId: string, query = {}) {
  return request(app)
    .get(`/conversations/${conversationId}/messages`)
    .query(query)
    .set("Cookie", user.cookie);
}

function inbox(user: TestUser, query = {}) {
  return request(app)
    .get("/conversations")
    .query(query)
    .set("Cookie", user.cookie);
}

/** A thread with `count` messages, alternating between the two of them. */
async function thread(count: number) {
  const theProposal = await proposal();
  for (let i = 0; i < count; i++) {
    await send(
      i % 2 === 0 ? yuki : kadri,
      theProposal.id,
      `message ${String(i)}`,
    );
  }
  const conversation = await prisma.conversation.findFirstOrThrow();

  return { proposal: theProposal, conversation };
}

interface MessageBody {
  message: {
    id: string;
    conversationId: string;
    senderId: string | null;
    body: string | null;
    createdAt: string;
  };
}

interface MessagePage {
  items: { id: string; body: string | null; senderId: string | null }[];
  nextCursor: string | null;
}

interface InboxPage {
  items: {
    id: string;
    lastMessageAt: string | null;
    unreadCount: number;
    proposal: { id: string; need: { title: string } };
  }[];
  nextCursor: string | null;
}

describe("POST /proposals/:id/messages", () => {
  it("opens the thread with the first message", async () => {
    const theProposal = await proposal();

    const response = await send(yuki, theProposal.id, "What size do you want?");
    const body = response.body as MessageBody;

    expect(response.status).toBe(201);
    expect(body.message.body).toBe("What size do you want?");
    expect(body.message.senderId).toBe(yuki.id);

    const conversation = await prisma.conversation.findFirstOrThrow();
    expect(conversation.proposalId).toBe(theProposal.id);
    expect(body.message.conversationId).toBe(conversation.id);
  });

  it("reuses the thread for the second message", async () => {
    const theProposal = await proposal();

    await send(yuki, theProposal.id, "What size?");
    await send(kadri, theProposal.id, "The 50ml one, please.");

    // One thread per proposal, whoever writes and however often.
    expect(await prisma.conversation.count()).toBe(1);
    expect(await prisma.message.count()).toBe(2);
  });

  it("moves the thread to the top of the inbox", async () => {
    const theProposal = await proposal();

    await send(yuki, theProposal.id, "Still interested?");

    const conversation = await prisma.conversation.findFirstOrThrow();
    const message = await prisma.message.findFirstOrThrow();
    // The inbox is ordered by lastMessageAt, so a stale one sorts wrongly and
    // nothing ever errors to say so.
    expect(conversation.lastMessageAt?.toISOString()).toBe(
      message.createdAt.toISOString(),
    );
  });

  it("refuses everyone but the two of them", async () => {
    const theProposal = await proposal();
    const mo = await makeModerator();

    expect((await send(marek, theProposal.id, "hello?")).status).toBe(403);
    // Moderators read conversations; they do not join them.
    expect((await send(mo, theProposal.id, "hello?")).status).toBe(403);
    expect(await prisma.conversation.count()).toBe(0);
  });

  it("still allows a word after the proposal is declined", async () => {
    const theProposal = await proposal();
    await request(app)
      .post(`/proposals/${theProposal.id}/decline`)
      .set("Cookie", kadri.cookie)
      .send({});

    const response = await send(yuki, theProposal.id, "No problem, good luck!");

    // Nothing in the issue asks for talking to stop, and cutting people off
    // mid-sentence would be a rule nobody wrote down.
    expect(response.status).toBe(201);
  });

  it("answers 404 for a proposal that does not exist", async () => {
    const response = await send(yuki, "no-such-proposal", "hello?");

    expect(response.status).toBe(404);
  });

  it("refuses an empty message and one over 4000 characters", async () => {
    const theProposal = await proposal();

    expect((await send(yuki, theProposal.id, "   ")).status).toBe(422);
    expect((await send(yuki, theProposal.id, "x".repeat(4001))).status).toBe(
      422,
    );
    expect((await send(yuki, theProposal.id, "x".repeat(4000))).status).toBe(
      201,
    );
  });

  it("turns away someone not signed in", async () => {
    const theProposal = await proposal();

    const response = await request(app)
      .post(`/proposals/${theProposal.id}/messages`)
      .send({ body: "hello?" });

    expect(response.status).toBe(401);
  });
});

describe("GET /conversations/:id/messages", () => {
  it("lets both of them read it", async () => {
    const { conversation } = await thread(2);

    const asHelper = await readThread(yuki, conversation.id);
    const asRequester = await readThread(kadri, conversation.id);

    expect(asHelper.status).toBe(200);
    expect((asHelper.body as MessagePage).items).toHaveLength(2);
    expect(asRequester.status).toBe(200);
  });

  it("lets a moderator read it", async () => {
    const { conversation } = await thread(2);
    const mo = await makeModerator();

    const response = await readThread(mo, conversation.id);

    // Judging a report means reading what was said.
    expect(response.status).toBe(200);
    expect((response.body as MessagePage).items).toHaveLength(2);
  });

  it("hides it from everyone else, as if it did not exist", async () => {
    const { conversation } = await thread(2);

    const response = await readThread(marek, conversation.id);

    // 404 and not 403: a thread you may not read is one you have no business
    // knowing exists.
    expect(response.status).toBe(404);
  });

  it("answers 404 for a thread that does not exist", async () => {
    const response = await readThread(kadri, "no-such-conversation");

    expect(response.status).toBe(404);
  });

  it("reads oldest to newest within the page", async () => {
    const { conversation } = await thread(3);

    const response = await readThread(yuki, conversation.id);
    const items = (response.body as MessagePage).items;

    expect(items.map((item) => item.body)).toEqual([
      "message 0",
      "message 1",
      "message 2",
    ]);
  });

  it("starts at the newest page and walks backwards", async () => {
    const { conversation } = await thread(5);

    const first = await readThread(yuki, conversation.id, { limit: 2 });
    const firstBody = first.body as MessagePage;
    const second = await readThread(yuki, conversation.id, {
      limit: 2,
      cursor: firstBody.nextCursor ?? "",
    });
    const secondBody = second.body as MessagePage;
    const third = await readThread(yuki, conversation.id, {
      limit: 2,
      cursor: secondBody.nextCursor ?? "",
    });
    const thirdBody = third.body as MessagePage;

    // Open a thread and you see the end of it, like any chat window — then
    // page back through what came before, each page read forwards.
    expect(firstBody.items.map((item) => item.body)).toEqual([
      "message 3",
      "message 4",
    ]);
    expect(secondBody.items.map((item) => item.body)).toEqual([
      "message 1",
      "message 2",
    ]);
    expect(thirdBody.items.map((item) => item.body)).toEqual(["message 0"]);
    expect(thirdBody.nextCursor).toBeNull();
  });

  it("keeps a removed message in place, without its words", async () => {
    const { conversation } = await thread(2);
    const first = await prisma.message.findFirstOrThrow({
      orderBy: { createdAt: "asc" },
    });
    await prisma.message.update({
      where: { id: first.id },
      data: { removedAt: new Date() },
    });

    const response = await readThread(kadri, conversation.id);
    const items = (response.body as MessagePage).items;

    // The row stays as evidence, and the hole is honest: a message that
    // silently vanishes makes the thread read as if it was never sent.
    expect(items).toHaveLength(2);
    expect(items[0]?.body).toBeNull();
    expect(items[1]?.body).toBe("message 1");
  });
});

describe("GET /conversations — the inbox", () => {
  it("shows the threads I am in, and nobody else's", async () => {
    const { conversation } = await thread(1);

    const mine = await inbox(kadri);
    const theirs = await inbox(marek);

    const items = (mine.body as InboxPage).items;
    expect(items).toHaveLength(1);
    expect(items[0]?.id).toBe(conversation.id);
    expect(items[0]?.proposal.need.title).toBe("Japanese sunscreen");
    expect((theirs.body as InboxPage).items).toHaveLength(0);
  });

  it("counts what the other person said since I last read", async () => {
    const { conversation } = await thread(3); // yuki, kadri, yuki

    const before = await inbox(kadri);
    await request(app)
      .post(`/conversations/${conversation.id}/read`)
      .set("Cookie", kadri.cookie)
      .send({});
    await send(yuki, (await prisma.proposal.findFirstOrThrow()).id, "one more");
    const after = await inbox(kadri);

    // Two from Yuki before she read, then one after. Her own never count.
    expect((before.body as InboxPage).items[0]?.unreadCount).toBe(2);
    expect((after.body as InboxPage).items[0]?.unreadCount).toBe(1);
  });

  it("puts the most recently spoken-in thread first", async () => {
    const older = await thread(1);
    const newerNeed = await makeNeed({ title: "Korean toner" });
    await request(app)
      .post(`/needs/${newerNeed.id}/proposals`)
      .set("Cookie", marek.cookie)
      .send({});
    const newerProposal = await prisma.proposal.findFirstOrThrow({
      where: { needId: newerNeed.id },
    });
    await send(marek, newerProposal.id, "I can get that");

    const first = await inbox(kadri);
    await send(yuki, older.proposal.id, "any news?");
    const second = await inbox(kadri);

    // Ordered by when somebody last spoke, not by when the thread started.
    expect((first.body as InboxPage).items[0]?.proposal.id).toBe(
      newerProposal.id,
    );
    expect((second.body as InboxPage).items[0]?.proposal.id).toBe(
      older.proposal.id,
    );
  });

  it("leaves out proposals nobody has written on", async () => {
    await proposal();

    const response = await inbox(kadri);

    // An empty thread is noise: this is why threads are made by the first
    // message and not by the proposal.
    expect((response.body as InboxPage).items).toHaveLength(0);
  });

  it("pages, newest activity first", async () => {
    const proposals: string[] = [];
    for (let i = 0; i < 3; i++) {
      const need = await makeNeed({ title: `Need ${String(i)}` });
      const helper = await signUpVerifiedAndLogIn(
        app,
        `helper${String(i)}@example.com`,
        "H",
      );
      await request(app)
        .post(`/needs/${need.id}/proposals`)
        .set("Cookie", helper.cookie)
        .send({});
      const theirs = await prisma.proposal.findFirstOrThrow({
        where: { needId: need.id },
      });
      await send(helper, theirs.id, `hello from ${String(i)}`);
      proposals.push(theirs.id);
    }
    // Two old threads wake up, so the inbox order (1, 0, 2) is nothing like
    // the order the threads were made in (0, 1, 2). That matters: the cursor
    // has to carry the column the list is SORTED by. Built from `createdAt`
    // instead, the second page here asks for "threads made before the first
    // one was" — and quietly comes back empty.
    await send(kadri, proposals[0] ?? "", "one more thing");
    await send(kadri, proposals[1] ?? "", "and another");

    const first = await inbox(kadri, { limit: 2 });
    const firstBody = first.body as InboxPage;
    const second = await inbox(kadri, {
      limit: 2,
      cursor: firstBody.nextCursor ?? "",
    });
    const secondBody = second.body as InboxPage;

    expect(firstBody.items.map((item) => item.proposal.id)).toEqual([
      proposals[1],
      proposals[0],
    ]);
    expect(firstBody.nextCursor).toBeTruthy();
    expect(secondBody.items.map((item) => item.proposal.id)).toEqual([
      proposals[2],
    ]);
    expect(secondBody.nextCursor).toBeNull();
  });
});

describe("POST /conversations/:id/read", () => {
  it("records when I read it, on my own side only", async () => {
    const { conversation } = await thread(2);

    const response = await request(app)
      .post(`/conversations/${conversation.id}/read`)
      .set("Cookie", kadri.cookie)
      .send({});

    expect(response.status).toBe(200);
    const after = await prisma.conversation.findUniqueOrThrow({
      where: { id: conversation.id },
    });
    expect(after.requesterLastReadAt).not.toBeNull();
    expect(after.helperLastReadAt).toBeNull();
  });

  it("is the same request twice, not an error", async () => {
    const { conversation } = await thread(1);
    await request(app)
      .post(`/conversations/${conversation.id}/read`)
      .set("Cookie", yuki.cookie)
      .send({});

    const again = await request(app)
      .post(`/conversations/${conversation.id}/read`)
      .set("Cookie", yuki.cookie)
      .send({});

    expect(again.status).toBe(200);
  });

  it("refuses a moderator, who is only a reader here", async () => {
    const { conversation } = await thread(1);
    const mo = await makeModerator();

    const response = await request(app)
      .post(`/conversations/${conversation.id}/read`)
      .set("Cookie", mo.cookie)
      .send({});

    // Reading somebody else's thread is not the same as having read it.
    expect(response.status).toBe(403);
    const after = await prisma.conversation.findUniqueOrThrow({
      where: { id: conversation.id },
    });
    expect(after.requesterLastReadAt).toBeNull();
    expect(after.helperLastReadAt).toBeNull();
  });

  it("hides a thread the caller is not in", async () => {
    const { conversation } = await thread(1);

    const response = await request(app)
      .post(`/conversations/${conversation.id}/read`)
      .set("Cookie", marek.cookie)
      .send({});

    expect(response.status).toBe(404);
  });
});
