# Account revocation stops every matching worker (2026-09-19)

The server's `AgentAccounts.onRevoke` callback previously awaited matching chat
shutdowns sequentially. A failure in the first shutdown aborted the loop, so
later chats using that same owner's revoked account were never stopped.

The callback now snapshots the same owner/account-filtered set and waits for
all stop attempts to settle. Every selected chat gets exactly one attempt per
callback, including when another stop throws synchronously. Any failure yields
a sanitized aggregate 503 rather than reporting successful revocation cleanup
or exposing private worker diagnostics. Account admission is already blocked by
the caller before these shutdowns begin. Chat messages and bindings are retained.

Regression tests exercise the actual authenticated server endpoint for both
disconnect and delete, with three matching chats: one synchronous stop failure,
one asynchronous rejection, and one successful stop. They assert all three
attempts, no duplicate attempt, no stop of another owner's chat or another
account's chat, blocked credential access, retained chat bindings, a failing
HTTP response and sanitized retry instructions. The assertions accept the
account layer's more general sanitized failure message as well as the server
callback's aggregate summary.

```sh
taskset -c 0,1 nice -n 10 node --test --test-concurrency=1 test/agent-accounts-api.test.mjs test/agent-account-deletion.test.mjs
git diff --check
```

The API/deletion suite passed **20/20** tests with no failures or skips. All
accounts, chat records, Google sign-in and native responses were fixtures.
No production worker was interrupted, no real account was disconnected, and no
production deployment was performed for this change.
