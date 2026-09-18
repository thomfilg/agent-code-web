# GitHub permissions come from GitHub, not a second Relay company list

## Decision

The user explicitly rejected the redundant GitHub company-access step on
2026-09-18. Connecting a personal or work GitHub account makes every repository
that GitHub permits that identity to access available to its owning Relay user.
Relay no longer applies a separate organization/company allowlist to GitHub
connections. This supersedes only the GitHub part of earlier company-scope
requirements, including feature-queue item 21 and the 14:11 onboarding patch.

Existing connected records work without reconnecting or editing their old
`companies`/`organization`/`allowUnassigned` fields. Those obsolete fields are
not an access policy and are not published as current connection settings.
Public attempts to save the removed policy fail clearly rather than claiming
to apply a restriction that no longer exists.

## Boundaries that do not change

- Each Google-authenticated Relay user owns an independent credential namespace.
  Another user's account, operator credentials and host CLI state are never
  fallback credentials.
- Repository selections retain the exact GitHub connection ID. Ambiguous
  multiple-account selection fails; a denied request never tries another token.
- GitHub authorizes repository/branch reads and writes. Expiry, revocation,
  organization SSO and provider denials remain effective.
- Worker Git/MCP capabilities remain revocable and bound to the selected owner,
  connection, immutable repository identity, branch and chat state. Listing all
  accessible repositories does not give a worker access to unselected ones.
- Primary-repository company grouping and company scopes for Codex/Claude
  accounts, environments and MCP connections are unchanged. Choosing a secondary
  repository does not expand those non-GitHub permissions.
- Credentials remain encrypted on the controller. No token-entry or import of
  a server's shared GitHub login is added to the product.

## UI and verification

The GitHub panel contains connection identity, sign-in/reconnect progress,
optional naming and disconnect actions, without company checkboxes. A successful
sign-in refreshes repository availability directly. Loading/provider errors,
empty accessible repositories and search misses remain distinguishable.

Tests must cover new and existing empty/restrictive/legacy connection records,
multiple organizations, provider denial without fallback, another user's record
ID, ambiguous connections, selected-repository worker boundaries, cancellation
and revocation. Browser acceptance must list/select a repository without saving
any GitHub company configuration. Agent/environment/MCP scope regressions remain
required; they must not be rewritten as all-company grants.
