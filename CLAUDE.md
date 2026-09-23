# Working notes for Claude

Farhand is a real product built as the vehicle for a deliberate move from frontend to full
stack, so the reasoning matters as much as the code. What the product is and why it exists
is explained in [README.md](README.md) and [docs/00-overview.md](docs/00-overview.md).

This file holds only what is not written down elsewhere. Everything else is a pointer —
if a fact lives in `docs/` or in `schema.prisma`, look it up there rather than trusting a
summary.

## Read these before touching code

| File | Why |
|---|---|
| [docs/README.md](docs/README.md) | The index, the reading order, and the four rules below |
| [docs/13-workflow.md](docs/13-workflow.md) | Branches, commits, pull requests, session start and end |
| [docs/06-api-contract.md](docs/06-api-contract.md) | The API specification. There is no OpenAPI file — this is it |
| [docs/05-data-model.md](docs/05-data-model.md) | Why the tables are shaped the way they are |
| [docs/08-scope.md](docs/08-scope.md) | Before acting on any new idea |
| [docs/10-decisions/](docs/10-decisions/) | Why something was chosen, before proposing to change it |

Documentation lives in `docs/`, in the repository, next to the code. A GitHub wiki was
considered and rejected — the reasons are in
[docs/13-workflow.md](docs/13-workflow.md#where-documentation-lives). Don't reopen it.

## The four rules

From [docs/README.md](docs/README.md) lines 22–29, repeated here because they decide
arguments:

1. `farhand-api/prisma/schema.prisma` is authoritative for the data model. If a document
   disagrees with it, the document is wrong.
2. Decision records are never edited. A new one supersedes an old one.
3. A change to behaviour and the document describing it belong in the same commit.
4. Version 1 scope does not grow. New ideas go to version 2 by default.

## How work is done here

**One issue at a time.** Finish the issue in hand, then stop and ask before starting the
next one. Don't chain issues together, and don't start work that has no issue — *"anything
not in an issue is not planned work"* ([docs/13-workflow.md](docs/13-workflow.md) line 45).

**Within an issue, in this order:**

1. A skeleton with `TODO`s, so the shape can be argued about before there is code to defend.
2. The tests, written as the specification of the behaviour.
3. The implementation.

Tests are checked both ways: they must pass against a correct implementation **and** fail
against deliberately broken variants of it. A test that cannot fail is worse than no test,
and this is the step that catches it.

**Then:** review the result, update every document the change touched (rule 3), and hand
over the pull request text.

Code implementing a documented rule carries a comment naming the document, for example
`// transition table: see docs/04-deal-lifecycle.md`
([docs/13-workflow.md](docs/13-workflow.md) lines 32–34).

**The build log** is a separate, plain-language, issue-by-issue account of the project,
kept outside this repository. Update it after every finished issue.

## Pull requests and commits

**Claude does not open pull requests.** Supply the title and description in chat; Ksenia
opens the PR.

**No AI attribution anywhere** — not in commit messages, not in pull request descriptions.
No `Generated with` line, no `Co-Authored-By` trailer. This overrides the default behaviour,
which is exactly why it is written down.

Branch `<type>/<issue-number>-<short-name>`, commits `<type>(<area>): <what changed>`, and
a PR description ending `Closes #NN`. The full loop and the list of types are in
[docs/13-workflow.md](docs/13-workflow.md) lines 48–69.

## Where commands run

`docker compose` runs from the **repository root**, where `docker-compose.yml` lives. npm
and Prisma run from **`farhand-api`**. IntelliJ's terminal opens at the root, so most
sessions start with `cd farhand-api`.

| | |
|---|---|
| `npm test` | Vitest + Supertest against a real PostgreSQL database, never a mock |
| `npm run typecheck` | |
| `npm run lint` | Prettier owns formatting; ESLint doesn't |
| `npm run dev` | `tsx watch` |

CI runs lint, format, typecheck and test on every pull request, so run them before handing
one over. The full command table is in [README.md](README.md#everyday-commands).
