# farhand-web

The frontend. Next.js, App Router, TypeScript — one screen so far, pointed at
the deployed API.

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

## What is here, and what is next

Here: browse open needs, and the one error path.

Not here, and deliberately not guessed at — the screens come as their own
issues, in roughly this order:

1. **Deploying this app**, which carries three things that belong together:
   `APP_ORIGIN` on Render, the serverless region (a function in the United
   States proxying to Frankfurt would add a transatlantic hop to every
   request), and re-measuring the API's `trust proxy` hop count, because this
   app becomes another machine in front of it
   ([#145](https://github.com/KseniaMihh/farhand/issues/145)).
2. **One need's own page** — the whole description, every photo, who is asking.
3. **Signing in**, which is the first screen that needs the cookie this whole
   arrangement exists for, and the first that must run against a local API
   while it is being built.
4. **Posting a need**, including the prohibited-items tick that
   [#87](https://github.com/KseniaMihh/farhand/issues/87) made a condition of
   publishing anything.
5. **Offering to help, and a deal's own page** — the lifecycle in
   `docs/04-deal-lifecycle.md` as something a person can look at.

The order is a suggestion. What it is not is a plan to build all five before
anybody uses one.
