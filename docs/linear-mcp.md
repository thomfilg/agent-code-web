# Linear accounts and environment access

## Connect a workspace

1. Sign into Relay with your own Google account. Open **MCP connections → Linear**.
2. Keep the name `linear` or choose another name. Select only the company whose
   repositories may use this workspace. For example, create one connection for
   `g2i` and a separate connection for `12-apps`; both may be named `linear`.
3. Choose **Read only** (the default), or explicitly choose **Read and write** if
   you want the agent to make changes. Save. **Saved configuration is not sign-in.**
4. Click **Connect with OAuth** and approve in Linear, selecting the matching
   workspace. Relay shows the connection name/company, progress, a sign-in link
   if popups are blocked, and Cancel. Denial and expiry are reported in the
   connection panel; an old authorization is not replaced by a cancelled flow.
5. Relay discovers tools and performs `list_teams` with `limit: 1` to verify an
   authenticated, non-mutating workspace read. Only a successful read shows
   **Authenticated workspace read verified**. It does not save the team response.
6. In **Environments**, select that connection and allow the matching company.
   Select the environment for the chat and start/restart its worker. Both Codex
   and Claude receive only revocable controller gateway capabilities, not Linear
   tokens. The chat's primary repository controls company matching; a secondary
   repository or display group cannot expand access.

Each Relay user owns independent connection records. There is no host-credential
import or fallback to another user, company, or connection. OAuth tokens and
client credentials are encrypted with the controller database. Local workers
still share the host filesystem; isolated cloud workers provide a stronger
boundary. Revocation or rejected refresh changes the connection to Sign-in
required. Reconnect and restart the worker; saving a connection or a successful
tool inventory alone is not proof of workspace access.

## OAuth registration and deployment

The official hosted endpoint is `https://mcp.linear.app/mcp`. Linear currently
supports dynamic client registration: normally **do not enter a client ID or
secret**. As verified on 2026-09-18, public discovery returns the issuer
`https://mcp.linear.app`, `/authorize`, `/token`, `/register`, and PKCE S256.
Reading that metadata did not authorize an account or access workspace data.

Set `AGENT_WEB_PUBLIC_URL` to Relay's canonical external HTTPS origin when
deploying remotely. The callback is:

```
https://YOUR-RELAY-HOST/oauth/mcp/callback
```

For local development it is `http://localhost:8787/oauth/mcp/callback`. Use the
same Relay origin throughout sign-in. Consent must return to the same browser:
the callback requires its own short-lived, HttpOnly, SameSite=Lax flow cookie.
PKCE S256, single-use state, pinned discovery and issuer checking apply.

For a **different/custom MCP** that does not advertise dynamic registration,
Relay opens Advanced OAuth settings and asks for a pre-registered client. The
provider/application administrator must register the exact displayed callback,
then enter its client ID and, only when required, its client secret. The secret
stays encrypted on the controller and is never returned by the API. Relay does
not substitute a shared developer account or request a broader OAuth grant.

## Verification evidence and remaining real-user gate

Automated coverage uses independent local OAuth/MCP services, not real accounts.
The 2026-09-18 implementation checkpoint passed **33/33** backend/security tests,
**3/3** dedicated Linear browser scenarios and **4/4** existing MCP UI regressions:

- Dynamic registration, least-privilege scopes and explicit write opt-in;
  PKCE/cookie/state/issuer checks; denied, expired and cancelled consent;
  cancellation while token exchange is in flight; manual registration fallback.
- Actual HTTP discovery and read verification, distinguishing failed reads from
  successful tool discovery; private result data is not persisted.
- Same-name `g2i`/`12-apps` connections with distinct credentials, both provider
  adapter paths, selected environment propagation, worker stop/resume and owner
  isolation. Revoked upstream access produces 401 and Sign-in required without
  retrying another workspace's token.
- Browser consent, failed consent, cancellation, popup-blocked fallback,
  360px layout, explicit write scopes and environment selection.

Commands (keep one browser worker and the machine's two-CPU limit):

```sh
taskset -c 0,1 nice -n 10 node --test --test-concurrency=1 test/linear-mcp.test.mjs test/mcp-oauth.test.mjs test/mcp-connections.test.mjs test/company-scope.test.mjs test/google-auth.test.mjs
taskset -c 0,1 nice -n 10 node node_modules/@playwright/test/cli.js test --config playwright.linear.config.mjs
```

**Still required for live MVP acceptance:** the user must approve real Linear
OAuth independently for `g2i` and `12-apps` after this version is activated. For
each, verify the authenticated workspace read, select its environment, and make
an authorized read through both real provider runtimes; confirm scope isolation
and persistence after a controlled controller/worker restart. No real Linear
credentials were copied, no real OAuth consent was given, and no real workspace
read has been counted as passed by these fixtures.

References: [Linear MCP documentation](https://linear.app/docs/mcp),
[Linear's current list_teams tool changelog](https://linear.app/changelog/2026-09-14-loops-for-product-management),
[MCP authorization specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization).
