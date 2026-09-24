# ADR: delete a named agent account without deleting conversations

Status: accepted for implementation.

## Context

Users need to remove saved personal/company Codex and Claude accounts, not
merely disconnect them. The product must not delete conversations, substitute
another identity, import a host login, or revoke unrelated provider sessions.

## Decision

- Every saved account card offers a separately confirmed **Delete account**.
  Confirmation identifies the account and says that credentials are removed,
  pending authorization cancelled, and bound workers stopped. It explicitly
  says that this does not delete the user's OpenAI/Anthropic account.
- `DELETE /api/agent-accounts/:id` requires the owning Google Relay identity
  and the existing same-origin mutation protection. Foreign IDs return 404.
- Owner-checked in-memory invalidation occurs before waiting for an account's
  async lock. Existing authorization, model and refresh operations cannot
  publish credentials after deletion starts. Queued reconnection fails closed.
- Erasure first durably clears credentials, then deletes the encrypted record.
  Worker revocation runs while the account lock drains. Success is returned
  only after both operations finish. A storage or worker-stop failure is
  sanitized, keeps access blocked, and leaves an owner-only retryable card.
  If all database writes fail, that block is only in the current process:
  deletion has **not** succeeded and must be retried before restarting. Relay
  cannot guarantee durable revocation without a successful database write.
- Conversations, messages, files and the deleted `agentAccountId` reference
  remain untouched. The missing account cannot execute. The user must explicitly
  select a replacement; Relay never automatically picks another saved account.
- This revokes **Relay access**, not the provider's global grant/token family.
  No native logout/global revoke command is run, so unrelated devices/accounts
  are not affected. The user's provider account remains theirs.
- Browser lists are owner-scoped authoritative snapshots. Deleted IDs are
  tombstoned in the current page; delayed login/status/list responses cannot
  reintroduce a removed card or its authorization code.

## Validation

Fixture tests gate deletion against pending native login, verification,
encrypted persistence, refresh and models for both providers. They also cover
another owner, duplicate requests, failed erasure, failed worker stop, restart,
real worker transport shutdown and retained messages/account binding. Browser
tests cover confirmation/dismissal, both providers, unaffected sibling accounts
and delayed GET/list/POST responses. No real provider consent or global token
revocation is performed by these tests.
