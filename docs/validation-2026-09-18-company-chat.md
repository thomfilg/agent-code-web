# Inline chat, agent choice and company connections — 2026-09-18

Initial runtime source: `b7b30678219162ad1e5b1b0b24943d6f32cd7d36`.
Final mixed-owner-company runtime: `8bc07607f079714008629450c1ce6f5f7488822d`.
AWS publication verified on 2026-09-18 after the explicitly authorized migration
and deletion described below. Local acceptance and live checks are distinguished.

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
- After the user confirmed a combined company, the final company/GitHub/new-chat/
  organization browser run passed **18 tests without retries**, including making
  a different GitHub owner's repository primary without changing Relay company,
  persistence across reload and draft retention. Log:
  `/tmp/relay-company-multi-owner-browser.log`.

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
`mcp_a4c405e2-d0e1-488b-ba86-55482c0dc40d` to **g2i**. The publication applied that
assignment, preserving its encrypted OAuth data and rotating the authorization
generation. It is not available to 12-apps and was not duplicated into another
connection. Previous in-memory grants ended with the controller replacement.

The user clarified that there are two GitHub connections: one for **g2i**, one for
**thomfilg + 12-apps**, and then explicitly chose **one combined Relay company**
for the latter. No GitHub multi-company exception is needed. Repository owners
are now independent of company identity: the controller resolves and persists
the company from the selected, user-owned GitHub connection. Reordering the two
owners does not change company, and another company's credential remains denied.
The follow-up scoped Node run passed **144 tests**, including forged company
metadata, mixed-owner grouping, same-name repositories, environment admission,
preferences and empty-repository chat creation. Log:
`/tmp/relay-company-binding-final-node.log`.

Read-only SSM `52f6fd46-4b51-4857-a653-bbeeee441efc` confirmed both existing
GitHub records: `github_754523ec-0856-4434-9673-654ba6859358` (thomfilg, revision 5)
and `github_e4648eee-be80-40c5-a59d-da6645d2fc4e` (g2i login, revision 2). Linear
is revision 8. The sole saved environment is `12-apps`; its companies were
`12-apps` and `thomfilg`. The saved chat has both `12-apps/future-pay` and
`g2i-ai/clickdown`, using those two different connections.

Read-only SSM `ae8b4448-3395-4af5-ad53-2aa924963d3c` checked the primary GitHub
credential against exactly those already-selected repositories. GitHub returned
200 with matching identity for future-pay and 404 for clickdown. No credential
was printed, imported or reassigned and no provider state was mutated.

**Migration decision resolved:** the user requires separate chats per company
and explicitly authorized deleting the `future-pay / clickdown` chat. Only
`chat_d50034e32eef41d2a9de0f63288a9d7a` is in scope for deletion. Both GitHub
credentials and Linear OAuth must remain intact; no repository is rebound to
another login and no MCP access is widened.

Read-only SSM `6eb0da66-1701-4936-95f9-30a414e57af2` refreshed the exact chat,
legacy owner, connection revisions, environment revision 4 and empty company
registry before maintenance. Fresh EC2 inspection matched its stopped worker,
`i-0a0ed507dd35f0af3`, with root volume `vol-0564d4d0410027f66`, tagged for this
chat/deployment, private networking, disabled metadata and delete-on-termination.
The guarded one-shot scripts are committed at `628d3e0`. Eight tests passed,
including real PostgreSQL commit/rollback, workspace quarantine, preserved
encrypted credentials and rejection of changed ownership/revisions. This is an
explicit operator migration, not an automatic startup migration.

## Publication status

At approximately 20:27 UTC, bounded AWS identity and public HTTPS checks could not
resolve DNS for AWS STS, CloudFront or GitHub from the local environment. The
60-second AWS guard timed out; a bounded retry also failed at the network layer,
not with an expired-credential classification. Public curl checks reported DNS
timeouts for all three hosts. No resource mutation, build, migration, push or
rollout was attempted after this guard failed. Do not ask for another AWS login
on the basis of a DNS failure.
An additional bounded retry failed with a DNS timeout; this was not an
application HTTP error. Connectivity subsequently recovered: public readiness
returned 200 and STS verified the expected account. Publication work resumed;
these checks alone do not establish deployment of the new source.

A clean detached release worktree at `/tmp/relay-company-release.gp7GOj` contains
the final runtime commit, excluding dirty hibernation foundations and unrelated
Claude-doctor work. CodeBuild
`ImageBuild-t8BSbSkDsHYX:56f50985-681e-4e37-969a-51a20e39ac4a` succeeded with exact
source `8bc07607f079714008629450c1ce6f5f7488822d` and immutable S3 source version
`CGmjKLc9n93_kmBdlw7qHlJYnDYQ5eb2`. Its application image digest is
`sha256:05d3178a0e32d15f2c0384297c260c9dd9028d79dbbf802f00258952be2f2be5`.
The pre-rollout worker inventory has one already-stopped worker,
`i-0a0ed507dd35f0af3`, and no running worker. The prior independently verified
runtime was `b89269a`, as recorded in
[the runtime-controls receipt](validation-2026-09-18-runtime-controls.md).

### Controller disk incident during publication

Three maintenance attempts (`f5b77d12-33f7-4bd0-8ad7-ef6955458a1c`,
`6b6bf109-8b1f-4c78-b792-b15846918f50`,
`20215f14-5783-4212-b5ed-76afd5c04be7`) ended in SSM IPC timeout errors.
Reducing/staging the command payload did not resolve the cause. Repeated
read-only checks confirmed the old running image, no migration receipt, intact
chat, no archive and a free rollout lock; nothing was blindly replayed.

SSM `091d38fc-f108-4575-8a72-fbe1f948b431` classified the private logs without
printing them: each failed attempt coincided with `no space left on device`.
Capacity check `ce5ed2a1-d452-4275-a56e-614f562ead77` showed the root filesystem at
94% usage, only 1.5 GB available, while the separate data volume retained 37 GB.
The old release stayed publicly ready throughout these failed preparations.

Read-only Docker inventory `62d7915c-541c-4c4e-ab7e-653c5c73d09b` identified ten
unreferenced images from this Relay's ECR repository. All ten immutable recovery
copies were verified in ECR before removal. An initial conservative guard
rejected Docker's digest-shaped `RepoTags` representation without deleting any
image. Scoped cleanup `671aa494-105c-41ed-a754-68377d965ec7` succeeded after the
actual representation was verified: only those ten local image references were
removed, no force/prune operation, with current and previous containers/images
and all application data retained. Free root space became **16,931,786,752 bytes**.
Those local caches are recoverable by pulling the same ECR digests.

The source-hash-verified maintenance was then submitted as
`c851104a-fd14-465b-97ef-4029eb7f7958`. It runs under the reviewed CI rollout lock,
with a drained/stopped controller, an offline network-disabled DB maintenance
container, one transaction, a private encrypted rollback receipt, and the exact
chat workspace moved outside the live chat directory. Source bundle SHA-256:
`3c47ad2ca4540ad343a04cf30361578b6c28742af3cdcb258508e89a3990915f`.
This manual maintenance delivery does not enable automatic deploys.

### Verified publication and exact deletion

SSM `c851104a-fd14-465b-97ef-4029eb7f7958` completed **Success / exit 0**. The
transaction committed at **21:38:32 UTC** and the new controller passed readiness.
Its receipt verified unchanged GitHub tokens, Linear OAuth, existing environment
variables and all unrelated encrypted records. The previous image was retained.

- Registered companies: `g2i`, and `12-apps` displayed as **thomfilg + 12-apps**.
  Both native GitHub connections keep their original credential and belong to
  their respective company; no new login or widened provider grant was used.
- The existing environment retains its settings under the combined company.
  Fresh environment `env_7a0c6d8e-2419-4e72-9eba-821140610c19` belongs only to g2i
  and has no copied variables or setup script. Mixed-company new-chat defaults
  were trimmed to the original primary company's repository, preserving the
  chosen account/model and environment.
- Exact deleted chat: `chat_d50034e32eef41d2a9de0f63288a9d7a`. Its controller-side
  workspace and encrypted pre-migration records are privately retained under
  `/srv/relay/data/maintenance/company-migration-20260918` for operator recovery,
  outside the live chat directory. This is not a UI undo facility or a backup of
  unsynchronized files from the worker's disk.
- Fresh ownership/isolation/root-volume checks preceded termination of only
  `i-0a0ed507dd35f0af3`. EC2 subsequently reported **terminated**, and a filtered
  volume lookup confirmed **vol-0564d4d0410027f66 absent**. That worker disk was
  deleted by its existing delete-on-termination policy, not retained for recovery.
  The controller, its separate data volume and all account connections remain.

Independent post-deploy SSM `4c924f3f-d488-4e16-8a82-ac80e15e5a6b` verified the
running image digest `05d3178a…`, zero saved chats, both GitHub connections and
both Codex/Claude accounts still connected. Runtime environment resolution selects
the existing Linear MCP for **g2i only** and no Linear MCP for the combined
company. The real Linear connection test discovered **79 tools** and successfully
called the read-only `list_teams` check; no team contents were printed or saved.
No agent prompt, model quota, provider consent or issue-writing operation was used.

All **14 changed public assets** matched the clean release's SHA-256 hashes over
the public CloudFront URL. Public `/readyz` returned **200**, anonymous
`/api/chats` returned **401**, and all **13 fixed GitHub/MCP denial probes** passed
at 21:40 UTC. An initial parallel asset-fetch attempt hit a connection timeout;
the bounded, lower-concurrency retry completed with all hashes matching. No
authenticated browser session was fabricated for these deployment checks.

Follow-up deployment reliability work: check root-disk headroom before image
pulls and manage only unreferenced release-image caches while retaining current
and rollback images. Do not confuse available space on the separate application
data volume with capacity in the controller's image store.

Two-minute process-preserving hibernation remains a separate unfinished feature.
Automatic rollout remains disabled until it preserves running workers. Neither
capability is claimed by this package.
