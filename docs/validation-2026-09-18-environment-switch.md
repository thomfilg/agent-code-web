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
- These tests use fixtures, not real provider sign-in or paid model prompts.

## Publication

Pending. This local receipt is not a claim of deployment. Dirty hibernation and
Claude-doctor changes are outside this fix and must not enter its release image.
Automatic rollout remains disabled; no worker-preserving handoff or hibernation
capability is claimed here.
