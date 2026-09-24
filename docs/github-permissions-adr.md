# GitHub login permissions

Status: accepted

## Context

Relay previously started GitHub CLI device login with its fixed baseline scopes.
That credential could clone repositories, push ordinary files and open pull
requests, but GitHub rejected a push that added or changed
`.github/workflows/*` because the OAuth token did not include `workflow`. The UI
did not disclose that distinction, so an agent could misdiagnose the rejection
as a broken branch publisher or merge failure.

## Decision

GitHub login exposes capability-level choices instead of an arbitrary scope text
box. Repository and pull-request access is required. Workflow-file access is an
explicit optional choice and maps server-side to the allowlisted OAuth
`workflow` scope. Unknown values fail closed.

Relay records both the requested capability set and the scopes GitHub reports
on the authenticated `/user` response. The UI distinguishes requested from
verified permissions. A permission change uses a new device login and does not
discard the existing credential unless the replacement login succeeds;
cancellation, failure or controller restart preserves a still-valid credential.

The credential remains bound to its existing Relay account and company. Scope
selection does not weaken repository/company checks and does not import the
controller's own GitHub login.

## Consequences

- An agent can edit GitHub Actions only after the user reconnects with
  **Workflows** selected.
- Existing connections remain least-privilege and continue working for normal
  repository/PR operations.
- Removing a previously granted OAuth scope may also require revoking the GitHub
  CLI authorization in GitHub; Relay displays scopes reported by GitHub rather
  than claiming that an unchecked option was removed upstream.
