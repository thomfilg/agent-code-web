# Explicit first-turn Auto — September 20, 2026

## Reported gap

The new-chat composer originally had no permission-mode selection. A later
follow-up exposed the selector but still defaulted every independent draft to
`accept_edits`. The user's reported approval card showed that this remained an
easy way to launch a native process in the wrong initial policy. New chats must
start in Auto unless the user explicitly chooses another mode.

## Integrated behavior

- New chat exposes Auto, Edits and Plan beside the agent/model controls, with
  Auto selected by default in both the browser and server.
- The selected mode is included in the single chat-creation request, validated
  against the selected agent before a chat directory or record is created, and
  persisted with that chat.
- The first turn receives the persisted mode. Claude launches with
  `--permission-mode auto` before native input; it does not rely on a later
  best-effort `set_permission_mode` call. Codex receives `mode: auto` and keeps
  its existing automatic-review policy.
- A mode is local to the unsent chat draft. Creation failures retain it for the
  retry; after successful creation the next independent draft resets to Auto.
  Backend/store/adapter fallbacks also use Auto, so direct API creation and
  legacy records missing a mode cannot silently become Edits.
- Existing active-Claude changes retain their stricter behavior: Relay waits for
  the native acknowledgement, does not restart the process, and does not turn a
  mode change into an allow response for a pending tool.

## Verification

- `test/commands.test.mjs`: omitted mode defaults to Auto on the first turn and
  an unsupported mode creates no chat.
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

The default-Auto follow-up passed 190 focused Node tests and all 5 new-chat
browser cases. The complete Node run passed 1,648 tests with 4 skips; its one
timing-sensitive reconnectable-browser case failed under full-suite load, then
passed both in isolation and in the complete 14-case file. No selected product
account, provider model turn, live approval, credential, worker restart or
production chat was used by these tests.

## Remaining acceptance

This closes the first-turn Edits hard-code. It does **not** claim that the real
provider classifier will allow the user's exact `grep`/environment-inspection
case. That final item-27 acceptance still requires an explicitly selected live
account and observation that the native action completes without a manual
approval card, while Edits and Plan retain their intended behavior.
