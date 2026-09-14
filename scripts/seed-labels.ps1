# Creates the label set for Farhand.
# Requires GitHub CLI: winget install -e --id GitHub.cli   then   gh auth login
# Run from the repository root:  ./scripts/seed-labels.ps1

$labels = @(
  @{ name = "area:auth";     color = "1D76DB"; desc = "Registration, login, sessions" },
  @{ name = "area:needs";    color = "0E8A16"; desc = "Need listings" },
  @{ name = "area:helps";    color = "0E8A16"; desc = "Help listings" },
  @{ name = "area:messages"; color = "5319E7"; desc = "Proposals, conversations, messages" },
  @{ name = "area:deals";    color = "B60205"; desc = "Deal lifecycle and events" },
  @{ name = "area:admin";    color = "D93F0B"; desc = "Moderation and audit" },
  @{ name = "area:infra";    color = "444444"; desc = "Tooling, CI, Docker, deployment" },
  @{ name = "type:feature";  color = "A2EEEF"; desc = "New capability" },
  @{ name = "type:chore";    color = "FEF2C0"; desc = "Tooling or dependencies" },
  @{ name = "type:test";     color = "C5DEF5"; desc = "Tests only" },
  @{ name = "type:docs";     color = "C5DEF5"; desc = "Documentation only" },
  @{ name = "type:bug";      color = "D73A4A"; desc = "Something is broken" },
  @{ name = "type:decision"; color = "FBCA04"; desc = "A choice to make" }
)

foreach ($l in $labels) {
  gh label create $l.name --color $l.color --description $l.desc --force
}
Write-Host "Labels created."
