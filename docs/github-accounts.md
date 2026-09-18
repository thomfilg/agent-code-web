# GitHub accounts

## Sign in

Open **GitHub connections → Add GitHub connection**. Relay immediately shows
Connecting, then places the code, authorization link and cancel action inside
that connection's card. Open GitHub, enter the code and approve the desired
account. After success, name the connection and explicitly choose its allowed
companies. Nothing is preselected. Choose repositories and that connection
when creating a conversation.

Multiple independent connections are supported. Company edits are revision
checked. Company and user boundaries are enforced in repository listing,
branch selection, cloning and PR/check requests, including secondary
repositories. A missing/revoked/ambiguous connection never borrows another
account's credentials. Reconnect operates on the saved account, not a repeated
creation form; approving another GitHub identity is rejected.

Close/reopen or reload the panel to resume a pending live flow. Cancel, failure
and expiry leave a clear retry action. Restart interrupts pending sign-ins
and asks for a new code; successful credentials remain encrypted and reusable.
Disconnect removes Relay's saved credential/connection, not conversations or
GitHub's own OAuth authorization. Use GitHub settings to revoke at the provider.

## Administrator setup and security

Install GitHub CLI (`gh`, or configure `AGENT_GITHUB_CLI`) on the controller;
outbound HTTPS to GitHub is required. No custom OAuth client ID, token entry,
or server-login import is needed. The global CLI account is never switched.
The native temporary-profile and same-OS-user boundary are documented in
[the ADR](adr/0001-native-github-accounts.md).

## Validation (2026-09-18)

- The installed gh 2.89.0 issued a real device code in 364 ms using a fresh
  isolated profile. The attempt was cancelled without browser consent; its
  private profile was removed. No code or token was printed.
- The user-authorized local-credential smoke passed against owned
  `thomfilg/agent-code-web`: authenticated account and repository listing,
  explicit connection selection, real clone, PR/check reads, encrypted
  PostgreSQL restart, unchanged account binding, and cross-user/company denial.
  No credential appeared in Git configuration; no remote writes were made.
  The temporary database/workspace/profile were removed afterward.
- Run that **test-only**, explicitly authorized read-only check with
  `taskset -c 0,1 nice -n 10 node scripts/smoke-real-github.mjs --allow-local-test-credential --account=thomfilg --repository=thomfilg/agent-code-web`.
  This does not install/import a connection into the live Relay.
- 41 backend regressions passed (native lifecycle, HTTP owner isolation,
  Google login, company scopes, encrypted PostgreSQL, server and shutdown).
  Command: `node --test --test-concurrency=1 test/github-login.test.mjs test/github-login-api.test.mjs test/company-scope.test.mjs test/settings.test.mjs test/google-auth.test.mjs test/server.test.mjs test/server-shutdown.test.mjs`.
- 13 browser scenarios passed with one worker: new GitHub progress/code,
  cancellation/reload, explicit company grants, mobile layout and existing
  company/PR/repository-picker/organization controls. The 390×844 rendered
  connection panel was visually inspected. Command:
  `node node_modules/@playwright/test/cli.js test test/browser/github-login.spec.mjs test/browser/company-scope.spec.mjs test/browser/controls.spec.mjs test/browser/organization.spec.mjs --workers=1`.
- Tests were CPU-limited to cores 0–1 at nice 10. Interactive user consent in
  the deployed product is still required; test credential copying is not
  presented as proof that it happened.
