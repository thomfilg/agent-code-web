# Company-bound GitHub connections supersede the earlier scope refinement

## Decision and chronology

The 2026-09-18 provider-permissions decision removed a redundant GitHub
organization/company allowlist. Its feature-queue item 21 was not updated after
the user's later explicit requirements:

- One GitHub account per Relay company; a company may have multiple MCP
  connections.
- Only agent accounts may span multiple companies.
- `thomfilg + 12-apps` is one Relay company grouping repositories from both
  GitHub owners, not two companies sharing one connection.
- Chats must not combine repositories assigned to different Relay companies.

Those later requirements govern the current MVP. Retain exactly one saved
GitHub connection per company and the chat's exact connection/company binding.
Do not interpret the stale item 21 text as authorization to remove this boundary
or share existing credentials across companies.

GitHub still decides which repositories and branches the selected account can
access. A Relay company is not a GitHub organization or repository-owner name;
there is no additional GitHub owner allowlist. The company assignment chooses
the saved identity, not a second grant of GitHub repository permissions.

## Consequences and evidence

This reconciles requirements; it does not migrate records, change credentials,
reassign repositories or alter production. Existing unassigned connections need
an explicit company assignment. Missing, expired, revoked or ambiguous
connections must not fall back to another company, another Relay user or host
credentials. Worker grants remain limited to exact selected repositories and
branches. The same boundary applies to GitHub event subscriptions.

The current implementation is described in [GitHub accounts](../github-accounts.md).
Local company-bound read and worker-gateway receipts are linked there. They do
not establish deployed selected-account acceptance or complete the MVP. Item
21 now records the current rule and the remaining acceptance gates instead of
requesting a contrary implementation.
