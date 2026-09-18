# Inline chat, agent choice and company connections — 2026-09-18

Runtime source: `b7b30678219162ad1e5b1b0b24943d6f32cd7d36`.
This is a local acceptance receipt, **not an AWS publication receipt**.

## Delivered in source

- New chat is an inline page, without a creation popup. Environment and compact
  repository/branch chips sit above the composer. The first submission shows
  progress immediately, sends once, and preserves the task if creation or sending
  fails. Existing chats have a compact repository-add control with a workspace
  restart warning; this does not claim process-preserving repository addition.
- One selector combines provider, account name and identity. Own connected agent
  accounts work across projects, with the last choice remembered per primary
  repository and Relay user. Removing the former company allowlist does not
  weaken user ownership, provider matching, disconnect or revocation checks.
- Companies have a separate registration page. MCP opening shows company-filtered
  provider/status cards, followed by a connection-specific detail view. Technical
  endpoint, transport and OAuth-client settings are under Advanced settings.
- Each MCP belongs to one company. The implemented GitHub rule is one native
  connection per company, with provider-authorized secondary repositories using
  the primary company's connection. Agent accounts alone are multi-company.
- Company MCPs are included when the agent starts, without the redundant
  environment-MCP checkbox. Environment access and encrypted controller-held
  upstream secrets remain enforced; the worker gets a revocable capability.
- Repository refresh no longer closes its own menu when an action replaces its
  DOM before the document click handler runs. Outside-click detection uses the
  event's original dispatch path. The failing browser regression now passes.

## Evidence

- Final scoped Node integration: **133 passed, zero failures**, covering company
  persistence/ownership/revisions, agent accounts and remembered selections,
  GitHub login/API/runtime, Google ownership, MCP/OAuth/Linear, environments and
  runtime manager. Log: `/tmp/relay-company-integration-final.log`.
- Both Codex and Claude fixture adapters receive only their company's gateway
  MCP configuration even when the saved environment MCP selection is empty.
  No upstream credential appears in adapter configuration, chat state or events.
- Agent-account browser suite: 17 passed initially; its remaining repository
  retry regression passed after the menu fix. Logs:
  `/tmp/relay-accounts-company-final.log` and
  `/tmp/relay-repository-retry-final.log`.
- Company/MCP/GitHub final browser run: **16 passed, zero failures**. Covers
  company registration, legacy assignment without reauthentication, connection
  cards/detail navigation, native GitHub login/cancel, masked custom MCPs, preset
  setup and mobile layout. Log: `/tmp/relay-company-browser-final.log`.
- Inline-chat/startup/keymap final browser run: **11 passed, zero failures**.
  Covers immediate progress, failure drafts, repository addition, 320px layout,
  optional repositories, IME/repeated Enter, startup and shortcut regressions.
  Log: `/tmp/relay-inline-final.log`. Two cases also appear in the run above;
  these counts must not be summed as distinct tests.
- Controls, document previews and organization: ten passed initially. The remaining
  repository-order fixture still created an unassigned-default-company GitHub
  connection; it now explicitly chooses Acme and reorders two Acme primary
  candidates, keeping Other/library as a secondary repository. That final test
  passes with real local API persistence, branch selection and error-draft checks.
  Logs: `/tmp/relay-controls-company-final.log` and
  `/tmp/relay-repository-order-final.log`. Cross-company credential denial is
  covered separately in the Node company/GitHub suite, not relaxed in this fixture.
- Four local Linear OAuth browser cases passed across a three-case run and a
  separate final race-case run: PKCE/tool verification, cancellation, popup
  fallback/read-write consent and concurrent-tab revision protection. Logs:
  `/tmp/relay-company-linear-chrome.log` and
  `/tmp/relay-company-linear-race.log`.
- All 43 changed JavaScript modules passed syntax checks; staged whitespace checks
  passed. Only one local heavy suite runs at a time, with one test worker and
  CPU affinity restricted to two cores.
- Final visual recheck: the nine company/new-chat browser cases passed again
  without retries. Desktop/mobile new chat, desktop MCP detail and mobile MCP
  cards were visually inspected. Screenshots remain under
  `/tmp/relay-company-chat-visual-20260918`; log:
  `/tmp/relay-company-chat-visual-final.log`.

Browser boot attempts intermittently failed with `net::ERR_NETWORK_CHANGED` on
local module requests, confirmed in retained traces. Final runs use at most one
retry; the final 16- and 11-case runs passed without retries. This is not proof
that a failed UI assertion is environmental: the repository menu failure above
was a real defect and was corrected.

The earlier full Node run is **not green**: 1,215 passed, three failed, one was
cancelled and three were skipped. The obsolete Claude company-scope assertion
is corrected and passes in the scoped suite; Chrome-extension timeout and
transport/cleanup deadline failures are not claimed resolved by these changes.
No real provider consent, model prompt or quota use is part of this acceptance.

## Production diagnosis and migration choices

Read-only SSM `131aa015-b3f2-4c42-9aa9-6c9be70fd544` confirmed that the reported
chat's `12-apps` environment had an empty MCP selection, while the saved `linear`
connection had OAuth credentials. This explains why connecting Linear alone did
not make its tools available to that agent.

The user explicitly assigned existing Linear connection
`mcp_a4c405e2-d0e1-488b-ba86-55482c0dc40d` to **g2i**. That assignment is authorized
but **not applied in production yet**. It must preserve its encrypted OAuth data
and revoke previous grants; it must not leave that credential usable by 12-apps
or duplicate it into another connection.

The user clarified that there are two GitHub connections: one for **g2i**, one for
**thomfilg + 12-apps**. The latter still needs clarification: one registered company
covering both repository owners, or two separate companies sharing a connection.
The implemented one-company-per-connection model must not be deployed as if this
ambiguity were already resolved. No existing token has been removed or reassigned.

## Publication status

At approximately 20:27 UTC, bounded AWS identity and public HTTPS checks could not
resolve DNS for AWS STS, CloudFront or GitHub from the local environment. The
60-second AWS guard timed out; a bounded retry also failed at the network layer,
not with an expired-credential classification. Public curl checks reported DNS
timeouts for all three hosts. No resource mutation, build, migration, push or
rollout was attempted after this guard failed. Do not ask for another AWS login
on the basis of a DNS failure.
The final bounded CloudFront retry also failed with a DNS timeout; this was not
an application HTTP error or a successful deployed readiness check.

A clean detached release worktree at `/tmp/relay-company-release.gp7GOj` contains
the exact runtime commit, excluding dirty hibernation foundations and unrelated
Claude-doctor work. Once connectivity and the GitHub mapping are settled, build
from the final committed source, then verify its S3 source version, immutable
image, running container, public assets, readiness and deployed denial probes.
The last independently verified AWS runtime remains `b89269a` (18:40 UTC), as
recorded in [the runtime-controls receipt](validation-2026-09-18-runtime-controls.md).

Two-minute process-preserving hibernation remains a separate unfinished feature.
Automatic rollout remains disabled until it preserves running workers. Neither
capability is claimed by this package.
