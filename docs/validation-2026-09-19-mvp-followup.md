# Integrated MVP follow-up — September 19, 2026

Tested application/test sources: `28fed2d`, identical to clean detached worktree
commit `9f1ffb7` (verified by Git diff). This follow-up is committed source, **not
a new AWS publication**.

## Corrections

- Named Codex/Claude disconnection blocks new admission and late credential,
  model and command-catalog publication immediately, including native cleanup
  races. Worker revocation proceeds while account locks drain.
- Encrypted disconnection intent and a credential-free intermediate account
  status preserve blocked/retry behavior across partial storage/worker failure
  and restart. Owner identity is verified on restore. Concurrent deletion waits
  for the intent write, not the entire disconnection task, preventing orphaned
  markers without deadlocking. Completely unavailable persistent storage cannot
  record new durable intent; the request fails and access remains blocked in
  the current process rather than falsely reporting success.
- The UI exposes Retry disconnect instead of an unusable Reconnect action while
  cleanup is incomplete. Conversations and native account binding remain intact.
- Account revocation attempts every matching worker shutdown, even if an earlier
  stop throws/rejects. Other owners/accounts are untouched; partial failure is
  reported without private diagnostic output.
- Deployment drain refuses incomplete account disconnection/deletion even after
  the failed HTTP request has ended. Both new regressions reproduced 200 instead
  of the required 409 before the guard. After retry clears the barrier, drain can
  succeed. This prevents the normal rollout/rollback path from switching to an
  older runtime that does not understand a pending disconnection intent. It is
  not protection against manually bypassing the deployment engine.
- OAuth success guidance now matches automatic company MCP selection. GitHub
  and actual native MCP smoke checks now exercise registered-company paths,
  not just the legacy unassigned configuration.
- The MVP handoff checklist now describes the current published inline chat,
  combined agent selector, company-owned GitHub and automatically selected MCPs.

## Independent integration verification

All heavy tests ran serially, CPUs 0–1, nice 10. The clean worktree excludes the
pending company-tab Settings/browser-header, browser-company, hibernation and
Claude-doctor edits from the main working directory.

```sh
node scripts/build-auth.mjs
taskset -c 0,1 nice -n 10 node --test --test-concurrency=1 \
  test/readiness.test.mjs test/agent-account-disconnection.test.mjs \
  test/agent-accounts.test.mjs test/agent-account-deletion.test.mjs \
  test/claude-accounts.test.mjs test/agent-accounts-api.test.mjs \
  test/account-secret-runtime.test.mjs test/codex-account-runtime.test.mjs \
  test/claude-account-runtime.test.mjs test/github-real-smoke.test.mjs \
  test/companies.test.mjs test/github-login.test.mjs test/linear-mcp.test.mjs \
  test/mcp-oauth.test.mjs test/mcp-connections.test.mjs test/worker-capabilities.test.mjs
taskset -c 0,1 nice -n 10 node --test --test-concurrency=1 test/native-account-binding.test.mjs
taskset -c 0,1 nice -n 10 npx playwright test test/browser/agent-accounts.spec.mjs --workers=1 --retries=0
```

- Combined Node run: **141 passed**, zero failures/skips/cancellations, 21.7s.
- Separate native account-binding regression: **1 passed** (142 distinct Node
  tests in this checkpoint, not a full-repository-suite claim).
- Entire account browser file: **19 passed**, zero retries, 1.2 minutes. Includes
  both providers, sign-in/cancel/reconnect/delete, draft and remembered-selection
  behavior, late-response races and failed-disconnect retry.
- Coordinator visually inspected the 390px retry-state screenshot; message and
  both available actions fit without horizontal overflow.
- Git diff confirmed tested sources identical to the integrated commit;
  whitespace checks passed. Original unrelated dirty files remain intact.

Separate component evidence (overlaps integration coverage, do not sum totals):

- [Real read-only GitHub smoke](validation-2026-09-19-github-company-smoke.md):
  authorized isolated thomfilg credential, actual selected clone and PR/check
  reads, encrypted restart and company/user denials. No remote content writes.
- [Installed Codex/Claude MCP discovery](validation-2026-09-19-company-linear-native.md):
  loopback-only synthetic OAuth, company tools, private capability environment,
  foreign/revoked denial. Deterministic SDK workspace reads are not model calls.
- [Account race receipt](validation-2026-09-19-account-disconnection.md) and
  [sibling-worker failure receipt](validation-2026-09-19-account-worker-revocation.md).

## Publication and remaining gates

The operator AWS session classified as **credentials-expired**; public readiness
returned 200. Fresh public app.js, agent-accounts.js, index.html and
tool-activity.js bytes matched the previous `4c45f16` release. Without renewed
STS access no fresh internal image/worker inspection or publication was attempted.
Previous deployment identity remains historical evidence, not a new image audit.

Real selected-product-account restart/resume, live selected-worker Linear read,
combined GitHub worker/write/PR flow and authenticated deployed app HTTP/WS
acceptance remain open. No real model prompt or new OAuth consent was submitted.
No user Chrome profile was accessed, copied, reset or deleted. The goal remains
active and PR #4 remains draft; local fixture success does not complete the MVP.
