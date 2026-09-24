# Local worker-owned process transport validation — 2026-09-19

Scope: standalone, unwired Linux supervisor/client transport. No default runtime,
SSH launcher, adapter, hibernation policy or production/image configuration was
changed. See [contract and limitations](worker-process-transport.md).

## Evidence

Pinned, serial local run:

```sh
taskset -c 0,1 nice -n 10 node --test --test-concurrency=1 test/worker-process-transport.test.mjs
```

Result: **19 passed, 0 failed**, 6.11 seconds. Synthetic Node children only;
fixtures use disposable private directories and explicitly clean their owned
groups. A separate fixture supervisor stays alive while an actual controller
process exits; the replacement observes the identical child PID, memory sentinel
and counter, replays unacknowledged output, and does not repeat input execution.

A final conservative refinement also blocks new input sequences after a pipe-error
reservation (not just retrying that sequence). Its extended focused case passed
**1/1**, 0.34 seconds, using `--test-name-pattern='pipe-error input reservation'`.

Covered:

- Explicit output commit/replay, expired/ahead cursors, bounded verbose-output
  backpressure and private Unix endpoint modes/ownership/preexisting-file safety.
- Exact input retries, conflicting/expired sequences, explicit EOF, unknown pipe
  outcomes, and per-process blocked-input limits across successive controllers.
- Foreign deployment/owner/chat/worker/provider/account/attempt denial, sanitized
  authorization errors, current-generation fencing, expiry, explicit revocation
  and late previously-approved authorization completion.
- Stop during backpressured input; real TERM-resistant descendants after natural
  leader exit and after TERM-induced leader exit; separate live anchor identity,
  bounded group cleanup, and fail-closed unexpected anchor loss.
- Proven initial anchor spawn failure, retained exit acknowledgement, subsequent
  valid process creation and clean shutdown. Live groups or uncommitted output
  prevent supervisor close.

Independent read-only review identified and then verified fixes for orphaned
same-group descendants, input accumulation across replacement connections, and
no-process spawn failure being misclassified as unconfirmed cleanup. The reviewer
inspected source/test contracts; they did not independently rerun the suite.

Initial development runs are not hidden: the first 11-case suite had a fixture
cleanup race (IPC sent after successful daemon close); the corrected rerun passed
11/11. Group-anchor and failure regressions subsequently passed 18/18 and then
19/19. No actual worker/provider error was involved.

## Not accepted by this receipt

This is not hibernation, rollout continuity or actual native-agent acceptance.
Supervisor crash/restart and OS restart are unsupported; input dedup/spool exist
only in this supervisor's memory lifetime. Worker service/cgroup installation,
escaped process-group cleanup, authenticated remote tunnel, durable coordinator
event/ACK transaction, adapter reconnect, account revalidation, idle admission,
and real Node/Chrome suspend/resume image proof are still required.

No AWS requests, real provider/model calls, credential/session copies, browser
profiles, or production restarts were used. The default remains unchanged.
