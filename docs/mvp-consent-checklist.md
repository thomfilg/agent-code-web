# MVP consent handoff

Use this checklist when the user returns. No item below is marked complete by
fixture tests, an operator's CLI login or an isolated copied-credential test.
Record results separately for local Relay and AWS; they do not share accounts
or conversations. Do not import host logins, copy cookies or disable access
checks to pass a gate.

## 1. Google cloud sign-in

- [ ] Operator: confirm `AGENT_WEB_PUBLIC_URL` is
  `https://d20atclccf8cku.cloudfront.net`, the Google client's JavaScript origin
  matches it, and its registered redirect URI is exactly
  `https://d20atclccf8cku.cloudfront.net/api/auth/callback/google`.
  Keep localhost configuration separate. Confirm the intended email is allowed
  by Relay and, if applicable, Google's test-user list; never widen the allowlist
  merely to get a successful test.
- [ ] User: open that AWS origin → **Continue with Google** → select the intended
  Google identity. Expected: return to the same HTTPS origin, correct Relay user,
  and the user's own data after reload. A separate signed-out browser must still
  be denied access to private APIs. Local sign-in is not cloud callback evidence.

## 2. Named Codex and Claude accounts

Repeat separately for each intended personal/company identity:

- [ ] **Agent accounts** → **＋ Add agent account** → choose **Codex** or
  **Claude Code**, enter **Account name**, select allowed companies (or
  **Unassigned chats**) → **Sign in to Codex** / **Sign in to Claude**.
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

- [ ] **Connect GitHub** (or **GitHub · …**) → **＋ Add GitHub connection** →
  **Open GitHub sign-in**. User enters the displayed code and approves the
  intended GitHub identity. Expected: **Signed in as …** on its own card.
- [ ] **Company access** (also opened after successful consent): set a meaningful
  **Connection name**, check only the intended companies → **Save company access**.
  There is no PAT-entry or server-login-import step.
- [ ] **New chat** → **Choose repositories**: find the intended repository,
  verify the connection name shown alongside it, select its branch, and confirm
  the first repository determines the intended company. Repository/branch listing
  is a provider read; it does not prove clone, push or PR access from an AWS worker.

## 4. Linear consent and environment selection

- [ ] **MCP connections** → **Add a development tool** → **Linear**. Give the
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
- [ ] **Environments** → choose/create the intended environment, allow the same
  company, check that exact connection under **MCP connections** → **Save
  environment**. For independent workspaces, repeat with separate connections;
  never reuse another company's authorization. Changes apply on the next worker
  start, not to an already-running worker.

## 5. No-model checks versus separately authorized execution

The steps above save Relay configuration and OAuth grants, but do not require
model prompts or provider content changes. Operator: record the deployed revision
and image digest before AWS execution; do not assume a pending build is active.
For an old chat with incomplete saved GitHub selection, reselect the repository
and connection in a new chat; reconnecting alone does not repair that binding.
Afterward:

- [ ] In **New chat**, explicitly select the provider and named **Codex account**
  / **Claude account**, exact repository/connection and matching **Environment**.
  Inspect the model choices. Leave **What would you like to work on?** empty.
  **Create chat** saves a chat/selection without sending a prompt; its repository
  clone is deferred until the worker starts. Cancel instead for no new chat.
- [ ] Only after authorization for the target deployment, named account, exact
  prompt and quota: send the approved minimal prompt, verify the final answer,
  intended account binding and selected repository clone. Use a validation
  environment with reviewed setup scripts and no queued work or automatic
  external mutations. This starts a worker and can incur AWS/model cost.
  The existing one-off approval for Codex **Personal**, “Responda apenas OK”, is
  not blanket permission for Claude, other accounts or repeated tests.
- [ ] After an operator-coordinated idle stop/restart, reload the same saved chat
  and confirm its account/repository/environment binding and transcript persist.
  Proving native conversation resume requires another explicitly authorized turn;
  simply reopening the page does not establish resume.
- [ ] A read-only Linear tool call through that selected worker/environment is
  a separate runtime gate from the controller's verification button. If performed
  through an agent prompt, obtain model-use authorization first. GitHub PR/check
  reads must likewise use the selected product connection. Push/PR creation or
  editing and Linear issue writes require separate exact-target authorization;
  do not create synthetic external records merely to complete this checklist.

## Evidence and stopping rules

Record only: deployment/build, time, gate, private account/connection alias or
record ID, chosen company/repository/environment, observed status, sanitized
failure category and whether a prompt/write was authorized. Crop/redact codes,
URLs containing OAuth state, tokens, cookies and private workspace content from
evidence. A failed or ambiguous submitted operation must be inspected before
retrying; never silently switch credentials.

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
