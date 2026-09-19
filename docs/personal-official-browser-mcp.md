# Personal official MCP integration — development receipt

This branch builds on the historically unwired proxy receipt in
`official-browser-mcp-policy-validation.md`. That receipt's nine passing tests
apply to its original partition, not to this new integration. New integration
validation and independent review are recorded below. Do not infer
deployment approval from this note.

## Actual caller and ownership

The existing `/gateway/browser` uses the pinned official MCP for a personally
shared tab. Guest mode retains its existing gateway. The personal path requires
a named connected Codex/Claude account, a durable chat and a registered-company
environment. The runtime supplies an active-attempt guard. The grant captures
owner/chat/company/environment/provider/account identity and revisions at the
user's explicit Enable action, including a digest of native account identity and
subject. The admission authority reads durable chat, account, disconnection,
company and environment records and compares live chat state around its awaits.

User-only local/mock sharing remains available for existing consent, viewport,
clipboard and login workflows, but cannot acquire agent-MCP privileges. Reusing
that grant after connecting a named agent is not enough: sharing must be enabled
again explicitly. Personal `browser_evaluate` is intentionally removed; it is
not replaced by an unsafe alias. Resize remains a user-UI operation because the
extension owns viewport/screencast coordination. Screenshot viewing remains in
the shared UI; this slice does not advertise a personal screenshot MCP tool.

The extension owns one newly created automation tab. A private authenticated
loopback WebSocket projects just that tab as a single CDP target/session for the
matching Playwright version. The capability is in a private request header,
never in an agent tool, URL, transcript or application log. The listener accepts
one client, denies Origin, and has bounded input/output and pending work. The
projection and extension independently validate protocol methods, arguments and
owned frame/context/object handles. Webpage return values cannot register fake
protocol handles. Browser-wide profile, storage/cookie, arbitrary target,
context creation, download configuration and host-code commands are denied.
Console and sensitive network/header events are not forwarded. Private
Playwright-internal evaluation remains necessary for official locators; agents
cannot request arbitrary evaluation. Page-visible information is still visible
to the authorized agent; this is not a promise to conceal webpage-rendered
secrets or to isolate a website from its own authenticated browser session.

Existing extension Fetch interception continues blocking the Relay hostname
across ports, redirects and subresources. It cannot be disabled or controlled
through the projection. Screencast commands remain extension-owned. Descendant
target/OOPIF attachment is deliberately unsupported in this slice: there is no
generic forwarding fallback. This limitation needs explicit compatibility
evaluation before claiming complete personal browser coverage.

Revocation fences requests/results and tears down the projection. Projected
Playwright detach alone does not close the user's shared tab; grant revocation
still detaches and closes only the extension-created automation tab. An
automatic extension reconnect cannot restore sharing. A fresh explicit Enable
creates a new grant; only that can admit a new projection under a still-current
attempt. No mutating action is replayed. Once an attempt has used personal mode,
loss of its grant never silently routes its requests to guest Chrome.

The downloadable extension includes its policy module and has version 0.2.0.
Older extensions cannot serve this protocol and fail closed; no personal profile
contents or existing pairing records are migrated or deleted.

## Validation status

First run: authority fixtures failed before any browser launched. The synthetic
environment lacked the canonical single-company array; a gated fixture omitted
repository `fullName`, rejecting before its awaited gate. The two identified
test processes were stopped after 51.5 seconds: 0 pass, 1 failure, 2 cancelled.
Fixtures were corrected, timeouts added and gate failure propagation made
explicit. A subsequent run passed both authority cases but could not import the
normal generated auth bundle in this fresh worktree; `scripts/build-auth.mjs`
generated it. The first actual extension run then passed 3/4 cases and exposed a
real protocol compatibility gap: pinned Playwright requires a browser-context
identifier on its attached target. The virtual facade now supplies its own
grant-local context identifier, never a profile context identifier.

The next focused run passed **4/4**, zero skips, in 8.30 seconds. It used the real
extension and actual official MCP through `/gateway/browser`, including
navigation, signed-in page snapshot, click and typing, direct forbidden profile
APIs and a real foreign object handle, and grant revocation. All browser data
was synthetic in a disposable profile.

The broadened six-file run first completed 31/33. Both failures were assertions
expecting `403` in the SDK error message, which exposes the sanitized server
message without its HTTP status. Tests now assert the actual HTTP status is 403
separately and assert SDK denial semantics; authorization was not relaxed.

Final focused command (2026-09-19):

```sh
taskset -c 0,1 nice -n 10 node --test --test-concurrency=1 \
  test/personal-browser-authority.test.mjs test/personal-official-mcp.test.mjs \
  test/official-browser-mcp.test.mjs test/browser-connections.test.mjs \
  test/shared-browser.test.mjs test/personal-chrome.test.mjs
```

Result: **33 passed, 0 failed, 0 skipped**, 65.61 seconds. Coverage includes:

- Twelve company/owner/legacy pairing and consent regressions.
- Nine outer-proxy cases against actual pinned official MCP and disposable
  sandboxed Chrome, including lazy discovery and unsafe-core bypass rejection.
- Two durable authority/await-race cases, including a missing persisted chat,
  stale connected metadata, durable disconnect intent, changed native identity
  without a revision bump, and revocation while Enable reads scope.
- Protocol policy rejection of foreign handles, profile/global APIs and native
  clipboard shortcuts, including Ctrl/Meta+Insert and Shift+Insert/Delete aliases.
- Actual extension + official MCP via the normal product gateway. It navigates,
  reads the signed-in page, clicks and types on the grant's one tab, rejects a
  real object handle from an unrelated tab, preserves unrelated synthetic
  cookies/storage, and keeps Relay-hostname navigation blocked. Holding a real
  mouse-release result across a durable account revision change discards the
  result and proves the click occurred once. Projection detach preserves the
  user tab. New attempts cannot inherit stale consent; explicit new Enable can
  admit a new projection. Bridge loss and automatic reconnect do not restore
  sharing. Both named synthetic Codex and Claude scopes were exercised. Worker
  and model-start guards remained at zero.
- Seven unchanged guest Chrome/gateway/copy/viewport regressions.
- The real personal-user UI test still covers explicit consent, live viewport,
  clipboard selection, login persistence across browser/controller restart and
  closing only the automation tab. Its desktop screenshot was inspected: the
  signed-in fixture is visible in the shared viewport while the worker is stopped.

Independent source/security review accepted this bounded partition after checking
the durable chat/account-identity boundary, clipboard aliases and explicit
reconsent fences. The reviewer did not independently rerun the 33 tests.
Explicit selected-native-agent acceptance remains pending (the synthetic named-
account clients above are real MCP clients, not real Codex/Claude model turns).
No real personal profile, provider account, model request, deployment or cloud
operation is authorized by these local tests. MVP item 28 is not complete.

Guest mode still advertises the legacy tool contract (`browser_fill` and
`browser_click(selector)`); personal mode advertises the official contract
(`browser_type` and `browser_click(target)`). The actual-gateway fixture connects
after sharing was enabled. A native CLI which cached guest schemas before a
mid-chat mode switch may need a real catalog refresh. This stateless gateway
does not emit `tools/list_changed`; no schema-refresh acceptance is claimed.
Full guest official integration or an explicitly verified native refresh path
remains required, along with real selected-agent acceptance. No alias silently
falls back to the old personal evaluator.
