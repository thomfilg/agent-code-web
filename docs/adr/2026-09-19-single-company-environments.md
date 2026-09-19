# One registered company per environment

Status: implementation decision; supersedes the environment-template exception in
[company connections](2026-09-18-company-connections.md). The user requires that
only agent accounts may span companies.

## Decision

Every new or edited environment has exactly one registered company. It cannot
grant unassigned access. `companies: [id]` remains the compatible wire shape;
`companyId` is recorded alongside it, and contradictory IDs are rejected.
GitHub repository owners are not company IDs: multiple repository owners may
belong to the same registered company through its GitHub connection.
Environment names are unique only within their assigned company, so each company
can have a `Dev` template. Reassignment cannot overwrite a same-named destination
environment, and unresolved legacy names do not globally reserve names.

The company registry belongs to the same owner namespace as the environment.
`src/environments.mjs` validates saves and fresh runtime admission, before returning
variables, setup scripts or MCP selection. Registered-company membership is checked
again on admission. `public/environment-scope.js` contains the environment-only
shape check; multi-company agent allowlists deliberately retain their own rules.

## Existing records: owner choice, not credential migration

Missing, empty, multi-company, unassigned-enabled, contradictory or unregistered
assignments are unavailable for new runtime admission. List/read APIs derive
`scopeNeedsReview`; reading or rejecting a worker does not rewrite a record,
increment its revision, move its credentials or choose a company for its owner.
The existing company service may seed company *names* from historical scope; this
does not resolve a multi-company environment or transfer its values.

The owner can open the review bucket, choose one registered company, and save the
same environment. Optimistic revision checks still apply. A regular save is never
interpreted as consent: review-required records also
require `confirmCompanyAssignment: true`, sent only after an explicit selector
change. This prevents a name-only save of a normalized legacy scope from granting
access. Omitted or redacted unchanged variables retain their saved values; protected values remain redacted
and never become agent-readable merely because their company changed. Software,
disabled-variable settings and setup scripts also survive a scope-only edit.
There is no automatic split, duplication, secret export or cross-company copy.

A new empty installation receives an inert Default template, with no company
grant. Register a company and explicitly assign the template before using it.
The separate environment-less chat path is unchanged by this decision.

## UI and running sessions

The environment editor has one registered-company selector, not checkboxes or an
unassigned option. A company-scoped settings card locks that selector to its
inherited company. Explicit legacy review/reassignment is available in standalone
environment settings, with a warning that chats are not moved or granted access.
The composer and remembered-selection restore exclude review-required records.
An unavailable saved selection requires a fresh owner choice, not scope expansion.

No migration restarts or terminates active workers. Existing running processes
retain the environment they started with; existing save callbacks continue to
restrict MCP grants as before. A subsequent runtime admission for a chat from a
different company fails. Live environment injection is not added by this change.

## Acceptance

- Reject zero/multiple/unassigned/unregistered and contradictory company grants.
- Preserve old encrypted payloads and revisions until explicit owner assignment.
- Preserve protected-variable masking and revision conflicts during assignment.
- Deny another owner's company and fresh cross-company runtime admission.
- Reject remembered selections pointing at review-required environments.
- Show legacy review, one selector, no implicit save, and no worker creation while
  resolving it; retain dirty-edit/cancel/error behavior.

Validation uses in-memory records and fixture browser routes only. This decision
does not authorize production migration, secret inspection or worker interruption.
