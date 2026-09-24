# Native checkpoint integration — 2026-09-19

Frozen application candidate: `0b8c77b`, PR 69 (`0e394d4`) applied on top of
`f3819f1`. This extends the [runtime integration receipt](validation-2026-09-19-runtime-integration.md).
It is local validation, not a production deployment or recovery of the stuck
Claude session.

The integrated Codex change retains scoped, encrypted native journal prefixes,
restores only a fresh private worker profile, and requires an existing saved
thread ID to resume exactly. It never silently starts an empty thread after a
resume failure. See [behavior and limits](codex-native-session-checkpoints.md).

## Validation

Focused integration: **43/43 passed**, zero failed/skipped/cancelled, 13.40
seconds. Log: `/tmp/relay-native-checkpoint-integration-focused.log`. The
author's separate eight-file 44-test receipt includes the named-account runtime
case; the two selections are not interchangeable counts.

Full Node integration: **1,485/1,485 passed**, zero failed/skipped/cancelled,
377.50 seconds. Log: `/tmp/relay-native-checkpoint-full-node.log`. The recorded
process session was `1387`; its completed log includes the final Node test
summary. Command:

```sh
CODEX_NATIVE_COMPAT_BIN=/absolute/path/to/installed/codex \
  AGENT_TEST_NATIVE_GITHUB=1 RELAY_GUEST_UI_TEST=1 \
  taskset -c 0,1 nice -n 10 node --test --test-concurrency=1 test/*.test.mjs
```

The installed native CLI was Codex 0.155.0. Its compatibility test performs
read/resume against a synthetic journal in a disposable private profile, with
no new turn or real provider request. PostgreSQL cases use an actual disposable
database. No cookies, account credential files, personal browser profiles or
live worker state are copied or changed by these checks.

The preceding 40-test browser receipt belongs to the earlier runtime candidate;
it is not represented as a new browser run of this candidate. This checkpoint
partition changes no public UI files.

## Not established by this receipt

- Actual native-writer flush ordering and recovery after actual container
  deletion, rather than synthetic journals or process death.
- Zero-loss recovery during an abruptly interrupted turn, full independent
  native child-session preservation, or automatic safe replay of side effects.
- Production recovery of the reported Claude workflow tracker or queued
  messages. Applying the available deployment still requires authorization
  because it interrupts active environments, Chrome and development servers.

Those gates remain open. Separate native-writer, attachment UI and personal
browser-MCP work is not included in this frozen application candidate.
