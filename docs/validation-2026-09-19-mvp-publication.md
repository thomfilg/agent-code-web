# MVP safety follow-up publication — September 19, 2026

The user renewed the `code-web` operator session. Target identity, stable stack,
controller image/readiness and scoped EC2 worker state were rechecked before
publication. The clean committed release was built and manually deployed;
unfinished main-worktree edits were not included.

## Published source and immutable image

- Application/test source: `8db824728ffdfaf1060ebfb536cdaa5a27a85e6c`.
- Build source (documentation-only delta): `d9c0ce67f2a2807d539cae2151db75eca8ae509b`.
- CodeBuild: `ImageBuild-t8BSbSkDsHYX:11afbc40-6403-4744-a337-ee8fb5f74ce5`, SUCCEEDED.
- Exact uploaded source version: `xogZQ_FEZQUdvldx1IX9OMxknVyL9fvg`.
- Image: `456808212788.dkr.ecr.us-east-2.amazonaws.com/agent-relay-mvp-applicationrepository-sujdgarjwejp@sha256:9957447175cfbc028943954347aef0463084fce6dd0dd4102122d410398b3833`.
- Manual rollout: SSM `85eb4c42-00a2-4e50-80ee-a3524393475b`, Success / 0,
  completed at **2026-09-19 13:03:29 UTC** (10:03 Sao Paulo).
- Independent image/source verification: SSM
  `2e6a97db-67a6-44cb-9d98-e8fcc3bca903`, Success / 0, completed at
  **13:04:46 UTC**. Running image matched the exact digest and local readiness
  returned 200.
- Public application: https://d20atclccf8cku.cloudfront.net .

Published changes include account-disconnection intent/retry handling, attempts
to stop every bound worker despite sibling failures, protection against
deployment during incomplete cleanup, current company-MCP OAuth guidance, and
the warmed-runtime account/Stop/Escape admission corrections. Tests and operator
acceptance harness improvements are recorded in the source receipts; they are
not additional user-facing features.

## Independent verification

The preflight SSM command `dc31c1d4-87d0-4610-8026-e399bfddfe71` independently
observed the old `4c45f16` image digest, a running container and readiness 200.
The only scoped worker, `i-0bdd4bb50c3010e47`, was already **stopped**. It was
checked again immediately before rollout and remained stopped afterward. No
running worker was interrupted, and no worker, volume or conversation was
deleted. No company/connection migration was performed.

The final independent command SHA-256-matched these in-container source files
to the clean release:

- `src/runtime-manager.mjs`
- `src/agent-accounts.mjs`
- `src/server.mjs`
- `src/mcp-oauth.mjs`
- `public/agent-accounts.js`

Public readiness returned 200, anonymous `/api/chats` returned 401, and these
public assets matched the release bytes:

| Asset | SHA-256 |
| --- | --- |
| agent-accounts.js | 3fb96540571dbc0bec8487b3384e3c5f2abac5c83a59d104f88663cb3eeb1e42 |
| app.js | b8e4878edb197cfb32743a93064eb9dcb5cd50a9706404ad178360ba0082757e |
| index.html | ffa69d8979de223836e747a89e84efa5be3aebdacdc14a8a1b6132e45f56111a |

All **13 deployed GitHub/MCP denial probes passed** at 13:04:48 UTC. They verify
fixed rejection behavior without real provider operations, account imports or
model prompts. They do not establish authenticated worker/provider execution.

Prepublication verification was **1,286 Node tests passed, zero failures/skips**,
**25 browser tests passed without retries**, and a passing integrated current-flow
preview smoke. These runs occurred before deployment; they were not rerun as
real authenticated production-account tests. See the
[full integration receipt](validation-2026-09-19-mvp-integration.md).

## Remaining MVP acceptance

Renewal and publication remove the AWS operator-credential blocker; they do not
complete the MVP. Selected-product-account native restart/resume/reconnect,
selected-worker Linear execution, combined deployed GitHub write/PR/restart,
and authenticated deployed app HTTP/WebSocket acceptance remain open.

Read-only source inspection confirmed that the Linear settings verification
button executes the workspace read on the controller. A saved connection,
successful controller read or native tool discovery is not evidence of an
actual selected-worker `list_teams` execution. No browser session was fabricated,
no capability was extracted, and no real prompt or provider content write was
submitted by this publication. A user-triggered read-only tool call in the g2i
chat was requested separately; its result must be inspected before closing that
gate.

Company-tab Settings/sidebar, compact browser header, browser-company isolation,
hibernation and Claude-doctor changes remain uncommitted/excluded. Automatic
rollout remains disabled and PR #4 remains draft. User browser profiles were
not accessed, copied, reset or deleted.
