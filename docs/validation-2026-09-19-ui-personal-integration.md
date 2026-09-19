# Attachment, mobile and personal MCP integration — 2026-09-19

Application candidate: `a091c26`, based on PR 4's `d63d95f`. This integrates
attachment cards/company-local draft drops (PR 72), phone header containment
(PR 73), the official browser proxy prerequisites (PR 68), and the explicitly
shared personal-tab MCP (PR 75). Native-writer/actual OCI recovery receipts
from PRs 70, 71 and 74 are included as separate component evidence; those
scripts were not rerun as part of this application suite.

No production deployment, live-chat interruption, queue mutation, personal
profile access or real provider request occurred during this integration.

## Full Node run and readiness correction

Full Node run: **1,500/1,501 passed**, one failed, zero skipped/cancelled,
528.85 seconds. Session `67985` exited 1. Log:
`/tmp/relay-mvp-ui-personal-full-node.log`.

```sh
CODEX_NATIVE_COMPAT_BIN=/absolute/path/to/installed/codex \
  AGENT_TEST_NATIVE_GITHUB=1 RELAY_GUEST_UI_TEST=1 \
  taskset -c 0,1 nice -n 10 node --test --test-concurrency=1 test/*.test.mjs
```

The failure was in the new actual-extension/official-MCP fixture: it waited
only for the authenticated bridge's hello, then attempted Enable before the
extension's separate availability frame had selected its tab. Production
correctly refused with "Open the Chrome extension and reconnect first".
Test-only commit `279d74c` waits for both existing production prerequisites,
`ready` and `tabSelected`, at initial pairing and reconnect. No admission
rule was relaxed and no automatic action retry was added.

The corrected entire personal-official-MCP file passed **2/2**, zero
skipped/cancelled, 13.78 seconds; session `35052` exited 0. Log:
`/tmp/relay-mvp-personal-readiness-focused.log`.
The full 1,501-test suite has **not** yet been rerun after this test correction;
do not describe the initial full run as green.

The full run includes passing ambient-notification/report-FIFO, native workflow
cancellation, queued input retention, interruption and Stop-race regressions.
Their source defect is consistent with the stuck Claude report, not a proven
reconstruction or recovery of that live session.

## Browser integration and file-read readiness correction

Six complete browser files (attachments, new-chat page, new-chat commands,
project preferences, native apps and workspace context): **37/38 passed**,
one failed, no retries, 2.4 minutes. Session `1794` exited 1. Log:
`/tmp/relay-mvp-ui-personal-browser.log`.

All twelve attachment cases passed. Both original phone-overflow failures
passed unchanged, together with the new full-visibility checks at 320, 390,
430 and 480 px. Attachment desktop/mobile screenshots were visually inspected
on this candidate: one-row previews remain readable with local row scrolling,
and there is no document-level horizontal overflow.

The remaining failure was the existing bare `/ide` fixture selecting text
immediately after clicking a file, before its asynchronous read had replaced
the previous file. The selection helper now waits for the exact expected
file contents and asserts the 16 selected characters. It retains the original
assertion that only the requested range is attached; no product code changed.

The complete corrected workspace-context file passed **5/5**, no retries,
22.9 seconds. Session `11357` exited 0. Log:
`/tmp/relay-mvp-workspace-readiness-focused.log`.
The full six-file selection has **not** yet been rerun after this test fix.

## Open gates

- Full combined suite reruns after the two fixture-readiness corrections.
- Guest official MCP integration and stable schemas when switching browser
  modes; real selected-native-agent acceptance. The personal partition's
  documented restrictions remain in effect.
- Mid-turn/independent-child/native-workflow recovery and deployed acceptance
  are not implied by the completed-checkpoint native/OCI proofs.
- The deployment procedure interrupts active environments, Chrome and app
  servers. User authorization remains pending. Existing stuck workflow state
  is not automatically repaired by changing the code, and no live queued
  message was deleted or replayed.
