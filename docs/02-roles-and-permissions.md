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
| `MODERATOR` | Appointed | Everything a user can, plus view reports, find an account by email or display name, read any deal and any reported conversation, hide content, warn, suspend, ban, reactivate, and erase a banned account that asked to be forgotten (#88) |
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
| Delete an account | Its owner, with the password as well as the session (#66) — **or a moderator, for a banned account only** (#88). A ban is the moderator's reversible tool and stays that; erasure is the irreversible one, and it exists because a banned account cannot reach `DELETE /me` to ask for itself. An `ACTIVE` or `SUSPENDED` account is refused with `409`: anybody who can sign in closes their own account. Recorded as `ERASE_ACCOUNT` in the audit log, and it is the same anonymisation either way — one function, two doors (decision 0022) |
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
| Write a review | Only a participant of a `COMPLETED` deal, once, about the other side — and only within 14 days of completion, after which everybody can read and nobody can write (#83, decision 0017) |
| Read a review | Anybody, once it is published: both sides have written, or the 14 days have passed. Before that, only its author, who is also the only person who can still change it |
| Report a review | Anybody who can read it, except its author. A review still inside its window answers like one that does not exist, since reporting it would be a way to discover it (#125) |
| Remove a review | `MODERATOR` or above. It keeps its place with its words and stars gone, counts towards nothing, and the action is recorded against its **author** (#125, decision 0018) |
| Read a removed review's words | Only a moderator, through `GET /admin/reports/:id`. The row is kept as evidence, and evidence its only permitted reader cannot read is not evidence |
| See a receipt file | Only the two deal participants, plus moderators — and a moderator's read is written to the log, the way a moderator opening a deal or a conversation is (#82) |
| Attach a receipt to a deal | Only the helper, who is the one who buys. The requester and a moderator get `403`, a stranger `404`; three of each kind, and nothing deletes one (#82) |
| See an avatar or a need photo | Whoever may see the profile or the need it belongs to (#79). Anyone else gets the same `404` as for a file that does not exist |
| See a need photo as a moderator | Whatever the need's status, including `REMOVED` (#81). Removing a need would otherwise hide the picture it was removed for, and `PROHIBITED_ITEM` reports are usually about the picture |
| See an avatar as a moderator | Whatever became of the account, including `BANNED` (#139, decision 0025). The same argument one step on: banning somebody would otherwise hide the profile picture they were banned for. The read is logged, unless the account is live and the picture public |
| Set or remove an avatar | Only your own. `PUT /me/avatar` has no id in it, so there is no somebody else to name (#80) |
| Add or remove a need's photo | Only the need's requester, and only while it is `DRAFT` or `OPEN` — the same rule as editing its words, because a photo is part of what the need says (#81) |
| Any moderation action | `MODERATOR` or `ADMIN` only, and always recorded |

## Rule about self-dealing

A user cannot send a proposal on their own need, and cannot be both sides of a
deal. Enforced in the service layer, since the database cannot express it.
