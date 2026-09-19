# GitHub events and message search integration

This is local candidate validation, not a production rollout or recovery of the
reported stuck Claude chat. On this turn a read-only SSM check of the deployed
controller returned `ambientWorkflowFix: false`; EC2 reported both the controller
and the incident's worker running. No live queue, conversation, process, browser
profile or credential was modified. Deployment/interruption authorization remains
pending.

## Integrated source and review

- PR #77, original `63a584fbf61d6ffda3924fc60f7f25418fddb2e6`, integrated as
  `1762db7`: signed GitHub event hints, explicit per-PR notification/wake consent,
  durable scoped delivery and polling reconciliation. The component's receipt
  records 33 new Node, 35 existing Node and 2 browser cases, plus final screenshot
  recapture. Real webhook setup, cloud wake and selected-agent acceptance remain
  separate gates.
- PR #78, original `3b5463ed23945c1adc6e8d5a7e68043eaf3862fb`, integrated as
  `c8800ad`: owner-scoped literal message search and explicit final-answer
  projections. Component acceptance: 163 compatibility Node cases, 6 browser
  cases and installed Claude with 12 exclusively loopback requests. Legacy or
  unclassified assistant answers remain excluded with an in-product explanation.
- The runtime merge preserves generated GitHub `source`/event identity and sets
  `authorship: user` only for ordinary submissions. Test commit `10d00b4` delivers
  a real fixture event through RuntimeManager and proves it is absent from user
  search; a subsequent ordinary message is searchable with its exact ID.
- Independent final desktop/mobile search screenshots and the corrected mobile
  GitHub checks controls were inspected. Literal markup stays text; cards and
  controls fit their viewports. OpenAI Docs' authoritative item/phase contract
  informed review of the final-only projection; no reasoning index was added.

## Integrated test receipts

- Before search integration: 38/38 Node cases, zero failed/skipped/cancelled,
  8.87 seconds, terminal session `3682`,
  `/tmp/relay-events-integration-node.log`.
- After the runtime merge and cross-feature regression: 30/30 Node cases, zero
  failed/skipped/cancelled, 10.95 seconds, terminal session `67931`,
  `/tmp/relay-events-search-integration-node.log`. Includes event runtime, real
  PostgreSQL event state, search and saved prompts.
- Combined browser run on `10d00b4`: **86/88 passed**, no retries, 3.9 minutes,
  terminal session `59483`, `/tmp/relay-mvp-events-search-browser.log`, artifacts
  `/tmp/relay-mvp-events-search-browser-artifacts`. The two failures are search
  result navigation (old unmounted answer and empty streamed suffix); diagnosis
  and correction remain open. This is not a green combined-browser receipt.
- All 38 cases from the earlier six-file browser readiness gate passed in that
  run (attachments, new chat, pre-chat commands, project preferences, native
  apps and workspace context). Saved prompts, controls, panel resizers, message
  following and the conversation suite also passed. This closes that specific
  earlier fixture-readiness gate, not the two new search failures.
- Full Node revalidation on application `10d00b4`: **1,547/1,547 passed**, zero
  failures/skips/cancellations, 435.94 seconds, terminal session `80194`,
  `/tmp/relay-mvp-events-search-full-node.log`. It enabled the same installed
  native/guest optional checks as the previous full run:

  ```sh
  CODEX_NATIVE_COMPAT_BIN=/home/thomfilg/.nvm/versions/node/v24.14.0/bin/codex \
  AGENT_TEST_NATIVE_GITHUB=1 RELAY_GUEST_UI_TEST=1 \
  taskset -c 0,1 nice -n 10 node --test --test-concurrency=1 test/*.test.mjs
  ```

  Application and test source stayed frozen during this run; only documentation
  changed. The subsequent search browser-fixture/focus correction is not yet
  part of this receipt. Guest MCP work and controller-process-loss acceptance
  remain separate, unintegrated components.

The earlier browser file-readiness failure remains in the prior
[UI integration receipt](validation-2026-09-19-ui-personal-integration.md).
Guest official-browser compatibility and broader native recovery remain open.

## Search live-snapshot correction

The two failing jump fixtures injected messages only into HTTP responses while
leaving the real event stream to deliver the canonical empty history. The trace
showed those requests/connections and the final empty transcript, not SSE payload
bodies; the equal-revision overwrite path was established from source rather
than claiming wire fields that the trace did not retain.

PR #79 (`11cb625279d4ae2573aa3047b38abaa5d83982d6`, integrated as `06b441b`)
makes HTTP and SSE fixture snapshots consistent and adds an exact new-connection
barrier plus an explicit coherent snapshot after navigation. It also fixes the
real accessibility defect identified during review: replacing the transcript DOM
discarded focus on the message article. Nine application lines now restore only
that exact same-chat/message article when focus falls back to the body; nested
tool controls, links and the composer keep their own focus behavior.

Component validation: **7/7 browser cases**, 14.6 seconds, session `66270`, plus
**6/6 explicit repetitions** (two jump cases, three runs each), 15.3 seconds,
session `39619`, all without retries. The new composer-focus case proves a later
snapshot cannot take focus or draft text away from the composer. No separate
red execution of the focus-only assertion is claimed; it was identified by
source review and then verified with the stronger fixture.

The backend was unchanged from the 1,547-test candidate. Full combined browser
revalidation of `06b441b` completed **89/89 passed**, zero retries, 3.3 minutes,
terminal session `30713`, `/tmp/relay-mvp-events-search-browser-final.log`, with
artifacts retained separately at
`/tmp/relay-mvp-events-search-browser-final-artifacts`. All 13 files ran again,
including the seven strengthened search cases and the older six-file readiness
gate. The first 86/88 failure is preserved above, not rewritten as a pass.

No later application change was made before publication to the PR branch;
only this receipt and the requirement ledger changed. This is a locally
validated integration, not a deployed-product acceptance. GitHub webhook
registration, selected-account cloud wake, guest official MCP, remaining native
commands/recovery and production recovery remain open as recorded in the queue.

## Separate test-only recovery evidence

After the application suites completed, PR #80
(`741ae8e1c84b50f4b71f8c17d086c9582df35ab0`) added only a standalone smoke,
two test fixtures and its receipt. Its first execution passed 1/1 in 8.04 seconds
(terminal session `82506`): a committed real native checkpoint survived actual
controller SIGKILL and OCI/rootfs deletion, then was restored by a new process
with an independent database pool. The counted tool remained at one and native
resume made no implicit provider request. Source and receipt received independent
read-only review; the root inspected the exact terminal log, not a production
recovery. No application file changed, so the backend/browser candidate above is
unchanged. See [exact scope and limits](validation-2026-09-19-native-controller-loss.md).
