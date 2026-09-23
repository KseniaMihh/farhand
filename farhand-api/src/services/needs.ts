/* eslint-disable @typescript-eslint/no-unused-vars --
   The three functions below are stubs and do not use their arguments or
   imports yet. DELETE THIS LINE once they are implemented. */
import { Prisma } from "@prisma/client";
import type { Need, NeedStatus, User } from "@prisma/client";
import { prisma } from "../db.js";
import { HttpError } from "../errors.js";

/**
 * Needs: the rules about who may do what to a listing.
 *
 * This is the first file in src/services/, and the reason it exists is issue
 * #15's first line: "ownership enforced in the service layer, not only in
 * routes". A route's job is to read the request and write the response. If the
 * rule "only the requester may edit this" lives in the route, then the day a
 * second caller appears — an admin screen, a background job, a second endpoint
 * that touches needs — the rule has to be remembered and copied. Rules that
 * are copied are rules that drift.
 *
 * So: routes validate input and turn results into JSON. Everything below
 * decides what is allowed, and answers with HttpError when it is not.
 *
 * The rules themselves are not invented here. They are in
 * docs/02-roles-and-permissions.md and docs/06-api-contract.md:
 *
 *   edit or delete   only the requester, and only while DRAFT or OPEN
 *   delete           not while a live deal exists
 *   create           limited to a few open needs per account
 */

/**
 * How many OPEN needs one account may have at once.
 *
 * docs/07-trust-and-safety.md lists "limit on open listings" as one of the
 * three defences against spam listings, alongside email confirmation and rate
 * limits. Drafts do not count: they are private, and nobody can be spammed by
 * a draft. Closed, expired and matched needs do not count either — the limit
 * is about how much of the public list one person can occupy right now.
 */
export const MAX_OPEN_NEEDS = 5;

/**
 * The fields a caller may set when creating a need.
 *
 * The three that may be empty are "string | null", never undefined: they
 * match the nullable columns in prisma/schema.prisma, and the schema in
 * ../routes/needs.js has already turned a missing value into null.
 */
export interface CreateNeedInput {
  categoryId: string;
  title: string;
  description: string;
  productUrl: string | null;
  storeName: string | null;
  buyCountry: string;
  deliverCountry: string;
  currency: string;
  estimatedPrice: number;
  thankYouAmount: number;
  status: Extract<NeedStatus, "DRAFT" | "OPEN">;
  expiresAt: Date | null;
}

/**
 * The fields a caller may change afterwards: all of them, all optional.
 *
 * Written out rather than Partial<CreateNeedInput> because Zod's .partial()
 * types every key as possibly undefined, and tsconfig's
 * exactOptionalPropertyTypes treats "absent" and "present and undefined" as
 * different things.
 */
export type UpdateNeedInput = {
  [K in keyof CreateNeedInput]?: CreateNeedInput[K] | undefined;
};

/** The same fields with the undefineds gone: what Prisma's update accepts. */
type Provided<T> = { [K in keyof T]?: Exclude<T[K], undefined> };

/**
 * Drops the keys whose value is undefined.
 *
 * Prisma wants a field it should not change to be absent, while the parsed
 * PATCH body is typed as if every key might be present and undefined. At
 * runtime the two already agree — a parsed body only carries the keys it
 * mentioned — so this states that in the type system, in one place.
 */
export function onlyProvided<T extends object>(input: T): Provided<T> {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined),
  ) as Provided<T>;
}

/**
 * Creates a need for this user.
 *
 * TODO(#15):
 *
 *   1. If input.status is "OPEN", count the user's OPEN needs. At
 *      MAX_OPEN_NEEDS or more:
 *
 *        throw HttpError.conflict(
 *          `You already have ${String(MAX_OPEN_NEEDS)} open needs. Close one first.`,
 *        );
 *
 *      409, not 422: the request is perfectly well formed, it just conflicts
 *      with the state of the account (docs/06-api-contract.md).
 *
 *      A need created as a DRAFT skips this check.
 *
 *   2. Create the row with prisma.need.create, requesterId: actor.id, and the
 *      fields from input.
 *
 *   3. A categoryId that matches no category makes Prisma throw a foreign key
 *      error, code "P2003". That is the caller's mistake, not ours, so catch
 *      it and throw HttpError.badRequest("Unknown category") — otherwise it
 *      surfaces as a 500 and looks like our bug. isForeignKeyError() below
 *      recognises it.
 *
 *   4. Return the created need.
 */
export async function createNeed(
  actor: User,
  input: CreateNeedInput,
): Promise<Need> {
  // TODO(#15): replace this whole body.
  return Promise.reject(new Error("createNeed is not implemented yet"));
}

/**
 * Changes a need the user owns.
 *
 * TODO(#15), and the order matters as much as it did in login:
 *
 *   1. Load the need. Missing → throw HttpError.notFound("Need not found").
 *
 *   2. Not theirs (need.requesterId !== actor.id) → throw
 *      HttpError.forbidden("This need belongs to someone else").
 *
 *      403 rather than 404 here, unlike most of this API: a need is public
 *      (GET /needs/:id is open to anyone), so refusing tells the caller
 *      nothing they could not already read. The 404-instead-of-403 rule in
 *      docs/06-api-contract.md is about things you may not KNOW EXIST.
 *
 *   3. Status is not DRAFT or OPEN → throw HttpError.conflict(...). Once a
 *      need is MATCHED, someone has agreed to shop for exactly what it said;
 *      editing it afterwards would change the deal under their feet.
 *
 *   4. If the change publishes a draft (the need is DRAFT and input.status is
 *      "OPEN"), the open-needs limit applies, exactly as at creation. Pull
 *      that check out of createNeed into a small shared function rather than
 *      writing it twice.
 *
 *   5. Update and return the need, with data: onlyProvided(input) — see the
 *      note on that helper. Catch P2003 for an unknown categoryId, as in
 *      createNeed.
 */
export async function updateNeed(
  actor: User,
  needId: string,
  input: UpdateNeedInput,
): Promise<Need> {
  // TODO(#15): replace this whole body.
  return Promise.reject(new Error("updateNeed is not implemented yet"));
}

/**
 * Takes a need down.
 *
 * TODO(#15):
 *
 *   1. Load the need. Missing → 404. Not theirs → 403, as above.
 *
 *   2. Already CLOSED → return, quietly. Deleting twice should not be an
 *      error: the second request wants the same end state as the first, and
 *      it is already true. (The same reasoning as deleteMany in #12's logout.)
 *
 *   3. A live deal exists → throw HttpError.conflict(...). "No live deal"
 *      is the rule in docs/06-api-contract.md. Live means any deal for this
 *      need whose status is not CANCELLED — the database's own
 *      one_active_deal_per_need index uses the same definition
 *      (docs/05-data-model.md). Someone is shopping for this; it cannot
 *      vanish from under them.
 *
 *   4. Otherwise set status to "CLOSED" — do NOT delete the row. Proposals
 *      and messages point at this need, and "soft deletion everywhere" is a
 *      deliberate choice in docs/05-data-model.md: history has to survive.
 *      CLOSED is the requester taking it down; REMOVED is a moderator doing
 *      it (#27).
 */
export async function deleteNeed(actor: User, needId: string): Promise<void> {
  // TODO(#15): replace this whole body.
  return Promise.reject(new Error("deleteNeed is not implemented yet"));
}

/**
 * Prisma's "you referenced a row that does not exist" error — here, a
 * categoryId that matches no category.
 */
function isForeignKeyError(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2003"
  );
}
