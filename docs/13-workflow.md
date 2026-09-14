# Working process — docs, issues, branches, commits

How the pieces fit together, and what to do at the start and end of a work
session.

## Where documentation lives

Documentation lives in `docs/` **inside the repository**, next to the code. Not
in a GitHub wiki, not in Google Docs.

Reasons:

- It is versioned with the code. A commit can change behaviour and its document
  together, so the docs match the code at every point in history.
- It is editable in IntelliJ, offline, with search and refactoring.
- It renders on GitHub automatically, with working relative links.
- A pull request can show a documentation change for review alongside code.

A GitHub wiki is a separate repository, is not versioned with the code, and
cannot be edited comfortably from the IDE. Rejected for those reasons.

## Using the docs from IntelliJ

| Task | How |
|---|---|
| Read a document as formatted text | Open the `.md` file; use the preview toggle in the editor's top-right corner |
| Search all documentation | `Ctrl+Shift+F`, set the scope to the `docs` directory |
| Jump to a document by name | `Ctrl+Shift+N`, type part of the filename |
| Keep a document handy | Right-click the file tab → Split Right, to keep it beside the code |
| Mark the ones used most | Right-click the file → Bookmarks → Add Bookmark (`F11`) |

Code that implements a documented rule should say so in a comment, for example
`// transition table: see docs/04-deal-lifecycle.md`. Anyone reading the code
then finds the reasoning, and anyone changing the rule sees where else to look.

## Where planning lives

GitHub Issues, organised by a GitHub Project board.

- **Issue** = one piece of work, small enough to finish in a session or two.
- **Milestone** = a version (`v1`, `v2`), matching `08-scope.md`.
- **Iteration** = a week, set on the Project board.
- **Labels** = `area:*` for the part of the system, `type:*` for the kind of work.

Anything not in an issue is not planned work. New ideas become issues in the
`v2` milestone by default, which is how `08-scope.md` is enforced in practice.

## The loop for one piece of work

1. Pick the issue at the top of this week's iteration.
2. Create a branch from `main`, named `<type>/<issue-number>-<short-name>`,
   for example `feat/12-register-endpoint`.
3. Write the code and its tests.
4. Commit in small steps. Message format:
   `<type>(<area>): <what changed>`, for example
   `feat(auth): hash passwords with argon2id`.
5. Push and open a pull request. Its description ends with `Closes #12`.
6. Wait for CI to pass. Merge with squash. The issue closes automatically.
7. Delete the branch.

Opening pull requests against yourself is not pointless: it runs CI before
anything reaches `main`, keeps `main` always working, and leaves a readable
record of why each change was made. That record is visible to anyone reviewing
the repository later.

## Commit and branch types

`feat` a new capability, `fix` a defect, `chore` tooling or dependencies,
`docs` documentation only, `test` tests only, `refactor` no behaviour change.

## What to do when a document turns out to be wrong

Fix the document in the same pull request as the code. If the decision itself
changed, add a new file in `docs/10-decisions/` that supersedes the old one, and
never edit the old record.

## Session start and end

**Start:** open Docker Desktop, run `docker compose start`, pull the latest
`main`, and open this week's issue.

**End:** commit and push, run `docker compose stop`, quit Docker Desktop, and
move any unfinished issue to next week's iteration on the board.
