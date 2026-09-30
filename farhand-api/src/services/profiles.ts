import type { Profile, User } from "@prisma/client";
import { prisma } from "../db.js";
import { HttpError } from "../errors.js";
import { onlyProvided } from "./shared.js";

/**
 * Profiles: the one thing strangers are allowed to know about each other.
 *
 * Two endpoints, and the whole issue is in the difference between them
 * (docs/06-api-contract.md, "Profile"):
 *
 *   GET /users/:id      anybody, about anybody — four fields and nothing else
 *   PATCH /me/profile   the caller, about themselves — and nobody else
 *
 * The second one has no `:id`. That is deliberate, and it is the entire
 * authorisation story: there is no path for "edit somebody else's profile" to
 * arrive on, so there is no ownership check to forget. Compare needs, where the
 * id is in the path and ../services/needs.ts has to say "only the requester"
 * out loud (docs/02-roles-and-permissions.md). Where a rule can be made
 * structural, it should be.
 */

/**
 * What a stranger sees.
 *
 * Four fields, chosen against docs/07-trust-and-safety.md, which lists
 * "scraping personal data" as a risk and answers it by keeping a profile thin:
 *
 *   displayName   the name they chose to be known by
 *   countryCode   a country, not a city — enough to judge a delivery route
 *   bio           the one field written on purpose to be read by strangers
 *   memberSince   how long they have been here; the only trust signal v1 has
 *
 * Deliberately absent:
 *
 *   email         never, anywhere, for anybody
 *   city          a display name plus a city is often enough to find a real
 *                 person, and nothing in a deal needs it
 *   avatarUrl     uploads are v2 (docs/08-scope.md), and until then the column
 *                 can only hold a URL somebody typed
 *   role, status  moderators are not announced, and a suspension is between
 *                 the account and us
 *
 * No rating summary either: reviews are v2. The field is absent rather than
 * present and always null — a null nobody can explain is worse than an
 * absence, and it arrives with the reviews that would give it a value.
 */
export interface PublicProfile {
  id: string;
  displayName: string;
  countryCode: string;
  bio: string | null;
  memberSince: Date;
}

/** The fields their owner may change. Absent means "leave this alone". */
export interface UpdateProfileInput {
  displayName?: string | undefined;
  bio?: string | null | undefined;
  countryCode?: string | undefined;
  city?: string | null | undefined;
}

/**
 * Anyone's public profile, or a 404.
 */
export async function getPublicProfile(userId: string): Promise<PublicProfile> {
  // Named columns rather than the whole row: passwordHash and email are never
  // loaded here at all, so the promise below — that they cannot escape — is the
  // query shape rather than a habit. The cost is that this list has to change
  // whenever PublicProfile does, which is the one list that should.
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      status: true,
      createdAt: true,
      profile: { select: { displayName: true, countryCode: true, bio: true } },
    },
  });

  // Unknown, DELETED and BANNED all answer the same 404 — indistinguishable,
  // so "does this account exist" is not a question anybody can probe for.
  //
  // SUSPENDED is deliberately NOT in this list: a suspension stops someone
  // acting, not existing, and their live deals carry on, so the other side has
  // to see who they are dealing with
  // (visibility table: see docs/06-api-contract.md, "GET /users/:id").
  if (!user || user.status === "DELETED" || user.status === "BANNED") {
    throw HttpError.notFound("User not found");
  }

  // A user without a profile row cannot happen (#10 creates both together),
  // but returning half a profile would be worse than saying there is none.
  if (!user.profile) {
    throw HttpError.notFound("User not found");
  }

  // Named field by field, never spread. The select above means there is nothing
  // secret in `user` left to leak; naming the fields is the half that still
  // holds the day somebody widens that select.
  return {
    id: user.id,
    displayName: user.profile.displayName,
    countryCode: user.profile.countryCode,
    bio: user.profile.bio,
    memberSince: user.createdAt,
  };
}

/**
 * Edits the caller's own profile.
 *
 * No id parameter, on purpose — the reason is at the top of this file. `user`
 * comes from requireAuth, so the row updated is the session's row, and "only
 * its owner" is structural rather than checked
 * (docs/02-roles-and-permissions.md).
 */
export async function updateMyProfile(
  user: User,
  input: UpdateProfileInput,
): Promise<Profile> {
  return prisma.profile.update({
    where: { userId: user.id },
    data: onlyProvided(input),
  });
}
