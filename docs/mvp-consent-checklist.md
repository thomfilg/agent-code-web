# MVP consent and execution handoff

Current UI instructions checked against published runtime `4c45f16` on September
19, 2026. The pending company-tab Settings redesign is not assumed published.
No item below is marked complete by fixture tests, an operator's CLI login or
an isolated copied-credential test.
Record results separately for local Relay and AWS; they do not share accounts
or conversations. Do not import host logins, copy cookies or disable access
checks to pass a gate.

Latest user-reported AWS results (2026-09-18): Google login and both Codex/Claude
connections work. At 14:45 UTC the user also confirmed a Personal Codex/Luna chat
and supplied its deployed response screenshot under `12-apps/future-pay`.
Later user screenshots also show Claude responses and tool use. Do not ask to
repeat successful consent merely because historical checklist rows below remain
granular. Account reload/revocation, selected-account native restart/resume,
selected-worker GitHub operations and authenticated preview remain separate gates.
The company migration verified existing Linear with 79 tools and an authenticated
controller workspace read, bound exclusively to g2i. A read through the selected
agent/worker is still separate. See the [company publication receipt](validation-2026-09-18-company-chat.md).

## 1. Google cloud sign-in

Observed on 2026-09-18 at 09:59 UTC with official Playwright MCP: the deployed
button reached `accounts.google.com`, which returned **Error 400:
redirect_uri_mismatch**. This historical blocker was subsequently resolved by
the user's callback registration and reported successful AWS login. Do not
re-register or reset a working configuration based on that old receipt.
The reviewed [repeatable probe](deployed-login-probe.md) confirmed the same
result at 10:10 UTC and can recheck provider initiation after configuration;
it never completes account consent.

- [ ] Operator: confirm `AGENT_WEB_PUBLIC_URL` is
  `https://d20atclccf8cku.cloudfront.net`, the Google client's JavaScript origin
  matches it, and its registered redirect URI is exactly
  `https://d20atclccf8cku.cloudfront.net/api/auth/callback/google`.
  Keep localhost configuration separate. Confirm the intended email is allowed
  by Relay and, if applicable, Google's test-user list; never widen the allowlist
  merely to get a successful test.
- [ ] If already signed in, inspect the current account and reload; do not sign
  out just to repeat consent. Otherwise, open that AWS origin → **Continue with Google** → select the intended
  Google identity. Expected: return to the same HTTPS origin, correct Relay user,
  and the user's own data after reload. A separate signed-out browser must still
  be denied access to private APIs. Local sign-in is not cloud callback evidence.

## 2. Named Codex and Claude accounts

Repeat separately for each intended personal/company identity:

- [ ] Inspect existing **Agent accounts** first; do not reconnect a working
  account just to test onboarding. For a missing account: **＋ Add agent account**
  → choose **Codex** or **Claude Code**, enter **Account name** → **Sign in**.
  Agent accounts have no company/project assignment step. All connected accounts
  owned by the Relay user are available across that user's projects.
  Expected: immediate connecting progress, then the link inside that named card.
- [ ] Codex: **Open Codex sign-in** and enter that card's one-time code on the
  provider page. Claude: **Open Claude sign-in**, authorize the intended
  subscription/workspace, paste the complete returned `code#state` into
  **Code returned by Claude** in the same card → **Complete sign-in**.
  Never paste codes into a chat, screenshot or issue.
- [ ] Return to Relay: the same card must show **Connected** with the intended
  identity, including after reload. Provider approval alone is insufficient.
  On expiry/failure use that card's **Reconnect**; use a new named account to
  switch identities. Do not substitute another account or repeat model prompts
  to diagnose sign-in.

## 3. GitHub identity and exact repository

- [ ] **Companies** contains **g2i** and **thomfilg + 12-apps**; the latter is
  one Relay company spanning two repository owners. Do not recreate them.
  **GitHub** → choose the company and inspect its existing connection. Only for
  a missing connection: **＋ Add GitHub connection** →
  **Open GitHub sign-in**. User enters the displayed code and approves the
  intended GitHub identity. Expected: **Signed in as …** on its own card.
- [ ] Repositories permitted by that company's connected GitHub account become
  available without an additional organization allowlist, including saved connections.
  A display-name change is optional. There is no PAT-entry, server-login import
  or second organization authorization form in Relay.
- [ ] Inline **New chat** → choose the company's environment → compact `+`
  repository strip: find the intended repository,
  verify the connection name shown alongside it, select its branch, and confirm
  its selected connection determines the intended company. A chat cannot mix
  companies; repository-owner names are not Relay company identities. Repository/branch listing
  is a provider read; it does not prove clone, push or PR access from an AWS worker.

## 4. Linear consent and environment selection

- [ ] **MCP connections** → choose the company → **Linear** card → its details.
  Inspect the existing g2i connection first; do not duplicate its credentials or
  grant it to the combined company. For a new independent connection, give the
  connection a distinct name, select its company, leave **Linear permissions**
  at **Read only** → **Save connection** → **Connect with OAuth**. User approves
  the intended Linear workspace. If the popup is blocked, use **Open sign-in
  window**. Normal Linear registration needs no manually supplied client secret.
- [ ] **Verify Linear workspace** (may run automatically after OAuth completes).
  Expected: **Connected**, **OAuth signed in**, and **Authenticated workspace read
  verified** with a check time. This calls `list_teams` with `limit: 1`; tool
  discovery or a saved configuration alone is not success. Workspace content is
  not stored in the verification receipt. Confirm the intended workspace during
  provider consent; a generic Connected label alone does not identify it.
- [ ] **Environments** → choose the intended company's environment and inspect
  **Company tools**. Company MCPs load automatically: there is no extra MCP
  checkbox to select. For independent workspaces, use separate connections;
  never reuse another company's authorization. Changes apply on the next worker
  start, not to an already-running worker.

## 5. No-model checks versus separately authorized execution

The steps above save Relay configuration and OAuth grants, but do not require
model prompts or provider content changes. Operator: record the deployed revision
and image digest before AWS execution; do not assume a pending build is active.
For an old chat with incomplete saved GitHub selection, reselect the repository
and connection in a new chat; reconnecting alone does not repair that binding.
Afterward:

- [ ] In inline **New chat**, choose the combined
  `provider · account name · identity` selector, exact repository/connection and
  matching environment. Inspect the model choices and preserve any draft.
  Opening this page/selecting options does not send a prompt. The first message
  creates and starts the chat; there is no empty-message **Create chat** step.
  The last explicit agent-account choice is remembered per primary repository.
- [ ] Only after authorization for the target deployment, named account, exact
  prompt and quota: send the approved minimal prompt, verify the final answer,
  intended account binding and selected repository clone. Use a validation
  environment with reviewed setup scripts and no queued work or automatic
  external mutations. This starts a worker and can incur AWS/model cost.
  The existing one-off approval for Codex **Personal**, “Responda apenas OK”, is
  not blanket permission for Claude, other accounts or repeated tests.
- [ ] After an operator-coordinated idle **Stop worker** and **Wake environment**,
  reload the same saved chat
  and confirm its account/repository/environment binding and transcript persist.
  Proving native conversation resume requires another explicitly authorized turn;
  simply reopening the page does not establish resume. Wake sends no prompt.
  Composer **Stop/Escape** only interrupts the turn and submits the next queued
  message if one exists; it is not a worker-restart test.
- [ ] A read-only Linear tool call through that selected worker/environment is
  a separate runtime gate from the controller's verification button. If performed
  through an agent prompt, obtain model-use authorization first. GitHub PR/check
  reads must likewise use the selected product connection. Push/PR creation or
  editing and Linear issue writes require separate exact-target authorization;
  do not create synthetic external records merely to complete this checklist.
- [ ] Verify **Open app** in the selected AWS chat: authenticated HTTP and
  WebSocket/HMR traffic, plus isolation from unrelated chats. Public readiness
  and anonymous rejection are not authenticated app-traffic evidence.

## Evidence and stopping rules

Record only: deployment/build, time, gate, private account/connection alias or
record ID, chosen company/repository/environment, observed status, sanitized
failure category and whether a prompt/write was authorized. Crop/redact codes,
URLs containing OAuth state, tokens, cookies and private workspace content from
evidence. A failed or ambiguous submitted operation must be inspected before
retrying; never silently switch credentials.

An expired operator AWS session blocks internal AWS inspection/publication, not
local development and not necessarily application health. On September 19,
`code-web` reported expired credentials while public readiness returned 200.
No restart, account reset or production write was attempted for this check.

Isolated native Claude turns, copied-host GitHub reads/pushes/PRs, synthetic
Google callbacks and browser fixtures remain separate evidence. They do not
complete these product-consent gates. Deployed protected transports, combined
selected-account AWS execution and other release requirements remain tracked in
the [feature queue](feature-queue.md); this checklist does not declare the MVP done.

UI/route reference: [Google configuration](google-login.md),
[provider onboarding](provider-onboarding.md), `public/agent-accounts.js`,
`public/github-accounts.js`, `public/mcp-settings.js`,
`public/workspace-settings.js`, `src/google-auth.mjs` and `src/server.mjs`.
The MCP OAuth callback is `/oauth/mcp/callback`, distinct from Google's callback.
