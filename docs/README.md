# Farhand documentation

Read in this order when new to the project.

| File | Read it when |
|---|---|
| [00-overview.md](00-overview.md) | You want to know what Farhand is and is not |
| [01-glossary.md](01-glossary.md) | A word in the code is unclear |
| [02-roles-and-permissions.md](02-roles-and-permissions.md) | Deciding who may do something |
| [03-user-journeys.md](03-user-journeys.md) | Checking a feature against a real flow |
| [04-deal-lifecycle.md](04-deal-lifecycle.md) | Working on anything touching deals |
| [05-data-model.md](05-data-model.md) | Wondering why a table is shaped this way |
| [06-api-contract.md](06-api-contract.md) | Building or calling an endpoint |
| [07-trust-and-safety.md](07-trust-and-safety.md) | Anything about moderation, privacy or risk |
| [08-scope.md](08-scope.md) | A new idea appears |
| [09-environment.md](09-environment.md) | A tool or command stops making sense |
| [10-decisions/](10-decisions/) | Asking why something was chosen |
| [11-risks.md](11-risks.md) | Something is stuck, or before promising anything |
| [12-business-model.md](12-business-model.md) | Asking how Farhand could ever pay for itself |
| [13-workflow.md](13-workflow.md) | Starting or finishing a work session |
| [14-deployment.md](14-deployment.md) | Putting a change in front of real people, or working out why one did not arrive |

## Rules for these documents

1. `prisma/schema.prisma` is authoritative for the data model. If a document
   disagrees with it, the document is wrong.
2. Decision records are never edited; a new one supersedes an old one.
3. A change to behaviour and the document describing it belong in the same
   commit. For one part of one document this is now a test rather than a
   promise: `farhand-api/tests/contract/endpoints.test.ts` fails if the
   endpoints in [06-api-contract.md](06-api-contract.md) and the routes the app
   really answers have drifted apart in either direction (#69).
4. Version 1 scope does not grow. New ideas go to version 2 by default.
