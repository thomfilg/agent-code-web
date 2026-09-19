# Inline commentary and actions

Local implementation; not deployed to AWS.

User-visible agent updates now alternate with their actions in chronological order. Consecutive tools form one collapsed inline group. Expanding a group shows its actions; expanding an action shows its input/command, output and exit status. No side-panel navigation is needed. Tool output is inserted as text, never executable HTML.

Runtime changes:

- Persist the emitted commentary before the next tool begins.
- Persist tool starts in their original position and update those records on completion, including out-of-order completion.
- Save only the remaining final response, avoiding duplicated commentary.
- Preserve commentary/action order after reload and native goal continuation.
- Existing saved conversations with no original commentary boundaries are not heuristically rewritten.

UI changes:

- Group only adjacent tools, not every tool in the user turn.
- Preserve both disclosure levels and keyboard focus during streaming rerenders.
- Keep the legacy details panel available internally, but transcript groups expand inline.

Verification commands (synthetic fixtures; no real agent requests or environment interruption):

```sh
node --test --test-concurrency=1 test/activity-timeline.test.mjs test/session-queue.test.mjs test/runtime-manager.test.mjs test/codex-message-boundaries.test.mjs
npx playwright test test/browser/activity-timeline.spec.mjs test/browser/message-boundaries.spec.mjs test/browser/conversation.spec.mjs --grep 'inline activity|agent updates stay|25 tool uses' --workers=1 --retries=0
```

Coverage includes alternating commentary/action groups, late tool completion, persisted history, stream paragraph boundaries, nested output disclosure, escaped output, mobile overflow and open-state/focus preservation.

Final results: 28 Node tests and 3 browser tests passed. Browser retries were disabled. An earlier Node repeat encountered `ENOTEMPTY` in the existing temporary-directory cleanup of the autosleep test; the unchanged rerun passed. No production deployment is claimed.
