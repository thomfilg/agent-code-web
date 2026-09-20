# Explicit first-turn Auto — September 20, 2026

## Reported gap

The new-chat composer had no permission-mode selection. Every new chat was
persisted as `accept_edits`, so a user could select Auto only after the chat and
worker lifecycle already existed. This did not invalidate the acknowledged live
Claude mode-switch path, but it made the first turn structurally incapable of
starting in the user's explicit Auto selection.

## Integrated behavior

- New chat exposes Auto, Edits and Plan beside the agent/model controls.
- The selected mode is included in the single chat-creation request, validated
  against the selected agent before a chat directory or record is created, and
  persisted with that chat.
- The first turn receives the persisted mode. Claude launches with
  `--permission-mode auto` before native input; it does not rely on a later
  best-effort `set_permission_mode` call. Codex receives `mode: auto` and keeps
  its existing automatic-review policy.
- A mode is local to the unsent chat draft. Creation failures retain it for the
  retry; after successful creation the next independent new-chat draft resets
  to Edits rather than silently inheriting Auto or Plan.
- Existing active-Claude changes retain their stricter behavior: Relay waits for
  the native acknowledgement, does not restart the process, and does not turn a
  mode change into an allow response for a pending tool.

## Verification

- `test/commands.test.mjs`: explicit Auto persists into the first turn and an
  unsupported mode creates no chat.
- `test/claude-session.test.mjs`: the first Claude launch carries native Auto
  before input; active Manual-to-Auto still uses the acknowledged native control
  without approving a pending Bash request.
- `test/browser/new-chat-page.spec.mjs`: the actual composer sends Auto, renders
  the created chat as Auto, preserves retry behavior and still fits at 320 px.
- Focused related Node run: **75/75 passed**.
- Complete Claude session run: **111/111 passed**.
- Focused browser run: **5/5 passed**, zero retries.
- Complete integrated Node regression: **1,601 passed, 0 failed, 4 skipped**
  (**1,605 total**).
- The HTTP account/API file changed after the complete runner had already loaded
  its prior version; its final version was therefore repeated separately:
  **7/7 passed**. The final browser file was also repeated: **5/5 passed**.

No selected product account, provider model turn, live approval, credential,
worker restart or production chat was used by these tests.

## Remaining acceptance

This closes the first-turn Edits hard-code. It does **not** claim that the real
provider classifier will allow the user's exact `grep`/environment-inspection
case. That final item-27 acceptance still requires an explicitly selected live
account and observation that the native action completes without a manual
approval card, while Edits and Plan retain their intended behavior.
