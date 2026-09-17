# User-owned Codex accounts

This feature uses the native Codex app-server account protocol, not a server
operator's CLI login or a shared OpenAI API key. Google signs the user in to
Relay; each user must separately connect their own Codex accounts.

## Requirements and sign-in

- Enable and configure Google login as described in [google-login.md](google-login.md).
- Install a Codex CLI supporting `chatgptDeviceCode`, `chatgptAuthTokens` and
  `cli_auth_credentials_store="ephemeral"`. The transport was checked against
  installed **0.154.0**. External-token login is an experimental app-server API;
  recheck the transport when upgrading the CLI.
- Device-code sign-in must be allowed in the user's ChatGPT security settings
  and, where applicable, by their workspace administrator.

Open **Agent accounts** and select **+ Add Codex account** to expand the form.
Name the account (for example Personal or Company), choose its allowed companies,
and select **Sign in to Codex**. The button immediately shows **Connecting…**
while the native client prepares the sign-in link. The form cannot be submitted
again during this request. Collapsing an unsent form preserves its draft.

Each pending account displays its own OpenAI link, one-time code, Copy and
Cancel controls **inside that account's card**. Open the link and enter that
card's code. Closing/reopening the panel restores pending sign-in details
automatically, including a link that was still being prepared. Relay stays
pending until the native client confirms completion and the controller verifies
the saved identity. Codes expire after ten minutes; closing the panel does not
authorize anything. An interrupted server login must be restarted with
**Reconnect** on the affected account.

Choose the account explicitly when creating a chat. Existing chats expose an
account button next to the agent picker: open it and select **Use in this chat**.
Changing accounts retains messages and workspace files but starts a new native
agent session. Native conversation forks retain the selected account; transcript
copies do not inherit its credentials or account binding.

Reconnecting an existing named account must return to the same Codex user **and**
workspace. Add a separate account for another identity. A disconnected, expired
or wrong-company account cannot fall back to another account or the host login.
Google-mode administrators follow the same rule as every other user.

## Storage and isolation

Named accounts are encrypted PostgreSQL `agent-account` records. Each record is
owned by the Google-backed Relay user; IDs alone do not grant access. Browser
responses contain names, scopes and status, never OAuth tokens. Device codes and
their URLs are transient and visible only to that user.

The controller runs native login/renewal in a temporary mode-0700 profile with a
mode-0600 credential file, then removes that profile. The durable refresh and ID
tokens remain encrypted in the database. Workers receive only that account's
access token through their private RPC channel and use ephemeral credential
storage. Access tokens are still credentials: they exist in worker process
memory. They are not environment variables, command arguments or `auth.json`
files. Renewal uses the original user/workspace binding and never appears as a
permission-approval prompt.

Disconnect deletes the saved credential payload and stops this account's Relay
workers without deleting conversations. It does **not** claim to revoke all
OpenAI sessions or invalidate a copied access token upstream. Provider-side
revocation remains available through the provider's own security controls.

Local workers share the controller's OS user and filesystem: private directories
are not a strong boundary against an untrusted same-user process. Use isolated
cloud workers for mutually untrusted users. This feature alone does not certify
the unfinished AWS deployment as production-ready.

## Verification and remaining release gate

Automated checks cover separate users and companies, multiple named accounts,
failed/cancelled/expired consent, restart, account-selection UI, worker renewal,
disconnection and rejection of changed identities. Browser tests use an offline
consent fixture; they do not authorize a real account or send a model prompt.

The installed 0.154.0 app-server accepted an injected **fictitious** access token,
reported the account, and logged out without creating `auth.json`. This was a
protocol/storage check with zero real credentials and zero model turns, not
evidence that a user's paid account can execute a request.

An additional network-connected check used that same installed CLI and the
production controller client to request a real device-code URL/code in an empty
private profile, then cancel it immediately. `account/read` remained unsigned-in,
no `auth.json` was created, and the temporary profile was removed. This verifies
native code issuance and cancellation, not successful user consent or a model
turn.

The user subsequently completed real sign-in for the named Personal account.
Their screenshot and a read-only encrypted-record check confirmed connected
status and the presence of its saved credential payload; no credentials were
printed or account records changed by the verifier. This is consent evidence,
not evidence of model execution.

The account UX follow-up covers **12 account/Google browser scenarios**, all
with passing runs, and **25/25 focused account/server checks**. The ledger
records browser-network failures and reruns separately. Scenarios include slow
code issuance, pending details after reload, multiple separately labelled
codes, copy/open/cancel, a stale response after cancellation, failed submission
and retry, and form toggling with retained draft and mobile layout. Four server
regressions prevent an in-flight authentication/resource lookup from opening
an event stream after shutdown has already closed existing streams.

The authorized follow-up restart preserved all 13 encrypted record payloads and
the local credential file byte-for-byte, including Personal's connected account.
The database contained no chats; this proves account-record preservation, not a
live model session's resumption.

Before marking Codex delivered, the user must explicitly authorize a minimal
real prompt, confirm which named account ran it, and verify that the same
chat/account resumes after a controlled restart. Claude, GitHub, Linear and AWS
have separate open MVP gates in [feature-queue.md](feature-queue.md).

Protocol reference: [official Codex app-server authentication documentation](https://learn.chatgpt.com/docs/app-server#auth-endpoints).
