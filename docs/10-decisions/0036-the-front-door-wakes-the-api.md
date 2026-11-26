# 0036 — The front door wakes the API on purpose

## Context

[0032](0032-the-session-is-read-in-the-browser.md) put the session in the
browser: `farhand-web/lib/session.tsx` asks `GET /auth/me` on mount and holds
the answer in a context. It did not say where the provider goes, and the
answer was the outermost place available — `farhand-web/app/layout.tsx`, above
all three route groups.

That was written when there were two groups and both read a session. #168
added a third. `(landing)` reads nothing: a visitor who reaches `/` has no
session cookie, because `middleware.ts` sends anybody who has one to `/needs`
(#170), and no cookie _is_ signed out. So the provider was asking a question
on the landing page whose only possible answer was already known before the
page was built.

Two things were tangled together in that one request, and they pull in
opposite directions.

- **It was pointless.** It could not return information. It was also the
  reason the landing page shipped client JavaScript, which `farhand-web/README.md`
  and the build log both claimed it did not — a claim nobody checked because
  the request looked like infrastructure rather than a fetch.
- **It was load-bearing by accident.** On the free plan the API sleeps after
  fifteen quiet minutes and takes most of a minute to wake. The landing page
  is the one screen that renders while it sleeps, which is the whole point of
  it, and `/needs` is the screen that genuinely blocks on it. Asking
  `/auth/me` while somebody read the page meant the API was usually awake by
  the time they clicked. Deleting the provider and nothing else would have
  made the first real click slower for exactly the visitor this page exists
  for.

## Decision

**The provider moves down to the two groups that read it — `(site)` and
`(auth)` — and the wake-up it was performing by accident becomes a thing the
front door does on purpose.**

`farhand-web/components/landing/warm-up.tsx` is a client component that
renders `null`. It asks `GET /health/ready` once on mount and discards the
answer. `/health/ready` rather than `/health` because readiness is the one
that touches the database, so it wakes the whole path rather than just the web
process; neither needs auth.

**On mount, not on hover.** Firing on hover is the thriftier-looking version
and it defeats the purpose. The gap between hovering a link and clicking it is
about half a second, against a wake that can take fifty: the benefit comes
entirely from the twenty or thirty seconds somebody spends reading, and only
mounting captures that. Phones have no hover at all, so the thrifty version
would never fire where a first visit is most likely to happen. The cost of
mounting is one small request from people who read and leave.

**Rejected: removing the provider and accepting the slower first click.** The
honest minimal change, and it trades a measurable second-long wait for a
visitor against a request that costs nothing on this plan. The landing page
exists to survive a sleeping API; making the screen _after_ it worse is the
wrong half of that bargain to keep.

**Rejected: leaving the provider in the root layout.** It works, and it is one
line shorter than this. It also means the only way to know why the landing
page talks to the API is to know that a provider three files up asks a
question it cannot use — which is how a request survives a rewrite nobody
intended it to survive, and how two documents came to describe a page that
fetches nothing.

**Rejected: a second provider above `(site)` and `(auth)` but not
`(landing)`.** The App Router has no such position without another nesting
level under `app/`, which would move every page in both groups to buy back
one request per sign-in. See the first consequence.

## Consequences

- **One extra `GET /auth/me` per sign-in.** `(auth)` and `(site)` are
  siblings, so navigating from `/sign-in` to `/needs` unmounts one provider
  and mounts another, which asks again. `lib/safe-next.ts` makes this
  unconditional rather than occasional: `NOT_A_DESTINATION` lists `/sign-in`,
  `/register` and `/verify`, which is every page in `(auth)`, so signing in
  always leaves the group. The `refresh()` both pages call after a successful
  submit therefore fills a provider that is about to unmount. It is harmless
  and it is now redundant, and it is named here rather than left to be found.
- **A brief neutral header on arriving from sign-in.** The new provider starts
  in `checking`, which the header draws as a hidden copy of the signed-out
  controls (0032). That moment already existed on every first page load; it
  now happens once more, on one navigation.
- **The landing page still ships client JavaScript, and nothing should say
  otherwise.** It ships less of it, for a reason written in the file that
  causes it. The two documents that claimed none are corrected rather than
  quietly rewritten.
- **The provider's position is now a statement.** `useSession` throws outside
  a provider, so a page added to a group that has none fails loudly on the
  first render instead of returning a plausible "signed out".
- **The API is unchanged by this**, as it was by 0031 and 0032. No endpoint,
  no header, no setting — `/health/ready` existed for the deploy job and is
  being read by a second caller.
