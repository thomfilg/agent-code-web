# Native-agent integration fixture compatibility

Base: `67d16fd`. This change updates only test doubles and assertions; no runtime admission or snapshot guard changes.

## Baseline and cause

The integrated Node run reported 1,582/1,595 passing. Twelve failures belong to these fixtures (the separate real guest-browser failure is outside this change):

- Eleven `warm-account-admission` cases failed during setup because their native child observer returned `{}`. The current observer contract returns a snapshot with `rootThreadId`; the manager correctly rejected a response without the selected native root. The updated double returns its captured chat's root, not whichever identity happens to be current later.
- The worker-loss callback test emitted `same-thread` without ever establishing that native session on its mock chat. Both callbacks were correctly rejected. The test now uses a Codex adapter double and establishes the root via the real `onSessionId` hook before worker loss.

The reconnect assertion also now follows the explicit child-agent connection contract: reconnecting an account alone cannot implicitly start a child process through `messages`. The test first proves that rejection, then explicitly refreshes the native observer before sending.

## Preserved and strengthened negative assertions

- Failed disconnect and failed Stop persistence still deny warmed main/child/side actions; an unrelated connected account remains usable.
- Account expiry, account replacement, and Stop/interrupt during held compact/goal persistence still prevent native dispatch.
- A retired runtime cannot publish a snapshot even with the correct native root.
- A current runtime cannot publish another root's snapshot; only the current exact runtime and correct root may update it.
- Existing late output, late approval, duplicate fatal notification, transcript retention and queue assertions remain unchanged.

## Terminal validation

Command (serial, two CPUs, reduced priority):

```sh
taskset -c 0,1 nice -n 10 node --test --test-concurrency=1 test/warm-account-admission.test.mjs test/worker-loss-transcript.test.mjs test/agent-threads.test.mjs
```

Terminal exit 0: **47/47 passed**, 0 failed, skipped or cancelled, 9.85 seconds. Local receipt: `/tmp/relay-native-agent-admission-regressions.log` (session 73406). Syntax checks and `git diff --check` also passed. Parent independently reviewed the source delta before execution.

This is focused fixture compatibility validation, not a rerun of the entire integrated suite, native-provider acceptance, cloud verification or deployment. The unrelated RuntimeManager/controller-loss v11 fixture remains frozen and was not executed.
