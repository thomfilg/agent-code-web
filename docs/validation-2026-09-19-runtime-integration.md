# Runtime integration — 2026-09-19

Frozen candidate: `188282e`, based on application `12028e5`. Application source
is unchanged from `e5b2e4b`; the final commit corrects only test synchronization.
This is local validation and PR integration, **not a production rollout**.

## Included changes

- PR 67: Claude unknown housekeeping telemetry no longer occupies workflow
  report slots. The regression reproduces the reported cancellation error;
  the historical production cause remains unproven. It does not repair an
  already-stuck in-memory tracker.
- PR 66 plus `814dfbb`: preserve accepted assistant output on fatal worker exit;
  explicitly save closed child-agent snapshots with account/lifecycle fencing.
  Snapshot storage failure does not prevent browser/worker cleanup.
- PR 61: worker-owned reconnectable process transport partition.
- PR 64: durable encrypted lease authority, exact scope and commit fencing.
- PR 65: explicitly injected local Shared Chrome link reconnection. Same
  controller process only; no production default or remote/hibernation admission.
- The existing remote-stream fixture now implements browser readiness, and
  verifies only an authorized connection reaches that check.

Each component retains its narrower receipt and independent source-review scope.
No company, credential, personal Chrome profile or live queue was changed.

## Validation

The first full integrated run (`e916e3f`, session `70960`) finished with
**1,457/1,459 passing**, two failures, no skips/cancellations. One exposed the
offline child-agent snapshot regression; the other was the old browser test
double missing `ensureConnected`. Both are corrected in the frozen candidate.
This failed run is not counted as acceptance.

Follow-up focused validation:

- Worker-loss and agent-thread tests: **27/27 passed**, no skips/cancellations,
  5.54 seconds, session `3726`, `/tmp/relay-worker-loss-snapshot-final.log`.
- Authenticated remote-stream fixture: **1/1 passed**, 0.67 seconds. Ownership,
  origin rejection, SSE replay and live-browser WebSocket readiness are covered.

The second full run (`e5b2e4b`, session `83974`) finished **1,462/1,464**,
zero skips/cancellations, 357.47 seconds. Its failures were different:

- Chrome exited during the remote-copy test. The kernel logged Chrome
  `ThreadPoolSingl` receiving signal 11 at 14:08:04, matching the test's Crashpad
  timestamp. This is an actual local WSL2 Chrome crash; missing `cpufreq` files
  in Crashpad diagnostics are not evidence of its cause. No sandbox or other
  security protection was disabled, and the engine root cause remains unknown.
- The transport test inferred pipe pressure from a client promise pending after
  2 ms, although its request might not have reached the supervisor. The final
  test uses a held stdin acknowledgement: explicit termination must complete
  while that acknowledgement remains pending, then further input is denied.
  It does not misrepresent that synthetic gate as physical pipe saturation.

An intermediate focused Chrome/transport run passed **26/26** (session `76807`,
13.73 seconds). Review correctly rejected its preliminary `writableLength`
synchronization as still potentially transient; the held-ack version supersedes
that test change. Independent review accepted the deterministic gate without
running tests.

Final full revalidation of `188282e`, session `97790`: **1,464/1,464 passed**,
zero failed/skipped/cancelled, 376.75 seconds. Command:

```sh
AGENT_TEST_NATIVE_GITHUB=1 RELAY_GUEST_UI_TEST=1 \
  taskset -c 0,1 nice -n 10 node --test --test-concurrency=1 test/*.test.mjs
```

Log: `/tmp/relay-mvp-runtime-integration-node-v3.log`. This complete run includes
the deterministic held-ack case and the real Chrome copy case. The earlier
Chrome crash remains recorded above; a passing run does not explain or fix its
unknown engine cause. Optional native-GitHub and guest-UI checks were enabled.

Browser validation on the unchanged application source, session `99183`:
**40/40 passed**, no retries, 2.4 minutes. Files: `conversation`, `working-status`,
`shared-browser`, `agent-threads`, `activity-timeline`, and `message-boundaries`.
The checks include queue/send-now behavior, interrupt without worker Stop,
preserved drafts on errors, offline agent snapshots, real shared-browser input,
clipboard handling and chronological activity. Logs:
`/tmp/relay-runtime-integration-browser.log`. This is local fixture acceptance,
not recovery of the reported live session.

## Limits and remaining work

- Production remains build `d9c0ce6` / runtime `8db8247`. Applying the correction
  through the available deployment procedure interrupts active environments,
  including their Chrome and development servers. Explicit authorization is
  pending; no restart, recovery mutation or deployment was performed.
- Local reconnection does not establish controller restart, remote process
  service ownership, cgroup containment, native agent reconnection or two-minute
  process-preserving hibernation.
- Process-death fixtures do not establish actual container-deletion safety.
  Native history preservation and selected-account restart acceptance remain
  separate gates; saved Relay transcript text is not a native session backup.
- Separate in-progress native-checkpoint and official browser-MCP policy work
  is not included in this frozen candidate. Personal browser projection is not
  claimed, and no real account action was substituted for user acceptance.

The existing main-worktree AMI/doctor changes remain uncommitted and outside
this integration. The superseded company-UI/hibernation stash is preserved.
