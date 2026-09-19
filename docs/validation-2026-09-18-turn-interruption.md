# Turn interruption and working indicator

Published in runtime `4c45f16`; see the [verified AWS publication](validation-2026-09-19-chat-activity-publication.md). The verification below records the earlier local checkpoint.

## Requested behavior

- Composer Stop and Escape interrupt the current native turn, not the worker.
- When a message is already queued, the next FIFO message is submitted immediately. Remaining messages retain their order and existing queue policy.
- Without queued input, the turn ends and the composer remains usable.
- Native session, original user message, emitted partial answer, worker, Chrome and background services are retained. Normal idle policy remains separate.
- Explicit **Stop worker** remains the full environment shutdown action.
- A compact composer line shows Working / Starting, elapsed time, Escape guidance and the count of current-turn active tools.

## Verification

- 22 Node tests: `test/session-queue.test.mjs` + `test/runtime-manager.test.mjs` passed.
- 17 Node tests: `test/session-queue.test.mjs` + `test/working-status.test.mjs` passed (overlaps the previous run; 24 distinct tests total).
- 2 browser tests: `test/browser/working-status.spec.mjs` passed on the final run without retries.
- Browser assertions cover an advancing timer, active-tool count, Escape interruption, draft preservation, unlocked controls after failure, and never calling the full-worker stop route.
- Early browser runs exposed an Escape guard matching unrelated expanded sections. The guard now only considers visible dialogs, control menus and interactive side panels.
- Fixtures only. No live provider approval, model prompt or AWS worker interruption was performed for this validation.

Other uncommitted company-settings/browser-layout changes are separate work in progress and have not been validated or deployed by these tests.
