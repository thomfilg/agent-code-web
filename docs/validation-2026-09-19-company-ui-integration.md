# Company settings and composer integration — 2026-09-19

Application/integration source checkpoint: `007d62071da059b52d23f0c2812ac057fac333a9`.

This checkpoint combines the company Settings hub, compact Shared Chrome header,
company-bound browser connections, company/project selection memory, new-chat
slash commands, hidden title metadata, single-company environments and explicit
Claude Ultracode. It also
includes the explicitly unavailable hibernation lifecycle foundation; that is
not working hibernation and does not enable a production policy.

## Integration details

- Company tabs own the GitHub, MCP, environment and browser cards. Agent accounts
  remain separate. Delayed child-editor loads cannot reopen a closed Settings
  dialog or replace a newer destination.
- Environment assignment is exactly one registered company. Legacy ambiguous
  records remain preserved and require explicit review; protected values never
  become agent-readable during assignment. Names are unique within a company.
  Hub summaries exclude unresolved environments rather than advertising them in
  multiple companies. Inherited company context is locked in scoped editors.
- New chats restore the complete allowed repository/branch/account/model/effort
  selection by company and primary project, without copying messages or files.
  Slash completion and explicit first-command dispatch work before chat creation.
  An empty repository draft retains its selected agent but cannot send into a
  company without choosing a repository.
- Reserved standalone title lines are hidden in streamed and saved responses,
  including after tools and after a manual rename. Literal code/prose examples
  remain visible; manual names remain authoritative.
- Shared Chrome uses a compact navigation/header and an overflow tools menu.
  Company-bound profile pairing does not import or reset saved browser profiles.
- Claude Ultracode is a separate per-chat boolean plus xhigh effort, not a new
  numeric effort level. Actual worker readback must confirm native workflow state
  before input. Ordinary xhigh stays separate, explicit disable is verified, and
  company/project preference snapshots exclude this opt-in. Native MCP mutation
  and `/code-review` combinations remain explicitly unsupported; real selected
  account/worker workflow acceptance is not claimed.

The integration found an actual null-versus-undefined company comparison that
discarded the remembered agent for a repository-less draft. The source now
normalizes that comparison; the new regression also proves sending stays blocked.
Other observed browser failures were test-lifecycle issues: hash-only fixture
navigation did not bootstrap a second chat, an evaluated bubble could detach
during refresh, and polling route handlers outlived context teardown. The fixture
now loads a unique document route, measures the current attached bubble and drains
handlers before cleanup. Assertions for context retention, queue behavior and
HTML isolation remain intact.

## Verification

The combined browser run before Ultracode integration passed **76/76**, without
retries, in 1.7 minutes:

```sh
taskset -c 0,1 nice -n 10 npx playwright test \
  test/browser/company-hub.spec.mjs test/browser/company-settings.spec.mjs \
  test/browser/company-scope.spec.mjs test/browser/environment-selection.spec.mjs \
  test/browser/project-chat-preferences.spec.mjs test/browser/new-chat-commands.spec.mjs \
  test/browser/browser-connections.spec.mjs test/browser/github-login.spec.mjs \
  test/browser/conversation.spec.mjs test/browser/vim.spec.mjs \
  --workers=1 --retries=0
```

Earlier integration attempts had 65/73 and 74/76 passing cases. They are not
reported as successful runs; the final complete run followed the corrections
above. Desktop/mobile Settings and the 390px environment editor were visually
inspected, including visible Save and long-form scrolling.

The expanded post-Ultracode browser attempt passed **154/157**. Two effort-control
tests still expected the old model payload; ordinary Claude effort now explicitly
includes `ultracode: false`, and the exact-payload assertions were updated. The
third failure observed the last typed character missing from the fixture's HTTP
telemetry before clipboard actions. It does **not** establish a product keystroke
loss: the fixture allows independent input-report POSTs to race, but that possible
cause has not been confirmed for this occurrence. The test now first verifies
the actual text copied from the remote page and then the telemetry, retaining
both assertions; it also waits for its exact chat before browser interaction.
All three affected cases passed three consecutive focused repetitions (**9/9**,
no retries, 15.1 seconds). This is not a claim that an intermittent product input
defect was diagnosed or repaired. The expanded full rerun is recorded separately
after its terminal result: **157/157 passed**, no retries, in 3.0 minutes. It adds
`shared-browser`, `claude-ultracode`, `claude-model-picker`, `claude-commands`,
`model-controls`, `activity-timeline`, `working-status` and `tab-title` specs to
the command above. Independent read-only review accepted the integration and
the later exact-payload/clipboard assertion adjustments.

The dedicated hermetic Linear configuration passed **4/4** browser cases without
retries in 14.5 seconds after the single-company fixture update. Discovery,
registration, consent and tools remain on the isolated loopback fixture.

The first full Node run passed **1,376/1,379** with zero skips. Its failures were
two old Chrome navigation paths (the now-collapsed tools menu and the removed
sidebar Browser connections button), plus a GitHub refresh unit fixture whose
DOM stub lacked the company-context fields. These fixtures were updated to use
the real current controls, retaining sandbox, login-preservation, exact-pixel,
cross-user isolation and superseded-load assertions. This failed run is not
counted as successful full verification.

Ultracode's component check passed **212/212 Node + 3/3 browser** cases before
integration; independent source review covered the merged preference guards.
The second complete Node attempt passed **1,395/1,396**, zero skips. The remaining
personal-Chrome fixture returned a pre-company GitHub status shape; its mock now
includes the actual API's `connections` array. A first focused rerun then exposed
an incorrect test selector for the new `<summary>` tools control (not a button).
After correcting that selector, **11/11 focused cases** passed, including actual
extension pairing, consent/revocation, viewport pixels, saved login persistence
across Chrome/controller restart and superseded settings loads. These failed
attempts are retained here rather than folded into a green total.
The final complete integrated Node run passed **1,396/1,396**, zero failures,
skips or cancellations, in 278.1 seconds. It enabled the installed-native GitHub
and disposable-Chrome checks, using `AGENT_TEST_NATIVE_GITHUB=1` and
`RELAY_GUEST_UI_TEST=1`, pinned to two CPUs with serial test-file execution.
Component counts overlap and must not be added to these totals.

The standalone preview smoke now waits for the account email in the avatar's
`title` rather than obsolete visible email text. Its first two executions failed
before worker acquisition: splitting the fixed phases identified an obsolete
`textbox` locator after slash completion gave the composer a `combobox` role.
After that harness-only correction, the official MCP execution passed with
cleanup confirmed. The real fixture UI/API path covered inline company chat
creation, selected account/repository/environment, mock first message, cold
preview preparation, HTTP/WebSocket/incremental SSE, original path/query/fragment,
cookie/referrer isolation and revocation closing streams and child processes.
No actual cloud or provider account was used. The full Node/browser suites above
preceded these final standalone-driver changes; application source did not
change afterward.

A read-only audit also found the old `smoke-account-ux-mcp.mjs` depended
on the removed creation modal and multi-company environment controls. Its
separately reviewed migration (component `c73ce40`, draft PR #63) is now included:
the official MCP harness passed with synthetic OIDC/provider accounts, owner
denials, two single-company GitHub/environment bindings, cross-company agent
selection, mixed-company/provider denials, 320/390/1600px layouts and inline
local-command-only chat creation. Worker acquisition/adapter/prompt tripwires
stayed at zero. This is fixture acceptance, not real-provider consent.

## Safety and remaining delivery

The Linear browser fixture is isolated from the real provider. The earlier
wrong-configuration discovery/registration incident, evidence limits and new
network/configuration guards are recorded in the
[Linear fixture receipt](validation-2026-09-19-linear-browser-config.md).

Saving an environment variable still applies at the next worker start. Existing
running agents are not silently restarted or given live updates. Protected
variables are never injected; agent-readable values require explicit selection.
The user's denied `env | sort` screenshot is an Auto-classifier denial, not proof
that a particular variable was absent.

No live worker, account binding, browser profile, company record or deployment
was changed by these tests. Production remains the separately recorded build
`d9c0ce6`; this checkpoint is not authenticated deployed-product acceptance.
Selected-account restart/reconnect, coordinated Linear restart verification,
combined GitHub worker write/PR/restart, authenticated preview HTTP/WebSocket,
and the remaining ordered delivery acceptance gates stay open.

Standalone transport and image-verifier partitions remain separate draft PRs
#61 and #62, not enabled product capabilities or part of this UI candidate.

Two-minute process-preserving hibernation and worker-preserving automatic rollout
remain unimplemented end-to-end. The foundation rejects unavailable opt-in
admission and prevents destructive idle fallback; transport/image coordination
is still required. Automatic deployment stays disabled. Claude Ultracode still
needs real-account workflow acceptance and its unsupported special-command
combinations; no claim of full native feature acceptance is made.
Git/dependency caches and pre-prepared environments remain explicitly post-MVP.

## Worktree preservation

Before integration into the user's branch, overlapping earlier company-UI and
experimental backend WIP was saved recoverably in named stash
`3c1810861598f02a09daa2da29de8da4f7ba8009`. It was not reapplied over the reviewed
implementations. Earlier stashes `d0b38699e81a296680acc49a68b0e3c5b74af9a0` and
`5bf4e477feccee6aa5bf243832d443fbd848988e` remain available. Separate verifier and
Claude-doctor edits were left untouched in the main worktree. No worktree edits
were discarded and no browser authentication state was included in those stashes.
