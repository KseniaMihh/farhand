# 0028 — The README is checked, not remembered

## Context

`README.md` had a source tree and a table of test files. Both stopped at
`helps.ts`, which is issue #18. Thirty-five source files and thirty-nine test
files arrived afterwards and appeared in neither.

Nobody noticed for months, and the reason is the same sentence #69 was written
under: nothing was looking. That issue found five endpoints the contract
promised and the code had never built, and answered it with a test that reads
the document and the routing table and compares them. This is the same problem
in the file a newcomer opens first.

The third acceptance criterion of #92 asked the question directly: can a test
keep these honest, or is that more machinery than a README deserves?

## Decision

**A test, and it checks existence only.** `tests/contract/readme.test.ts`,
beside its older neighbour:

| | |
|---|---|
| Every file under `src/` | has a line in the tree |
| Every `.ts` the tree names | is a file that exists |
| Every file under `tests/` ending `.test.ts` | has a row in the table |
| Every row in the table | names a test that exists |
| Every row's description | is at least four words |

**Not whether the descriptions are still true.** No test can tell whether
"who may create, edit and close a need" is a fair summary of `needs.ts`, and
one that tried would be a test nobody could keep green — it would be
re-litigated on every commit and eventually deleted, taking the useful half
with it. The drift that actually happened was files arriving and nothing
saying so, and that is exactly what this catches.

The four-word rule is the one judgment it does make, and it earns its place: a
row reading "tests things" satisfies every other check and tells nobody
anything. A broken version proved it by writing exactly that.

**Paths, not names.** `needs.ts` is a route and a service; `auth.ts` is a
route and a middleware. A check on names alone passes while a file sits in the
wrong branch of the tree — which one of the broken versions did, moving
`erasure.ts` from `services/` to `routes/` and being caught twice over.

**A number, so the parser cannot pass by finding nothing.** If reading the
tree silently returned an empty list, both halves would pass by comparing
nothing to nothing — the failure mode of every checker that reads a document.
The test asserts it found more than fifty files and names three of them.

**The endpoint table is deleted rather than maintained.** The README also
carried a list of endpoints, which was a copy of `docs/06-api-contract.md` —
the specification, and the one already guarded by #69's test. Keeping it
meant a third place to forget, and growing it meant copying sixty rows out of
a document that is checked into one that would not be. What is left is the
handful somebody needs to see the API running, and a pointer to the contract.

**The tests are listed by folder in the tree**, and one by one in the table.
Two full lists of fifty-five files in one document is once too many, and the
table is the one that says what each file is for.

## Alternatives

**Describe directories, not files.** One paragraph per folder: nothing to
drift, nothing to police, and a shorter README. Rejected because the test
table is the map of what this project has covered — the thing somebody reads
to find out whether a rule is tested and where. Losing it to avoid maintaining
it is the wrong trade when maintaining it is now automatic.

**Fix the lists by hand and leave it there.** The smallest change today, and
precisely what happened after #18: the lists were right once, and nothing was
looking when they stopped being. A README is the document most likely to rot,
because it is the one nobody has to open to do their work.

**Generate the lists instead of checking them.** A script that writes the tree
and the table from the filesystem. It would never be wrong, and it would never
say anything either: the descriptions are the whole value, and a generator
cannot write "who may create, edit and close a need". Checking leaves the
sentences to a person and the bookkeeping to the machine.

**Check the descriptions against the file's own doc comment.** Tempting —
every file here opens with one. It would compare two summaries that are
allowed to differ (one for a reader of the README, one for a reader of the
code) and fail on the day somebody improves either. Four words is the line.

## Consequences

- **Adding a file now fails a test** until the README names it. That is the
  point, and it is a small tax on every new file: one line in the tree, or one
  row and a sentence for a test. The failure message names the files, so the
  fix is mechanical.
- **Renaming a file fails twice** — missing from one list, imaginary in the
  other — which reads oddly until you see that the two halves are what make
  the check honest in both directions.
- **The README is not Prettier-formatted**, because `format:check` runs from
  `farhand-api` and never sees it. Left alone deliberately: reformatting would
  reflow every paragraph in the file and bury this change in a diff nobody
  could read.
- **`docs/` is still unchecked.** Thirteen documents, none of them compared to
  anything except by #69's contract test and this one. That is a gap with no
  issue against it yet, and worth remembering the next time something in there
  turns out to have been wrong for a month.
