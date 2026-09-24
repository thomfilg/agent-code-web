# MVP integration and warm-account admission — September 19, 2026

Integrated application/test source: `8db824728ffdfaf1060ebfb536cdaa5a27a85e6c`.
Verification used the clean detached worktree `/tmp/relay-mvp-integration.9S2lz6`,
not the main working directory's unfinished Settings/browser/hibernation edits.
This is committed local acceptance, **not a new AWS deployment or complete MVP
acceptance**.

## Defect reproduced and corrected

An account disconnection could revoke controller capabilities but fail while
saving the chat's stopped state, leaving an already-authenticated native adapter
available. A minimal reproduction accepted a child-agent message after that
failure. New admission checks now validate the selected account, immutable
owner/provider/account binding and exact active runtime before native dispatch.
Stop invalidates the runtime before awaiting storage, retaining its reference
for cleanup retry rather than silently losing it.

The checks cover warmed main/child/side actions and approvals, native controls,
compact/goal actions, and persistent forks. Gated regressions also cover expiry,
successful Stop, and Composer Stop/Escape during an awaited state write: an old
operation must not dispatch afterward, including when Escape preserves the
same runtime. Unrelated accounts remain usable, and retry/reconnect preserves
the original native session. This does not claim a failed worker shutdown
actually stopped the process; incomplete cleanup still requires retry.

The coordinator and an independent reviewer inspected the final guards and all
12 new regressions. See [the component receipt](validation-2026-09-19-warm-account-admission.md)
and [draft PR #44](https://github.com/thomfilg/agent-code-web/pull/44).

## Full-suite failures were investigated, not suppressed

The initial clean run on `3f52aa6` finished with **1,262 passed, seven failed,
three explicit opt-in skips** (271.6 seconds).

- Six failures used legacy GitHub fixtures without registered companies. Fork
  and imported-history tests now register a company and bind both the saved
  connection and repository selection to it. Its key deliberately differs from
  the GitHub repository owner. Existing scope, cancellation, ownership, cleanup
  and native-history assertions remain intact. All 26 tests in those three
  files passed after correction.
- The remaining GitHub runtime test expected redacted text in the final message,
  which can now be an empty segmented completion marker. It checks visible
  assistant text instead; the full persisted transcript/event secret-leak scan
  is unchanged.

## Final clean integrated verification

All heavy jobs ran sequentially, with two-CPU affinity and nice 10.

```sh
AGENT_TEST_NATIVE_GITHUB=1 RELAY_GUEST_UI_TEST=1 \
  taskset -c 0,1 nice -n 10 node --test --test-concurrency=1 test/*.test.mjs
taskset -c 0,1 nice -n 10 npx playwright test \
  test/browser/agent-accounts.spec.mjs test/browser/side-chat.spec.mjs \
  test/browser/working-status.spec.mjs test/browser/activity-timeline.spec.mjs \
  --workers=1 --retries=0
taskset -c 0,1 nice -n 10 node scripts/smoke-preview-ui-mcp.mjs
```

- **1,286 Node tests passed**, zero failures, cancellations or skips, 274.9 seconds.
  The three normally optional cases were enabled and passed: actual disposable
  Chrome UI through official Playwright MCP, plus installed Codex and Claude
  capability-environment/discovery checks. These use synthetic local services,
  not real provider consent or model inference.
- **25 browser tests passed**, zero retries, 1.2 minutes. Covers all account-card
  scenarios, side-chat isolation, chronological activity, working status,
  Escape/menu behavior and interruption failure recovery. This is not a claim
  that every browser spec in the repository ran.
- The coordinator reran the current-flow preview smoke on the final integrated
  source: schema 2 passed, including inline first submission, unchanged initial
  messages, no preview prompts, cold preparation, HTTP/WebSocket/SSE, revocation
  and confirmed cleanup. `realAwsOrAccountConsent` remains false.
- Git diff confirmed the clean tested application/test sources match `8db8247`;
  no unfinished main-worktree code entered these runs.

## Stronger integration acceptance

- [GitHub gateway receipt](validation-2026-09-19-github-worker-company-smoke.md),
  [draft PR #42](https://github.com/thomfilg/agent-code-web/pull/42): an explicitly
  authorized isolated real GitHub credential passed native Git clone and fetch
  through the actual capability gateway, including encrypted-database/gateway
  restart. Eight real upload-pack requests; stale capabilities, connection
  changes, cross-company selection and unselected Git/PR operations were denied
  before provider forwarding. Read-only transport/API fences prevented external
  writes. This is a local Git subprocess, not a selected deployed agent/EC2 turn.
- [Preview UI acceptance](preview-ui-acceptance.md),
  [draft PR #43](https://github.com/thomfilg/agent-code-web/pull/43): the harness
  now creates a chat through the actual inline company/environment/repository/
  account controls and first-message composer, instead of a direct creation API
  shortcut. A synthetic account and mock adapter replace provider inference.
  Preview setup/open/revoke must preserve that exact initial conversation and
  send no additional prompt. The existing cold-worker preparation, HTTP,
  WebSocket, incremental SSE, cookie isolation, revocation and process-cleanup
  assertions remain. The coordinator inspected desktop inline-chat and 320px
  preparation screenshots; the latter fits without horizontal overflow.

## Publication and remaining gates

The `code-web` AWS operator session was rechecked and remains expired. Public
readiness returned 200; fresh app.js, agent-accounts.js and tool-activity.js bytes
matched previously published `4c45f16`. This does not establish a fresh internal
running-image/worker audit. No deployment, production restart, consent, real model
prompt, acceptance-test provider content write or private Chrome-profile access
was performed. Source commits and review PR updates are separate from those
test-side effects.

Selected-product-account native restart/resume/reconnect, a selected-worker
Linear read, combined deployed GitHub clone/write/PR/restart, and authenticated
deployed preview HTTP/WebSocket acceptance remain open. Existing user-reported
successful sign-in/turns are preserved, not replaced by these fixture results.
The MVP remains unaccepted and PR #4 remains draft. Company-tab Settings,
compact Chrome header, browser-company isolation, hibernation and Claude-doctor
working-tree changes are still excluded; automatic deployment is not enabled.
