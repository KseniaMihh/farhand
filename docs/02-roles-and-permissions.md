# Roles and permissions

## Two different things

**Account role** is stored on the user: `USER`, `MODERATOR`, `ADMIN`.

**Deal position** is not stored on the user. The same person is a requester in
one deal and a helper in another. Position is derived from the deal:
`deal.requesterId` and `deal.helperId`.

Confusing the two is a common design mistake. Farhand never stores "is a
helper" as a property of a person.

## Account roles

| Role | Who | Can do |
|---|---|---|
| Guest | Not signed in | Browse public needs and helps, view public profiles, register |
| `USER` | Registered, email confirmed | Everything a guest can, plus post needs and helps, send and answer proposals, message, act on their own deals, review, report, edit their own account |
| `MODERATOR` | Appointed | Everything a user can, plus view reports, find an account by email or display name, read any deal and any reported conversation, hide content, warn, suspend, ban, reactivate |
| `ADMIN` | Appointed | Everything a moderator can, plus change roles and view any account's details |

## Account status

Independent of role. Stored as `AccountStatus`.

| Status | Sign in | Post or message | Notes |
|---|---|---|---|
| `ACTIVE` | Yes | Yes | Normal |
| `SUSPENDED` | Yes | No | Temporary; `suspendedUntil` set. Existing deals still visible so obligations can be settled |
| `BANNED` | No | No | Permanent |
| `DELETED` | No | No | Anonymised on request through `DELETE /me`, which asks for the password again and is refused while a deal is running (#66). Deals, messages and events are kept so the other side keeps their history |

An unconfirmed email is not a status. The user exists and can sign in, but
cannot post or send proposals until `emailVerifiedAt` is set.

## Permission rules that must be enforced on the server

Hiding a button in the frontend is not a permission. Each of these is checked in
the API on every request.

| Action | Rule |
|---|---|
| Edit a profile | Only its owner. `PATCH /me/profile` takes no id, so there is no other profile it could name (#65) |
| Delete an account | Only its owner, and only with the password as well as the session. No moderator route deletes an account — banning is the moderator's tool, and it is reversible (#66) |
| Read a profile | Anyone, but only the public fields. A banned or deleted account answers exactly like an id that never existed |
| Edit or delete a need | Only its requester, and only while status is `DRAFT` or `OPEN`. Deleting closes it (`CLOSED`); the row stays |
| Edit or delete a help | Only its helper, and not once it is `REMOVED`. Deleting marks it `REMOVED`; the row stays |
| Send a proposal | Any active user except the need's own requester |
| Accept or decline a proposal | Only the need's requester |
| Withdraw a proposal | Only the helper who sent it |
| Read a conversation | Only the two participants, plus moderators |
| Read a deal, or its event log | Only its requester and helper, plus moderators. A stranger gets `404`, never `403` — saying a deal exists is itself the leak |
| Find an account | `MODERATOR` or above. Email matched exactly, never partially, so the endpoint cannot become a way to list everybody at a domain (#67) |
| Advance a deal | Only the person named for that transition in `04-deal-lifecycle.md` |
| Write a review | Only a participant of a `COMPLETED` deal, once |
| See a receipt file | Only the two deal participants, plus moderators |
| Any moderation action | `MODERATOR` or `ADMIN` only, and always recorded |

## Rule about self-dealing

A user cannot send a proposal on their own need, and cannot be both sides of a
deal. Enforced in the service layer, since the database cannot express it.
