# Codex message boundaries

Implemented and verified locally; not published to AWS.

The adapter previously appended every `item/agentMessage/delta` in a turn to one string, ignoring `itemId`. Consecutive commentary messages therefore appeared as `verification.Shared Chrome` in both streamed and saved text.

The adapter now distinguishes native agent-message items and inserts a paragraph boundary between nonempty messages. Token chunks within one item remain untouched. Completed-only messages are retained once, repeated completion events do not duplicate output, and goal continuation resets the boundary tracking. Secret redaction uses its fail-closed boundary operation before switching items. Internal reasoning events remain excluded.

Protocol reference used through OpenAI Docs: https://developers.openai.com/pt-BR/docs/app-server#eventos (item lifecycle and deltas).

Validation:

- 17 Node tests passed across `codex-message-boundaries`, `adapters`, and `codex-account-runtime`.
- One Playwright test passed with no retry: separate visible paragraphs during streaming, at completion, and after page reload; positive visual spacing; no browser errors.
- Persistence test reopens the chat store and verifies the saved paragraphs.
- No real provider prompts, approvals, credential changes, or deployment were performed.

This corrects newly received output. Previously concatenated records were not rewritten: their lost boundaries cannot safely be reconstructed by punctuation heuristics.
