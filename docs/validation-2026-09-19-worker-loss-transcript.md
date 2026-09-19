# Worker-loss transcript checkpoint

Base: `12028e57eab222114b515f76e57bac61b5c44ae7`.
Scope: controller handling of fatal worker exits; no deployment or live-worker
operation. This is part of queue item 41, not completion of that item.

The fatal handler previously discarded its runtime before saving the last
visible assistant chunk. The generation change also prevented the normal turn
finally block from doing that work. The new path fences admission immediately,
drains events already accepted, checkpoints the unpublished response with an
interrupted marker, then cleans up the exact old runtime. Commentary is not
duplicated; late final results and native-agent snapshots cannot overwrite a
replacement runtime. Autonomous goal-turn partial output is retained too.

Gateway access is revoked before any persistence wait. Failed cleanup retains
the revoked runtime and rejects new sends/browser acquisition until an explicit
environment Stop retry succeeds. Browser failure does not skip the worker
cleanup attempt. A failed transcript write is reported as failed, not silently
claimed as saved. Fatal errors pause queued work; the separate Esc behavior
(interrupt and send the next queued message) is unchanged.

## Evidence

Final serial run, pinned to two CPUs:

```sh
taskset -c 0,1 nice -n 10 node --test --test-concurrency=1 \
  test/worker-loss-transcript.test.mjs test/runtime-manager.test.mjs \
  test/preview-activity.test.mjs test/github-worker-runtime.test.mjs \
  test/session-queue.test.mjs test/activity-timeline.test.mjs \
  test/usage-persistence.test.mjs
```

Session `47074`: **57/57 passed**, zero failed/skipped/cancelled, 8.3 seconds.
The new file has 12 cases, including actual external SIGKILL of one disposable
test-owned child process and reload from an independent file-backed ChatStore.
Two chats remain present; reads do not start another worker. Other cases gate
event/metadata/title persistence after native completion, fail and retry browser
and worker cleanup, reject old snapshots, preserve background goal output, and
exercise a failed save without replaying the queue.

Independent review identified cleanup-ownership, post-await publication and
stale-snapshot gaps; these were corrected and received regression coverage.
The reviewer ran no tests. Intermediate runs were not green: the first lacked
generated shared-auth and expected `error` after initialize (which intentionally
normalizes disconnected chats to `stopped`); a later cleanup fixture omitted
`hasViewers`. The build prerequisite and fixture expectations were corrected.

## Remaining acceptance

- No actual container deletion was tested. The local Docker Desktop CLI target
  returned an I/O error and the existing daemon socket did not accept `_ping`.
  External process death is not evidence of container-volume persistence.
- The native Codex resume fallback still needs separate work: saved Relay
  messages do not prove preservation of a missing native journal.
- PostgreSQL/controller-container removal, selected-account restart, application
  process continuity and production acceptance remain open.
- A controller process killed before checkpointing can still lose unpersisted
  streamed text; this change addresses worker failure while its controller runs.
- This does not address the separately reported live Claude workflow-report
  cancellation timeout. No user chat, account, environment or browser profile
  was reset to validate this change.
