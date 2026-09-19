# Parallel workspace / worker startup — 2026-09-19

## Scope

EC2 boot and SSH readiness now overlap controller-side repository preparation.
An explicit `workspaceReady` barrier prevents workspace upload and subsequent
agent admission until cloning succeeds. Existing callers of EC2 `acquire()`
retain its prepared-executor contract; local backends retain clone-first order.
Browser, workspace and agent acquisition continue to share the same lease.

Persisted `chat.startupProgress` includes the overall `startedAt`, executed
`stages`, and optional terminal `finishedAt`. Each fixed-ID stage carries a fixed
label, running/completed/failed status, real start time, and terminal finish
time. Stage IDs are repository, machine, connection, workspace, software, setup,
and agent. Only executed stages appear; parallel running intervals remain
distinct. No provider diagnostics, secrets, setup commands, or fabricated
duration/percentage is written into this snapshot.

Failure waits for both parallel branches before releasing the exact pending
worker. Stop aborts clone work and rejects stale progress callbacks. Clone
cancellation signals the owned detached process group, escalates after two
seconds, and drains its pipes before deleting the partial clone. A failed Stop
persistence write cannot transfer away pending-acquisition cleanup ownership.
A failed machine cleanup retains the blocked lease until explicit Stop retries.
Late software/adapter startup cannot delete, stop, or update a newer generation.

## Verification

Focused command (two CPUs, serial):

```
taskset -c 0,1 nice -n 10 node --test --test-concurrency=1 \
  test/parallel-worker-startup.test.mjs test/worker-wake.test.mjs \
  test/ec2-backend.test.mjs test/runtime-manager.test.mjs \
  test/store-workspace.test.mjs test/warm-account-admission.test.mjs
```

Final result: **64/64 tests passed**, with no failures/skips, including 14 new manager/progress regressions
and two new EC2 barrier regressions. Coverage includes simultaneous stages,
join-before-upload, browser/agent deduplication, both failure directions, Stop,
delete, Stop persistence failure, failed cleanup retry, old-generation software
and adapter completion, software/setup/agent timing, no extra prompts, restart
persistence, and a real synthetic Git descendant surviving its parent until
process-group escalation. Existing account-admission guards are included.

An initial wake test assumed acquisition had already begun immediately on
admission; it now waits for that asynchronous event after progress persistence.
New test scaffolding also needed an explicit gateway origin to reach adapter
startup. These were fixture corrections, not relaxed security checks.

All AWS/GitHub/provider operations are fakes; Git clone uses an isolated fixture
executable and never contacts a remote. No cloud action, real model prompt,
deployment, or interruption of the user's active worker was performed. No live
latency improvement is claimed: the tests prove overlapping work and ordering.
