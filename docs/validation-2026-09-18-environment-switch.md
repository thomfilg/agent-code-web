# Environment switching — 2026-09-18

## Report and cause

The new-chat environment dropdown showed only `thomfilg + 12-apps`, although
`g2i` was registered and active in environment settings. `renderEnvironments()`
filtered its options using the remembered primary repository's company. That
made the environment needed to change companies impossible to select. An empty
draft also hid environments that did not allow unassigned chats.

A browser regression reproduced the original defect before the fix: the option
list contained the personal environments but omitted `g2i`.

## Change and boundaries

- List every active environment owned by the current user, including environments
  for another company and those requiring a repository. Archived ones stay out.
- An explicit environment change removes only incompatible repository selections
  from the unsent draft, resets repository search, and explains the change. It
  preserves the message, compatible repositories, branches and account selection
  behavior. Existing chats, workspaces and saved connection scopes are untouched.
- Filter company-tagged repository results by the selected environment as well
  as the primary company's boundary. Legacy responses lacking a company ID keep
  their display behavior; they do not bypass admission validation.
- A scoped environment can be selected and remembered before adding a repository.
  Explain the required choice and reject Send until the selection is compatible,
  both on the button and in payload validation. This never grants unassigned
  access or weakens the server's company/owner checks.
- Saving a non-archived environment in settings applies the same draft-selection
  transition. Merely opening settings does not change the chosen environment.

## Local evidence

- 40 Node tests passed: workspace settings, companies, company scope, settings
  persistence and Google ownership. Includes compatible branches, unsent-message
  retention and denial of mismatched/archived/unassigned draft submissions.
- 11 browser tests passed without retries in the final run: environment switching,
  inline new-chat behavior, scoped environment settings, reload persistence,
  320px layout and creation failure handling. The first broader run had two
  bootstrap failures; retained traces showed `net::ERR_NETWORK_CHANGED` before
  the application initialized, not a failed environment-switch assertion.
- Mobile screenshot inspected: compact chips and the composer fit 320px.
- Four account browser regressions also passed without retries: Claude sign-in,
  account onboarding, remembered per-project account choice and repository
  loading/error recovery. No environment warning disables the account selector.
- Repeated acceptance in a clean detached release worktree at `83b391c` passed
  all 40 Node cases and five browser cases (the four environment cases plus
  startup ordering), without retries. Its first Node attempt lacked the normal
  generated shared-auth bundle; running the repository's build-auth step fixed
  test setup. No source or test assertion was changed to address that setup error.
- The real preferences endpoint accepts and reloads an empty scoped draft;
  the real chat endpoint still returns 403 for that draft and creates no chat.
- These tests use fixtures, not real provider sign-in or paid model prompts.

## Publication

Published and independently verified on 2026-09-18 at **22:51 UTC**.

- Runtime source: `83b391c923d4c20cc27c76e38fb5264f5927b6ab`, built from clean
  detached worktree `/tmp/relay-environment-release.RbPjLP`. Only the two public
  runtime files differ from the previously deployed source. Dirty hibernation
  and Claude-doctor changes were not included.
- CodeBuild `ImageBuild-t8BSbSkDsHYX:7afc4371-e1cb-4c68-b603-da3e65b90cee`
  succeeded using immutable source version `Yf_blg_CDbf8ulMOlYeWEZq8T0m1gb_1`.
  Image: `456808212788.dkr.ecr.us-east-2.amazonaws.com/agent-relay-mvp-applicationrepository-sujdgarjwejp@sha256:32452c44d89c4164753d4b43921415e44d0f57196cec44ca13a11ee571b1763f`.
- Read-only preflight SSM `4d64d34d-f2bc-47d7-84dd-1b0c20108c28` verified the
  prior image and 15,219,625,984 free root bytes before publishing.
- Manual pinned-engine rollout SSM `e21dd91e-e917-44fa-8dd2-4218db1977f8`
  completed successfully and passed readiness. The previous application image
  remains the rollback candidate. The deployment-owned worker inventory was
  empty immediately before submission and after completion; no worker was
  interrupted, created or deleted by this update.
- Independent SSM `a2c6f3ac-ef51-411f-a887-2bc21cc783ca` returned Success/0 and
  confirmed the running container's exact immutable image above.
- The public `index.html` and `workspace-settings.js` SHA-256 values matched the
  release files at 22:51:26 UTC. Public readiness returned 200 and anonymous
  `/api/chats` returned 401. All 13 fixed GitHub/MCP denial probes passed.
- No production data migration, connection-scope edit, chat deletion, new OAuth
  consent or model prompt was performed. Authenticated UI behavior was tested
  with local fixtures, not by impersonating the user's production session.

Automatic rollout remains disabled. Worker-preserving handoff and two-minute
hibernation remain separate unfinished work, not capabilities of this fix.
