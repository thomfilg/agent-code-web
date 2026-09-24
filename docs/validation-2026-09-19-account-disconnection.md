# Named-account disconnection and resume audit — 2026-09-19

Base: `1047a95` (`feat/codex-account-login`). No real model prompt, real OAuth consent, or local Codex/Claude credential copying was used.

## Reproduced defect and correction

Six initial adversarial tests failed on the base: a Disconnect request waiting behind a gated credential refresh, encrypted persistence, or model discovery still admitted the selected named account. Existing deletion had immediate invalidation; disconnect did not.

Disconnect now synchronously establishes an owner-checked barrier before waiting on account locks. Existing workers are revoked in parallel with credential erasure. Late credential/model results are denied, including results whose native-client cleanup is still awaiting completion. Late Claude command metadata cannot repopulate a revoked cache. Concurrent disconnects share the operation; reconnect waits for successful cleanup. The saved account identity and native chat session are preserved.

A separate encrypted `agent-account-disconnection` intent (owner/account ID only) survives failed credential-row erasure or worker stop. Credential erasure also persists `disconnecting` until all cleanup succeeds, retaining the retry state even if the separate intent write fails. Initialization restores admission denial only for an existing matching owner/account. Cleanup removes the intent only after credential erasure and worker revocation succeed. Deletion waits for any outstanding intent write (not the whole disconnect task) before removing the marker; startup ignores foreign-owner and orphan markers. If *all* persistent writes fail, no new intent can be durably recorded: the controller still blocks access in memory and reports failure, but this is not a guarantee across a crash with completely unavailable storage.

The account card exposes `Retry disconnect` for incomplete operations, including after reopening the dialog. Reconnect is shown again only when cleanup succeeds. Native provider errors remain private.

## Verification

Serialized, CPU-limited Node command:

```sh
taskset -c 0,1 nice -n 10 node --test --test-concurrency=1 \
  test/agent-account-disconnection.test.mjs test/agent-accounts.test.mjs \
  test/claude-accounts.test.mjs test/agent-account-deletion.test.mjs \
  test/agent-accounts-api.test.mjs test/codex-account-runtime.test.mjs \
  test/claude-account-runtime.test.mjs test/native-account-binding.test.mjs \
  test/account-secret-runtime.test.mjs
```

- Combined suite: 70/70 passed. Subsequent adversarial review added concurrent delete/disconnect/refresh, delayed intent-write/deletion, and partial intent-write/worker-stop failure cases. The final four account unit files passed 57/57, including all 18 new disconnection cases. Earlier broader runtime/API coverage passed 16/16; together these cover 73 distinct tests. The final intent-ordering correction is unit-verified; full integration rerun is delegated to the coordinating agent before publication.
- Includes a real subprocess fixture turn waiting for native approval: disconnect stops it before a gated refresh finishes; reconnect to the same named identity resumes the saved native session and retains the previous user message.
- Includes both providers' refresh/persistence/model/cleanup races; another owner cannot revoke; failed erase/worker/intent cleanup; restart denial and retry; reconnect/identity isolation; deletion collision; existing credential-output redaction and native binding checks.
- One pre-existing secret-runtime assertion expected text in the last assistant message. Published segmented activity now stores an empty final marker. The assertion now checks nonempty assistant commentary text for the expected redaction while retaining full saved-message/SSE replay secret-denial assertions. This was a test expectation mismatch, not a credential leak.

Browser command:

```sh
taskset -c 0,1 nice -n 10 npx playwright test test/browser/agent-accounts.spec.mjs \
  --grep 'failed disconnect|Claude account card' --workers=1 --retries=0
```

- Final run: 2/2 passed. Retry/reopen/reconnect and existing Claude onboarding/model/reconnect flow covered at 390px.
- Mobile screenshot: Playwright output `agent-accounts-failed-disc-03999--and-survives-dialog-reopen/account-disconnect-retry-mobile.png`.
- Initial mobile rerun attempted to click the off-canvas sidebar button; corrected the test to use the visible Manage accounts control. No production UI bypass or forced click was introduced.
- `git diff --check` passed.

Scope: local account lifecycle and UI correction only. No AWS deployment, change to provider approval policy, or claim of real-provider authentication acceptance is made here. Sibling-worker best-effort revocation is a separate reviewed change.
