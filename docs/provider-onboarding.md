# MVP provider onboarding and remaining consent

The current local application is `http://localhost:8787`. The separate AWS
application is `https://d20atclccf8cku.cloudfront.net`; it does not import local
conversations or accounts. The integrated login flows are implemented, but
passing fixture tests does not complete real-provider consent or execution.

## First: Google identifies the Relay user

For AWS, register this exact redirect URI in the existing Google OAuth client:

`https://d20atclccf8cku.cloudfront.net/api/auth/callback/google`

Its JavaScript origin is `https://d20atclccf8cku.cloudfront.net`. Keep the existing
localhost entries if local access is still needed. Sign in with an email that
the administrator explicitly allowed. Do not send a password, client secret,
authorization code or access token in a chat.

## Connect each provider separately

| Provider | User action | What still establishes real acceptance |
| --- | --- | --- |
| Codex | Open **Agent accounts** → **＋ Add agent account**, choose **Codex**, name it, choose allowed companies (or **Unassigned chats**) and select **Sign in to Codex**. Open the link inside that account's card and enter its one-time code on the provider's page | Connected identity, explicitly selected account, authorized minimal real turn and same chat/account resumed after restart |
| Claude | Open **Agent accounts** → **＋ Add agent account**, choose **Claude Code**, name it, choose allowed companies (or **Unassigned chats**) and select **Sign in to Claude**. Authorize through that card's link, then paste the complete returned code into that same card and select **Complete sign-in** | Connected identity, explicitly selected account, real turn and native resume; the isolated host-account test is not product consent |
| GitHub | Open **Connect GitHub** / the saved GitHub connection panel, add a connection, then open its provider link and enter the displayed code. Choose the companies allowed to use the connected account | Repository list, selected repository clone and PR/check read using this connection, without another connection or host fallback |
| Linear | Open **MCP connections**, choose the Linear preset, name it and choose its company. Keep read-only permissions unless write access is wanted; select **Save connection**, then **Connect with OAuth** and **Verify Linear workspace** | A real authenticated workspace read, followed by selecting the connection in the matching environment and using that environment on a worker |

For independent Linear workspaces, create separate connections, such as g2i
and 12-apps. A saved connection must also be selected in **Environments**;
company access must agree on both records. Changes apply at the next worker
start. Normal Linear sign-in uses dynamic client registration; do not supply
another application's client credentials to work around a failed attempt.

For personal and company Codex/Claude identities, add separate named accounts.
Reconnect retains the old identity and company scope; it is not an account
switch. Delete removes the selected saved account without deleting its
conversations. Never choose another account silently when a selected one fails.

## Current operator gates

- Local restart preserved all 12 encrypted records and the credential file.
  Personal and umg remain disconnected; they need fresh consent. No credentials
  were restored from an older checkpoint.
- The user authorized one minimal Codex Personal prompt, “Responda apenas OK”.
  Consent must succeed before sending it; do not extend this into an automatic
  quota-consuming test suite.
- AWS readiness, anonymous-access denial, encrypted cold backup/restore and
  controlled failed-rollout recovery passed. Fresh-worker/native and protected
  browser/stream acceptance remain separately tracked in the
  [feature queue](feature-queue.md).
- The recent 28 browser fixtures and official Playwright MCP screenshots
  verify account-scoped UX, not the user's external authorization.
- A future fresh Doppler CLI download may need repository-scoped sign-in again.
  The running local server retains the already-loaded settings; no replacement
  token is needed merely to keep it running.

Keep the MVP open until the applicable real-account and deployed-runtime gates
pass. Do not weaken Google access or import operator accounts to bypass consent.
