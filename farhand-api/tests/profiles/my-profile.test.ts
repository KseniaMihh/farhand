import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { prisma } from "../../src/db.js";
import {
  signUpAndLogIn,
  signUpVerifiedAndLogIn,
  type TestUser,
} from "../helpers/auth.js";

/**
 * PATCH /me/profile — issue #65.
 *
 * These tests are the specification. They fail until the TODOs in
 * src/services/profiles.ts are filled in.
 *
 *   npm run test:watch -- my-profile
 *
 * The endpoint has no `:id`, so "edits the caller's own profile, and nobody
 * else's" is not a check that can be forgotten — there is no path for the other
 * case to arrive on. What the tests below pin instead is that nothing in the
 * body can turn it into one.
 */
/** What the endpoint answers with, and what it answers with instead. */
interface ProfileBody {
  profile: {
    displayName: string;
    bio: string | null;
    countryCode: string;
    city: string | null;
    avatarUrl: string | null;
  };
}

interface PublicBody {
  user: { displayName: string; bio: string | null };
}

interface MeBody {
  user: { profile: { city: string | null } };
}

interface ErrorBody {
  error: { code: string; message: string };
}

const app = createApp();

let anna: TestUser = { id: "", email: "", cookie: "" };
let boris: TestUser = { id: "", email: "", cookie: "" };

beforeEach(async () => {
  anna = await signUpVerifiedAndLogIn(app, "anna@example.com", "Anna");
  boris = await signUpVerifiedAndLogIn(app, "boris@example.com", "Boris");
});

/** The profile row as it now stands, straight from the database. */
function storedProfile(userId: string) {
  return prisma.profile.findUniqueOrThrow({ where: { userId } });
}

describe("PATCH /me/profile", () => {
  describe("the guards", () => {
    it("refuses a request with no session", async () => {
      const response = await request(app)
        .patch("/me/profile")
        .send({ displayName: "Anna B" });

      expect(response.status).toBe(401);
      expect((await storedProfile(anna.id)).displayName).toBe("Anna");
    });

    it("refuses an unverified account", async () => {
      const unverified = await signUpAndLogIn(app, "carol@example.com");

      const response = await request(app)
        .patch("/me/profile")
        .set("Cookie", unverified.cookie)
        .send({ displayName: "Carol B" });

      expect(response.status).toBe(403);
    });

    it("refuses a suspended account", async () => {
      await prisma.user.update({
        where: { id: anna.id },
        data: { status: "SUSPENDED", suspendedUntil: null },
      });

      const response = await request(app)
        .patch("/me/profile")
        .set("Cookie", anna.cookie)
        .send({ displayName: "Anna B" });

      expect(response.status).toBe(403);
      expect((await storedProfile(anna.id)).displayName).toBe("Anna");
    });
  });

  describe("what it changes", () => {
    it("changes a field and returns the profile as it now is", async () => {
      const response = await request(app)
        .patch("/me/profile")
        .set("Cookie", anna.cookie)
        .send({ displayName: "Anna B", bio: "Tallinn–Tokyo twice a year." });

      expect(response.status).toBe(200);
      expect((response.body as ProfileBody).profile).toEqual({
        displayName: "Anna B",
        bio: "Tallinn–Tokyo twice a year.",
        countryCode: "EE",
        city: null,
        avatarUrl: null,
      });
    });

    /**
     * The answer has to be what is stored, not what was sent. A response
     * assembled from the request body would pass every test above while the
     * write failed — the mistake #20 made for real, and found the same way.
     */
    it("answers with the row that is now in the database", async () => {
      /**
       * One request has to prove both halves, because each half alone can be
       * faked. A field the request did NOT mention, holding something other
       * than its default — a reply assembled from the request body answers
       * `bio: null` here, since null is what an absent bio looks like from the
       * request's side. And a field the request DID change — a reply that is
       * really the row from before the write answers `city: "Tartu"`.
       */
      await prisma.profile.update({
        where: { userId: anna.id },
        data: { bio: "The old bio", city: "Tartu", countryCode: "FI" },
      });

      const response = await request(app)
        .patch("/me/profile")
        .set("Cookie", anna.cookie)
        .send({ displayName: "Anna B", city: "Tallinn" });

      const stored = await storedProfile(anna.id);
      expect(stored).toMatchObject({
        displayName: "Anna B",
        bio: "The old bio",
        city: "Tallinn",
        countryCode: "FI",
      });
      expect((response.body as ProfileBody).profile).toEqual({
        displayName: stored.displayName,
        bio: stored.bio,
        countryCode: stored.countryCode,
        city: stored.city,
        // Not `stored.avatarUrl`, which is what this line used to say. The
        // field in the answer is computed from avatarFileId (#80); the column
        // of the same name is dead and being removed (#103). Comparing them
        // only ever passed because both were null — give this profile an
        // avatar and the old assertion would have failed. Anna has no avatar
        // here, and what the field really does is avatar.test.ts's job.
        avatarUrl: null,
      });
    });

    it("leaves the fields it was not told about alone", async () => {
      await prisma.profile.update({
        where: { userId: anna.id },
        data: { bio: "The old bio", city: "Tartu" },
      });

      await request(app)
        .patch("/me/profile")
        .set("Cookie", anna.cookie)
        .send({ displayName: "Anna B" });

      const stored = await storedProfile(anna.id);
      expect(stored).toMatchObject({
        displayName: "Anna B",
        bio: "The old bio",
        city: "Tartu",
        countryCode: "EE",
      });
    });

    /** A PATCH that mentions no fields is a request to change no fields. */
    it("accepts an empty body and changes nothing", async () => {
      const before = await storedProfile(anna.id);

      const response = await request(app)
        .patch("/me/profile")
        .set("Cookie", anna.cookie)
        .send({});

      expect(response.status).toBe(200);
      expect(await storedProfile(anna.id)).toEqual(before);
    });

    /**
     * Three distinct requests, three distinct meanings: `null` clears, `""` is
     * refused, and an absent key keeps what is there. Without the middle one,
     * a bio could be emptied by a value the column would then hold as an empty
     * string rather than as nothing.
     */
    it.each(["bio", "city"] as const)("clears %s with null", async (field) => {
      await prisma.profile.update({
        where: { userId: anna.id },
        data: { bio: "something", city: "Tartu" },
      });

      const response = await request(app)
        .patch("/me/profile")
        .set("Cookie", anna.cookie)
        .send({ [field]: null });

      expect(response.status).toBe(200);
      expect((await storedProfile(anna.id))[field]).toBeNull();
    });

    it("uppercases a country code, as registration does", async () => {
      const response = await request(app)
        .patch("/me/profile")
        .set("Cookie", anna.cookie)
        .send({ countryCode: "fi" });

      expect(response.status).toBe(200);
      expect((response.body as ProfileBody).profile.countryCode).toBe("FI");
    });

    it("trims a display name", async () => {
      await request(app)
        .patch("/me/profile")
        .set("Cookie", anna.cookie)
        .send({ displayName: "  Anna B  " });

      expect((await storedProfile(anna.id)).displayName).toBe("Anna B");
    });

    it("is visible through the public profile straight away", async () => {
      await request(app)
        .patch("/me/profile")
        .set("Cookie", anna.cookie)
        .send({ displayName: "Anna B", bio: "Ask me about Tokyo." });

      const response = await request(app).get(`/users/${anna.id}`);

      expect((response.body as PublicBody).user).toMatchObject({
        displayName: "Anna B",
        bio: "Ask me about Tokyo.",
      });
    });

    it("is visible through GET /auth/me straight away", async () => {
      await request(app)
        .patch("/me/profile")
        .set("Cookie", anna.cookie)
        .send({ city: "Tallinn" });

      const response = await request(app)
        .get("/auth/me")
        .set("Cookie", anna.cookie);

      expect((response.body as MeBody).user.profile.city).toBe("Tallinn");
    });
  });

  describe("what it refuses", () => {
    it.each([
      ["a blank display name", { displayName: "   " }],
      ["a display name of 51 characters", { displayName: "x".repeat(51) }],
      ["a blank bio", { bio: "" }],
      ["a bio of 501 characters", { bio: "x".repeat(501) }],
      ["a blank city", { city: "" }],
      ["a city of 81 characters", { city: "x".repeat(81) }],
      ["a country that is not a country", { countryCode: "12" }],
      ["a one-letter country", { countryCode: "E" }],
      ["a display name that is not a string", { displayName: 42 }],
      ["a null display name", { displayName: null }],
    ])("refuses %s with 422", async (_name, body) => {
      const response = await request(app)
        .patch("/me/profile")
        .set("Cookie", anna.cookie)
        .send(body);

      expect(response.status).toBe(422);
      expect((response.body as ErrorBody).error.code).toBe("VALIDATION_FAILED");
      expect(await storedProfile(anna.id)).toMatchObject({
        displayName: "Anna",
        bio: null,
        city: null,
        countryCode: "EE",
      });
    });

    /**
     * An avatar arrives as an upload in v2 (docs/08-scope.md). Until then the
     * only thing this could accept is a URL somebody typed, which points the
     * site's image tags at a server we do not control. Dropped, not refused:
     * unknown fields are ignored everywhere in this API (#10).
     */
    it("ignores avatarUrl", async () => {
      const response = await request(app)
        .patch("/me/profile")
        .set("Cookie", anna.cookie)
        .send({ avatarUrl: "https://tracker.example.com/pixel.png" });

      expect(response.status).toBe(200);
      // It used to be the dead column that was checked here (#103). The thing
      // worth checking is the one a typed-in URL would have been trying to
      // reach: the avatar itself, which only PUT /me/avatar can set.
      expect((await storedProfile(anna.id)).avatarFileId).toBeNull();
      expect((response.body as ProfileBody).profile.avatarUrl).toBeNull();
    });

    /**
     * The one way a bodyless-id endpoint could still edit somebody else: a
     * field in the body that Prisma would happily take as the key.
     */
    it("ignores a userId in the body", async () => {
      const response = await request(app)
        .patch("/me/profile")
        .set("Cookie", anna.cookie)
        .send({ userId: boris.id, displayName: "Anna B" });

      expect(response.status).toBe(200);
      expect((await storedProfile(anna.id)).displayName).toBe("Anna B");
      expect((await storedProfile(boris.id)).displayName).toBe("Boris");
    });

    it("cannot change an email address", async () => {
      await request(app)
        .patch("/me/profile")
        .set("Cookie", anna.cookie)
        .send({ email: "somebody.else@example.com" });

      const user = await prisma.user.findUniqueOrThrow({
        where: { id: anna.id },
      });
      expect(user.email).toBe("anna@example.com");
    });

    it("cannot promote the caller", async () => {
      await request(app)
        .patch("/me/profile")
        .set("Cookie", anna.cookie)
        .send({ role: "ADMIN", status: "ACTIVE", displayName: "Anna B" });

      const user = await prisma.user.findUniqueOrThrow({
        where: { id: anna.id },
      });
      expect(user.role).toBe("USER");
    });

    it("touches nobody else's profile", async () => {
      const before = await storedProfile(boris.id);

      await request(app)
        .patch("/me/profile")
        .set("Cookie", anna.cookie)
        .send({ displayName: "Anna B", bio: "Mine." });

      expect(await storedProfile(boris.id)).toEqual(before);
    });
  });
});
