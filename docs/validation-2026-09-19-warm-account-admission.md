# Warm native account admission — 2026-09-19

## Reproduced bypass

On integrated base `3f52aa6`, `RuntimeManager.stop()` revoked gateway grants, then awaited chat persistence before detaching/stopping the warmed native adapter. A failure of that write left the native RPC authenticated and reusable. `agentThreadAction(messages/respond)` reused that adapter without selected-account admission, unlike cold startup and ordinary model validation.

A no-CLI, counter-only adapter reproduced: stop failed, selected account was revoked, native child message was accepted, send count was one, adapter stop count was zero, and account selection had run only at startup. No real model prompt, provider call, credential copy, or AWS operation was involved.

## Correction

- Check owner/provider/current account state synchronously at warmed native dispatch boundaries. Disconnecting, removed, expired, pending and foreign accounts cannot dispatch new work.
- Bind each runtime to its captured owner/provider/named-account ID. A changed selection cannot reuse the previous identity's adapter, even when both accounts are connected.
- Mark a stopping runtime revoked before asynchronous persistence. Keep its reference so retry can still clean up the original adapter; do not falsely claim a failed stop killed the process.
- Main replies, native child messages/replies, side-chat input/replies, compact/goal controls, native forks and native mutation callbacks recheck admission after asynchronous preparation. Check captured runtime identity where a removed/replaced runtime could otherwise leave a stale local reference.
- Compact/goal persistence gates also honor Composer interruption: cancelled turn/generation/runtime cannot issue a delayed native operation. Normal dispatch checks the same invariants immediately before invoking the adapter.
- Other connected accounts remain usable. Successful retry cleanup followed by same-identity reconnect retains the saved session.

## Tests

```sh
taskset -c 0,1 nice -n 10 node --test --test-concurrency=1 \
  test/warm-account-admission.test.mjs test/agent-accounts-api.test.mjs \
  test/agent-account-disconnection.test.mjs test/side-chats.test.mjs \
  test/agent-threads.test.mjs test/fork-chats.test.mjs \
  test/runtime-manager.test.mjs test/session-queue.test.mjs
```

Focused suite: **81/81 passed**, before adding the final two Composer-interruption variants. Final new regression file: **12/12 passed**, including those variants and the earlier gates (83 distinct tests across these runs).

Coverage includes failed disconnect with preserved warm adapter, child messages/approval denial, main approval denial, side input/reply denial, stale credential callback rejection, unaffected second account, successful cleanup/reconnect, account-binding change, explicit Claude warmed turn/reply denial, compact/goal expiry and full-stop/interruption races, and native fork account change during target creation.

The first focused run was 77/78: the old fork fixture waited for an invalid unregistered-company configuration. The coordinating agent's existing fixture fix `39b0556` was cherry-picked as `ff2ef8b`; rerun passed. That fixture repair is already integrated upstream, not new feature work in this change.

`git diff --check` and Node syntax validation passed. Full integrated verification is coordinated by the parent agent before publication. Existing stop retry behavior remains necessary if worker/process shutdown itself fails; this fix denies additional native work rather than claiming such a process was killed.
