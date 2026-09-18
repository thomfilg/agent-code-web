# Named Claude accounts

Implementation for the Claude part of MVP queue 43/44. This document is an
implementation/validation record, not a claim of deployed user consent.
See [the authentication ADR](adr/2026-09-18-claude-named-account-authentication.md).

## User flow

1. Sign into Relay with Google and open **Agent accounts**.
2. Choose **Add agent account**, select **Claude**, give the account a name and
   choose its allowed companies (or explicitly allow unassigned chats).
3. **Sign in to Claude** immediately shows a starting state. The authorization
   link appears inside that named account's card, not below unrelated accounts.
4. Open the link, authorize the intended Claude account/workspace, and paste the
   complete returned code into that card. **Complete sign-in** checks it and
   reports verification progress. Codes are password inputs and are cleared
   after submission; there is no persistent code preview/history.
5. Choose that connected account when creating/switching a Claude chat. Models
   come from its native profile. Other users' accounts and disallowed companies
   are rejected by the backend, not just hidden by the dropdown.
6. **Cancel sign-in** stops a pending ceremony. **Disconnect** removes stored
   credentials and stops bound runtimes. **Reconnect** starts the same saved
   account directly, without a second account form. A different Claude user or
   workspace requires a different named account.

An unfinished sign-in expires after ten minutes or a controller restart.
Native startup, wrong code/state, expired/revoked credentials and identity
mismatch show credential-free messages. No host login or API-key entry is
offered. A subscription/account permitted to use Claude Code is still required.

## Boundary and persistence

Account credentials use the same encrypted controller record store as Codex.
Metadata responses contain no access/refresh token. Every credential request
rechecks the Relay owner, selected account, provider and primary-repository
company. Controller profile and token endpoints are fixed HTTPS destinations
with redirects disabled; project environment variables cannot override the
selected account with another API key, OAuth token or custom Anthropic host.

The native worker has a private per-chat home and receives access-only bearer
credentials. Renewals run on the controller; native refresh control messages
are answered privately and omitted from approvals/history. Disconnect blocks
new credentials before workers are stopped. Renewed credentials are identity
checked before delivery; rotated refresh credentials are checkpointed under the
same encrypted record so a subsequent temporary profile outage cannot lose
them. A network/5xx/429 failure is retryable without disconnecting a previously
verified account, but delivers no unverified bearer. Revocation/identity mismatch
requires reconnect. Cancellation also invalidates an in-flight verification
immediately and rolls back a provisional credential commit before publication.
No browser connection,
Google login, or developer host login implies Claude authentication.

Local workers still share the controller's filesystem: do not use that mode as
a hostile-tenant security boundary. Use isolated cloud workers for untrusted
users. Temporary validation credential copies are test fixtures only and are
not an onboarding feature.

## Reproducible verification

Use the repository's Node dependencies and compiled shared-auth module. Keep
tests to one worker/two CPUs on this workstation:

```sh
node scripts/build-auth.mjs
taskset -c 0,1 nice -n 10 node --test --test-concurrency=1 test/agent-accounts.test.mjs test/agent-accounts-api.test.mjs test/claude-account-client.test.mjs test/claude-accounts.test.mjs test/claude-account-runtime.test.mjs test/claude-requests.test.mjs test/claude-session.test.mjs test/claude-fast.test.mjs test/claude-workspace-trust.test.mjs
taskset -c 0,1 nice -n 10 node node_modules/@playwright/test/cli.js test --config playwright.accounts.config.mjs
taskset -c 0,1 nice -n 10 node scripts/smoke-real-claude-account.mjs
```

The native smoke requires Linux user/network namespaces, `ip`, and the installed
Claude binary. It uses a private network namespace with loopback only, fake
credentials, a bounded fixture HTTP server and no model quota. It drives the
actual CLI through an initial 401, SDK renewal, response, stop and same-journal
resume. No developer credentials or external consent are used by this script.

Evidence recorded on 2026-09-18:

- The complete backend suite initially passed **640/640** and the security-fix
  rerun passed **649/649**, with zero skipped tests, including native Chrome and
  PostgreSQL regression coverage. The final targeted rerun passed **41/41** and
  covers the late old-ceremony failure and streamed-transport-error additions
  made afterward.
- 148 focused backend tests passed (both providers, ownership/scope, encrypted
  persistence, cancellation/restart/reconnect, account-bound API/runtime/models,
  access-only delivery, refresh-channel redaction and legacy Claude regressions).
- 14 account/Google browser checks passed with one worker, including mobile
  Claude manual-code errors/retry, per-card ceremony, native account models,
  disconnect/reconnect and cancel. A 390px screenshot was visually inspected.
  All 14 passed again after the cancellation/rotation corrections.
- Native Claude Code 2.1.222 loopback smoke passed: one private renewal, three
  fixture inference requests, same-session resume, no approval/credential leak.
- Real native login startup produced the allowlisted URL/manual-code prompt and
  was cancelled without consent. An explicitly authorized isolated credential
  copy validated the real OAuth profile and four native model choices. A real
  refresh exchange preserved both user and organization identity and rotated
  access; the host credential file was not changed, logged out or revoked.
- Two explicitly authorized real minimal Haiku turns returned `OK`. Tools,
  hooks and MCPs were disabled. Stopping/restarting the private adapter resumed
  the same native session and verified the same account/organization. The
  worker had no refresh credential file; the original host credential file's
  checksum was unchanged. Only the test's private temporary files were removed.

Independent review found cancellation-during-verification/persistence and
refresh-rotation-followed-by-profile-outage races. Both were reproduced with
five failing gated regression cases before fixing them. Additional checks cover
foreign-owner cancellation, rotated-but-revoked/wrong-identity access, restart
retry and safe temporary errors over the private renewal channel. Independent
review accepted these corrections and the integration branch includes them. No live Relay
controller was restarted or production account imported by this feature task.

A follow-up review also reproduced a queued-replacement race: an old attempt's
cancel could run after a newer begin acquired the account lock. Cancellation is
now bound to the captured flow/revision; whole-account disconnect still cancels
any replacement. Both orderings have gated regression tests.

Named-account deletion is now implemented separately from disconnect, for both
Claude and Codex; see the [deletion ADR](adr/2026-09-18-named-agent-account-deletion.md).
The follow-up focused suite passed **44/44** checks, including gated concurrent
operations, safe storage/worker-stop retry and real worker-transport shutdown
without deleting conversations or silently replacing their account binding.
The account/Google browser suite passed **19/19**, including deletion of both
providers, confirmation dismissal, an unaffected sibling account, stale
GET/list/POST suppression and retry after a simulated storage failure.

Pending release acceptance (not counted as completed browser consent): deploy
the integrated build, have the user finish this named Claude account's browser
authorization, send a consented turn, restart/resume that deployed chat, and
confirm revoked-access/reconnect behavior. Automated browser fixtures and a
developer's authorized credential copy do not replace this gate.
