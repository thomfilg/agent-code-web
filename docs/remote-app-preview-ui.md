# Remote app preview UI

The chat header **Open app** action works without opening Shared Chrome or sending an agent prompt. In an EC2 chat it opens a dialog for a whole-number port from 1024 through 65535 and a relative path (including query and fragment). Existing local chat aliases and personal-browser direct links are unchanged. Shared Chrome also offers **Set up remote preview** when its current worker-local address cannot be opened directly.

First setup is explicit and may take several minutes. The UI shows pending, ready, revoking, deleted, error and unavailable states. Status refreshes never create a distribution or mint launch access. Choosing another port looks up that port; it does not retarget the existing hostname. A retry follows a confirmed retryable state. If a request fails ambiguously, refresh is required before another setup attempt. Closing the dialog does not cancel server-side provisioning.

## API contract

- `GET /api/chats/:id/app-preview?port=8081` reads `{preview:{id,status,port,hostname?,message?,retryable,canRevoke}}`.
- `POST /api/chats/:id/app-preview` with `{port}` explicitly creates/retries asynchronous setup.
- `DELETE /api/chats/:id/app-preview` with `{port}` revokes access, while infrastructure cleanup may remain pending.
- `POST /api/chats/:id/app-preview/open` with `{port,path}` returns HTTP 202 `{warming:{id,status:"pending",retryAfterMs:1000}}` while preparing the worker. The explicit opening flow polls with `{port,path,warmingId}`; only completion returns HTTP 200 `{url}` for the trusted Relay launch document. Each request is bounded to 30 seconds, with 250 seconds for the whole opening flow. This never sends a prompt or retries an application request.

The launch URL must have the exact Relay origin, `/app-preview/open` pathname, exactly one nonempty bounded opaque `launch` query value and no fragment or embedded credentials. It is **not** a direct preview-origin URL. A synchronous blank tab is opened by the user's click, its opener removed and referrer disabled before requesting an intent. A blocked popup therefore does not mint access or prepare a worker. Identity/chat/port changes and dialog closure discard stale responses and close any still-pending tab. The UI displays worker-preparation progress before the trusted launch document performs cookie bootstrap and opens the original app target; this UI does not pass a bearer ticket to a worker origin. Cookie-policy failures must be explained by that trusted document, with no insecure fallback.

Ready means preview infrastructure is ready, not that the worker app is listening. The UI explicitly says opening may start a worker and incur AWS cost, but sends no agent prompt. Revocation remains usable even when the typed app path is invalid.

Closing the dialog or pending tab stops browser polling; it does not immediately stop a VM. The preparation job remains bounded by its original 240-second deadline or session expiry. Stop/logout/revoke invalidates its exact lease. An already-issued backend acquisition is still counted for capacity and deploy drain until it finishes; runtime lifecycle cleanup owns the worker.

## Validation boundary

`node --test test/app-preview.test.mjs` validates target/status/launch boundaries. `playwright test --config test/browser/app-preview.config.mjs` exercises the dialog through disposable synthetic APIs, including progress, retry, timeout, revocation, stale responses, port selection, popup rejection and local behavior. `node test/fixtures/app-preview-mcp.mjs` uses the installed official Playwright MCP against a loopback fixture, captures 1600/390/320 screenshots, and checks a real new tab has neither opener nor referrer.

These frontend fixtures do not prove CloudFront provisioning, Google sessions, third-party cookie bootstrap, remote HTTP/WebSocket forwarding or deployed AWS acceptance. Those remain separate integration gates; this change alone does not complete the MVP.
