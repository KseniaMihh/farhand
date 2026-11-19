# farhand-web

The frontend. Next.js, App Router, TypeScript. Browsing, and the way in:
register, confirm an email, sign in.

## Running it

```bash
npm install
npm run dev          # http://localhost:3100
```

Port 3100, because the API's own dev server takes 3000.

With no configuration it talks to the **deployed** API, and that is
**read-only on purpose**. A write from `http://localhost:3100` reaches
production carrying that `Origin`, and the site-wide origin guard refuses it
with `403` ([#28](https://github.com/KseniaMihh/farhand/issues/28)). The
refusal is correct; production's `APP_ORIGIN` is not to be changed to make a
local page work.

To build anything that signs in or writes, run the API locally and point at
it:

```bash
cd ../farhand-api && npm run dev     # one terminal
cp .env.example .env.local           # the other: set FARHAND_API_URL=http://localhost:3000
npm run dev
```

**The local API's `APP_ORIGIN` must be this app's address**, `http://localhost:3100`
— not the API's own. The origin guard that correctly refuses writes from a
laptop to production refuses them locally too, by the same rule, and answers
`403 Cross-site request refused`. Every form on every screen fails the same
way, which reads like a frontend bug and is not one.
`farhand-api/.env.example` ships with the right value; a `.env` copied before
[#156](https://github.com/KseniaMihh/farhand/issues/156) may still say `5173`,
left over from a Vite dev server that was never built.

|                        |                                                  |
| ---------------------- | ------------------------------------------------ |
| `npm run dev`          | Next's dev server, port 3100                     |
| `npm run build`        | A production build, which also typechecks        |
| `npm run typecheck`    | `tsc --noEmit`                                   |
| `npm run lint`         | ESLint. Prettier owns formatting; ESLint doesn't |
| `npm run format:check` | What CI runs                                     |
| `npm test`             | Vitest, for `lib/`                               |

## Deploying it

**Vercel, with the function region pinned to `fra1`** (`vercel.json`). The
reasoning for the region is in `next.config.ts`, beside the rewrite it is
about; the reasoning for Vercel over Render is
[#152](https://github.com/KseniaMihh/farhand/issues/152).

Three settings, and the app is wrong without any one of them:

| Where  | Setting           | Value                    |
| ------ | ----------------- | ------------------------ |
| Vercel | Root directory    | `farhand-web`            |
| Vercel | `FARHAND_API_URL` | the Render API's address |
| Render | `APP_ORIGIN`      | **the Vercel address**   |

`APP_ORIGIN` is the one that catches people. It is the **frontend's** address,
never the API's and never `localhost` — the local default is
`http://localhost:3100` and production's is not. Point it anywhere else and
the origin guard refuses every real write while still accepting one from a
developer's laptop, which is precisely backwards.

### The check that matters after the first deploy

A request made through the deployed site must reach the API carrying **the
visitor's** address, not Vercel's. If it does not, every by-address rate
limit counts every visitor into one shared bucket: ten people signing in from
ten countries exhaust a limit meant for one, and the symptom — "signing in
sometimes says too many attempts" — looks nothing like its cause.

1. Find your own address: <https://api.ipify.org>
2. Sign in through the deployed site, in a browser.
3. Read the newest session back:

   ```sql
   SELECT "ipAddress", "createdAt" FROM "Session" ORDER BY "createdAt" DESC LIMIT 1;
   ```

4. They must match. A Vercel address, or anything in `10.x`, is a failure.

**Do not write the address into the repository.** The result is "the caller's
own address" or "a proxy's" — never the number.

Two more checks, both already built and both cheaper:

- The `ratelimit-policy` response header carries `pk`, a hash of the bucket a
  request was counted in. Two requests from two different machines must land
  in **different** buckets.
- `createCallerAddressCheck` writes one `error` line per process if the
  address it resolves is private. Silence is the expected answer.

### If the address does not arrive

`TRUSTED_PROXY_HOPS` in `farhand-api/src/middleware/caller-address.ts` is
**3**, measured in #145 as caller → Cloudflare → Render's balancer. Vercel in
front plausibly makes it 4 — and plausibly is not a number. Decision 0029
records why it has to be measured: a count that is too _large_ resolves to a
proxy's own public address and passes every check above.

**This happened on the first deploy, and `middleware.ts` is the answer.** A
rewrite declared in `next.config.ts` is performed by Vercel's routing layer,
which makes the outbound request as though it were the client: three entries
in `X-Forwarded-For`, Vercel's leftmost, the visitor's nowhere — and not
under another header name either. The middleware puts it back deliberately,
forwarding only the entry the nearest proxy vouched for.

The hop count was **not** the problem, and raising it would have made things
worse by resolving further left into the part of the header a caller writes
for themselves. `TRUSTED_PROXY_HOPS` stays at 3.

If the middleware ever stops being enough, the escalation is a catch-all
route handler at `app/api/[...path]/route.ts`. It costs more than middleware
— the body no longer streams by itself, and `Set-Cookie` has to be copied by
hand, which is the one thing decision 0031 exists to protect. Not to be built
on suspicion.

## How it talks to the API

Every request goes to this app's own `/api/...`, and `next.config.ts` rewrites
that to the API. The browser therefore only ever sees **one site**, which is
why the session cookie survives — the full argument is
[decision 0031](../docs/10-decisions/0031-the-frontend-proxies-the-api.md), and
the short version is that `sameSite: "lax"` refuses to travel between
`vercel.app` and `onrender.com` because both are public suffixes.

So: **no absolute API URL anywhere in this app.** One would work in
development and quietly fail to stay signed in once deployed.

`lib/api.ts` is the only thing here that knows what an API error looks like.
It turns the shape from
[#4](https://github.com/KseniaMihh/farhand/issues/4) into an `ApiFailure`
anybody can catch, including the failures that never reached the API at all —
a sleeping free-plan service answers with the platform's HTML, not with our
JSON. `lib/api.test.ts` is the specification for that.

## Who is signed in

`lib/session.tsx` asks `GET /auth/me` once, in the browser, and the header,
the banner and every form share the answer. Why the browser and not a server
component — the short version is that a server component would not go through
the rewrite, so it would need an absolute API URL and would have to move the
cookie by hand, which is a second way of talking to the API in an app whose
one architectural decision is that there is exactly one. The full argument is
[decision 0032](../docs/10-decisions/0032-the-session-is-read-in-the-browser.md).

**A session has four states, and the fourth is the point.** `checking`,
`signed-in`, `signed-out`, and `unknown` — the API did not answer. Only a
`401` means signed out. On the free plan the API sleeps after fifteen quiet
minutes, so treating silence as "signed out" would show a signed-in person
"Sign in" on their first visit of the day. `UNREACHABLE` and any `5xx` retry
with a backoff and land on `unknown`, which the header draws exactly like
`checking`.

What a session _is_ lives in `lib/session-state.ts`, with no React in it, so
that rule is pinned by ordinary unit tests. `session.tsx` is a `useState`, a
`useEffect` and a context.

## Styling

**Tailwind v4, plus a short layer of component classes.** The split is a rule
rather than a habit, and it is
[decision 0033](../docs/10-decisions/0033-tailwind-for-arrangement-classes-for-the-rules.md):

|               |                                                                                                                         |
| ------------- | ----------------------------------------------------------------------------------------------------------------------- |
| **Utilities** | Arrangement — layout, spacing, flex and grid, responsive                                                                |
| **Classes**   | Anything carrying a rule: `.btn` and its variants, `.input`, `.badge`, `.avatar`, `.wordmark`, the four `.tint-*` pairs |

A class earns its name when it encodes a decision, and does not when it only
means sixteen pixels of padding. `btn btn-offer` enforces "white on
Terracotta is bold-or-large only, 3.7:1"; `bg-terracotta text-white` does
not, and the ratio came out of the design sheet rather than out of taste.

**Everything is in `app/globals.css`**, in three parts: `@theme` (the
palette, the face, the type scale, all with their contrast ratios in the
comments), `@layer base`, and `@layer components` for the classes above.
There is no `tailwind.config.js` — v4 made configuration CSS, which is why
the design tokens moved across as a rename.

To change a colour everywhere, change it in `@theme`. The two ratios that
constrain where a colour may go are written next to the colours they
constrain; darkening either one makes them untrue.

**One face: Libre Baskerville, everywhere** (#170). It was two until then —
Libre Baskerville to brand, Inter to work — and the design file has one, so
Inter is no longer downloaded at all. `font-sans` is deliberately **deleted**
rather than pointed at the serif, because it has to stop existing rather than
quietly mean the same thing; `--font-sans: initial` is how Tailwind v4 takes
a theme key away.

**The face has 400 and 700 and nothing between**, which is a constraint on
every rule written here. Button, label and badge used to ask for 600; a
browser does not refuse that, it silently draws the nearest weight it has.
They say 700 now, so the stylesheet states what appears on the screen. A new
rule asking for 500 is asking for a face this project does not load.

**Phone width is not finished.** The responsive classes are written and
nobody has looked at them: the priority is the desktop view until the screens
exist. Do not read "it is responsive" off this file.

## The small modules, and why each is its own file

|                                     |                                                                                                                                                                                                                                                                                                                                           |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lib/api.ts`                        | The only thing that calls `fetch` or knows what an API error looks like. `apiGet`, `apiSend` and `apiSendEmpty` share one `request`, because two copies drift in the cookie and the content type — and both of those fail in a deployed browser and nowhere a test would look                                                             |
| `lib/field-errors.ts`               | A `422`'s `details` turned into "what is wrong with THIS input". The one part of the error envelope `api.ts` does not validate, so every entry is checked here                                                                                                                                                                            |
| `lib/safe-next.ts`                  | Where `?next=` may send somebody. It parses rather than inspecting: `/\evil.example` starts with one slash, is not `//`, and still resolves to another origin                                                                                                                                                                             |
| `lib/session-state.ts`              | What a session is, and how to read a failed `/auth/me`                                                                                                                                                                                                                                                                                    |
| `lib/pending-email.ts`              | The address `/register` leaves for `/verify`, in `sessionStorage` rather than the URL, where it would live in history and in every later `Referer`                                                                                                                                                                                        |
| `lib/countries.ts`                  | 249 ISO 3166-1 alpha-2 codes. The API validates `/^[A-Z]{2}$/` and lists nothing, and no browser exposes region codes — `Intl.DisplayNames` names them, it does not enumerate them. `countryName` is the single lookup; its answers differ between Node and Chrome, so a list of them is built after mount rather than prerendered (#166) |
| `lib/browse-filters.ts`             | The four filters `GET /needs` understands, read from and written to the URL — a filtered list is something people send, reload and press Back out of. An empty value is not a filter, or `?q=` narrows the list to nothing and the screen blames the filters                                                                              |
| `lib/browse-state.ts`               | What a browsing screen is in the middle of. `appending` is separate from `loading` so a list is never replaced by a spinner, and every state carries the key its request was made for, so an answer to a question nobody is asking any more is dropped                                                                                    |
| `lib/needs.ts`                      | The two shapes `GET /needs` and `GET /needs/:id` really answer with — ids, not nested objects — plus money and the `/api` prefix every photo path needs. It exports no total, and a test says so                                                                                                                                          |
| `lib/landing-links.ts`              | Every link the landing page offers, in one place, so one test can check the whole set against the routes that exist on disk. Five links, and the rule for a sixth is that its screen is built first (#168)                                                                                                                                |
| `lib/browse-filters.ts` (`hrefFor`) | The address a filtered list lives at, given the path it is already on. It said `/` until #168 moved browse, and the symptom of missing it would have been silent: a filter navigating to the front door with a query string on it                                                                                                         |

## Routes

Three route groups, none of which changes a URL. `(site)` wears the product
header and the banner; `(auth)` is the split screen, with the wordmark inside
the dark panel, because the account screens have no header in the design;
`(landing)` is the front door, with a marketing masthead and footer of its
own. The session provider sits in the root layout, above all three, so the
header, the banner and a form all read one answer rather than racing for
three.

**`/` is the landing page and `/needs` is the list** (#168). Browse was the
root until the front door needed it — two route groups cannot both own `/` —
and the pair reads better as `/needs` and `/needs/:id`. The rule used while
moving it, worth keeping for the next one: _a link that meant the list points
at `/needs`; a link that meant the front page stays `/`._ So the wordmark and
sign-out go to `/`; `HOME` in `lib/safe-next.ts`, where you land after signing
in, is `/needs`, because somebody who has just signed in has decided what this
is.

The landing page is **a static server component with no client JavaScript of
its own** — it fetches nothing, so it is prerendered at build time and appears
whether or not Render's free instance is awake. That is the point of it: it is
the first thing a stranger sees.

**It is also only for people who are not signed in** (#170). `middleware.ts`
redirects a request for `/` that carries a session cookie to `/needs`:
somebody with a session wants the product, not the sales pitch. That is why
the masthead there needs no session at all — a request that reaches the page
has no cookie, and no cookie _is_ signed out, because the cookie is the
session.

Two things that decision bought, and one it accepts:

- The matcher in `middleware.ts` now names `/` as well as `/api/:path*`,
  where it previously took pages out of it on purpose. A server component
  reading the cookie would do the same job and make the route dynamic, which
  costs exactly the property above.
- `components/account-menu.tsx` existed so both mastheads could share one
  sign-out button. There is only one masthead with a name in it again, so the
  menu went back into `components/header.tsx`.
- **A cookie is not a valid session.** A stale one sends somebody to `/needs`
  who turns out to be signed out. That is harmless — the page is public and
  its header draws the signed-out state correctly — and the alternative is
  asking the API on every visit to the front page, which would make the one
  screen that renders while the API sleeps depend on the API being awake.

`app/not-found.tsx` catches the product header's forward links. That header
draws the whole product on one line and five of those screens are not built;
each href is where that screen will live, so the issue that builds it adds a
route and the header does not change. **The landing page is held to a
stricter rule**: every link on it must point at a route that exists, which is
why they all live in `lib/landing-links.ts` and why `landing-links.test.ts`
reads `app/` to check them. The same test forbids an `href` written into any
landing component, because a list of links proves nothing if a component can
write its own.

**Phone width is out of scope on the landing page too**, for the reason in
_Styling_ above: the design is 1512 wide and the priority is the desktop view
until the screens exist. The layout collapses to one column and the hero's
example cards stack under the photograph, and nobody has looked at it.

## What is here, and what is next

Here: the landing page, browse open needs with the four filters and a page at
a time, one need's own page, register, confirm an email, sign in, the header
in its three states and the banner in both of its.

Two things the landing page says less than the design did, both on purpose.
The testimonials are gone — "From people who've done it", three five-star
quotes with names, on a product nobody has used yet — and the hero's example
cards are marked **Example**, are not links, and drop the city and the star
rating the design drew on them. A made-up listing presented as a real one is
the same mistake in miniature, and the city is one the product never shows
anybody but its owner.

Not here, and deliberately not guessed at — the screens come as their own
issues, in roughly this order:

1. **Deploying this app**
   ([#152](https://github.com/KseniaMihh/farhand/issues/152)), which carries
   three things that belong together: `APP_ORIGIN` on Render, the serverless
   region (a function in the United States proxying to Frankfurt would add a
   transatlantic hop to every request), and re-measuring the API's
   `trust proxy` hop count, because this app becomes another machine in front
   of it ([#145](https://github.com/KseniaMihh/farhand/issues/145)). Its
   sharpest criterion — sign in, reload, still signed in — is answerable now.
2. **One need's own page** — the whole description, every photo, who is asking.
3. **Posting a need**, including the prohibited-items tick that
   [#87](https://github.com/KseniaMihh/farhand/issues/87) made a condition of
   publishing anything.
4. **Offering to help, and accepting** — the moment two accounts touch.
5. **A deal's own page** — the lifecycle in `docs/04-deal-lifecycle.md` as
   something a person can look at. The hard one: nine statuses, and who may
   act differs per status. It needs
   [#155](https://github.com/KseniaMihh/farhand/issues/155) first.
6. **Messages.**

The order is a suggestion. What it is not is a plan to build all six before
anybody uses one.

Screens the API supports and nothing here draws — moderation, reports, saved
searches, browse offers, reviews, settings — are a deliberate omission rather
than an oversight. They each cost a screen and earn nothing until somebody is
using the six above.
