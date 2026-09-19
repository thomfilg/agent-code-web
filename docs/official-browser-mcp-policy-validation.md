# Official browser MCP authorization partition

This is an **unwired, partial implementation**, not completion of MVP item 28.
No product route, runtime caller, worker image, or admission flag is changed.
Personal-browser execution is deliberately unavailable until a real scoped CDP
projection exists. No generic personal CDP endpoint or marker can enable it.

## Interface and trust boundary

`OfficialBrowserMcp({ binding, validateBinding, acquireContext })` owns the private
official MCP server/client pair. Its public methods are `toolsList()`,
`callTool({ name, arguments }, { signal })`, and `revoke()` / `close()`.

The immutable binding includes owner, chat, company, environment, named provider
account and revisions, attempt, generation, and browser mode. Personal mode also
requires an explicit grant ID. The integration must supply a **trusted current
authority check**, not accept agent-provided binding claims. Checks run before and
after asynchronous operations; revoked or changed bindings deny subsequent calls
and discard stale results. A browser mutation already executed before revocation
cannot be rolled back; failed calls are never automatically replayed.

`acquireContext({ binding, signal, playwright })` is a trusted integration seam,
not an agent-accessible API. It must provide exactly the authorized guest context
plus an idempotent `release()` that tears down its owned lease, including after
partial acquisition. It must honor cancellation and settle boundedly. Authority
checks must also settle boundedly. The partition cannot prove these obligations
for an unwired caller. There is no implicit host-browser/profile fallback.

The official dependency is `@playwright/mcp` 0.0.81, with its own matching
Playwright 1.64.0-alpha-2026-09-14. The repository's separate top-level Playwright
is not substituted. Discovery uses the actual official `createConnection` and
does not acquire Chrome. An explicit outer allowlist is necessary because the
official `capabilities: []` catalog still contains unsafe core tools.

The outer proxy validates copied arguments with strict schemas before dispatch,
including unknown-field rejection. It narrows discovery to eleven guest tools
and ten provisional personal tools, and independently enforces the same policy
on direct calls. The personal catalog is a policy preview only: **every personal
execution fails before context acquisition**. Unsafe host code, filesystem,
cookie/storage, unrestricted network/console, installation, and browser-close
tools are not admitted. Personal evaluation and tab creation/selection are not
admitted. Guest evaluation is ordinary page/locator evaluation, not host code.
This does not promise to conceal secrets rendered by an authorized webpage.

Requests are serialized with an eight-request pending limit. Result size is
bounded to 2 MiB, output scratch storage is private and removed on cleanup, and
raw authority/acquisition errors are not exposed. A failed release leaves the
proxy fenced and can be retried without acquiring another context.

## Local validation (2026-09-19)

Command:

```sh
taskset -c 0,1 nice -n 10 node --test --test-concurrency=1 test/official-browser-mcp.test.mjs
```

Final result: **9 passed, 0 failed, 0 skipped**, 7.86 seconds. Tests used the
actual pinned official MCP, its matching Playwright, disposable headless Chrome,
and a loopback fixture page. No personal profile, real account, model, cloud
resource, or external website was used.

Coverage:

- Lazy real catalog discovery and direct-call rejection of unsafe core tools and
  excessive/unknown arguments, without Chrome acquisition.
- Personal-mode hard denial before context acquisition.
- Actual navigation, snapshot, click, typing and evaluation in the supplied
  guest page, followed by owned-context release.
- Owner/chat/company/environment/account/provider/revision/attempt/generation
  changes denied before acquisition.
- Revocation during delayed acquisition; late context is released.
- A real mutation followed by generation change while its result is pending:
  stale result denied, mutation performed once, no replay.
- Sanitized authority/acquisition failures and no host fallback.
- Failed release retried while access stays revoked.
- Bounded queued calls during delayed acquisition and revocation.

An initial run had 1 pass / 8 failures: the synthetic authority fixture compared
JSON serialization order against the schema-normalized binding. This incorrectly
denied structurally identical bindings before browser acquisition, causing gated
tests to time out. The fixture was corrected to structural equality; production
authorization was not relaxed. The final run above was a complete rerun.

An independent read-only review accepted the bounded unwired scope and checked
the installed official context-getter and page-evaluation implementation. The
reviewer did not independently rerun these nine tests.

## Remaining end-to-end gates

Required work includes trusted durable authority wiring, worker-owned guest
context integration, worker packaging, the real single-authorized-personal-tab
CDP projection with revocation teardown, and selected Codex/Claude product-path
acceptance. Personal projection must enforce target/frame/session ownership and
exclude other tabs, browser-global profile APIs and credentials. This receipt
does not establish controller restart recovery, hibernation, production
availability, or complete official-tool coverage.

## Next implementation: single-tab personal CDP projection (plan only)

Ownership must follow the **individual active sharing grant**, not the paired
profile. Existing source seams, inspected read-only against the integration:

- `BrowserConnections.enable/currentGrant/request/accept/revokeChat` in
  `src/browser-connections.mjs` own the grant, bridge, pending requests and
  immediate invalidation. Add a private grant-scoped projection transport here;
  do not expose a generic `chrome.*` RPC or a profile CDP URL.
- `authorize`, `cdp`, `chrome.debugger.onEvent` and `revoke` in
  `chrome-extension/worker.js` already own the extension-created automation tab.
  Extend this boundary with independently validated method/argument routing and
  scoped events. Never enumerate or attach unrelated existing tabs.
- `SharedBrowsers.handle` in `src/shared-browser.mjs` is the eventual outer MCP
  gateway. Its trusted context provider would attach matching Playwright only to
  the projected connection. The `personal.on("changed")` listener in
  `src/server.mjs` must immediately fence the matching proxy. Current personal
  `bindingCurrent` checks owner/company/chat, but not the named agent account,
  environment or their revisions: integration must add those authority checks
  before granting this path. Pairing credentials stay on the controller and
  extension, never in model tools or the worker.

The pinned Playwright core bundle contains a reference extension `BrowserModel`
and `ExtensionProtocolV2`. They illustrate CDP session mechanics but are **not a
safe policy to reuse**: the reference model tracks all known tabs, auto-attaches
them, and forwards browser-global commands through any attached tab. Stock
official extension mode is therefore not this implementation plan.

The projection needs a minimal virtual browser root that synthesizes version and
sole-target discovery/attachment. Virtual target/session IDs map immutably to the
one grant and extension-owned tab. A descendant OOPIF session may enter the map
only through a verified extension event from an already-authorized parent;
foreign targets and worker/service-worker/shared-worker targets remain denied.
Every command, result and event must validate the current grant generation.

Do not forward browser-global APIs: cookie/storage/profile access, arbitrary
target discovery/attachment, target or context creation, browser shutdown,
downloads/filesystem configuration, or operations on other tabs. Unsupported
commands must fail explicitly; a synthetic acknowledgement is appropriate only
for a documented compatibility operation with no real side effect, never as an
excuse to claim a requested security policy was enforced.

Actual pinned Chromium attachment initializes page/frame state, runtime worlds,
lifecycle events, network observation and auto-attachment. A strict per-method
parameter policy must cover those required operations without unrestricted
domain forwarding. Frame/context/object/session handles require ownership maps;
network headers, cookie metadata, console payloads and unrelated events must not
leak through initialization or event forwarding. Bound pending requests, event
buffers and results; never log raw private payloads.

Playwright's internal page evaluation is needed for locators and snapshots. It
must remain a private trusted-adapter operation; the personal outer
`browser_evaluate` tool remains denied. This is not a guarantee against reading
secrets visibly rendered in the explicitly authorized webpage. The extension's
existing Relay-hostname navigation/subresource protection remains authoritative:
Playwright must not disable or bypass its Fetch interception. Similarly,
screencast ownership must not silently move away from the user's shared viewport.

The first usable acceptance slice must call the **actual official MCP** through
the normal product gateway against a disposable extension-authorized tab, while
other test tabs and fake profile data remain inaccessible. Required evidence:

1. Snapshot, click, typing and navigation act on the same tab the user sees;
   discovery does not create or authorize a tab.
2. Direct unsafe tool names and forbidden CDP methods fail; foreign target,
   frame, context, object and session IDs cannot escape the ownership maps.
3. Popups, OOPIF transitions, redirects and Relay-hostname subresources preserve
   containment and existing protection; unsupported targets fail closed.
4. Account/company/environment/attempt changes, grant revoke, and bridge loss
   synchronously fence dispatch and stale results, close the projected link and
   detach only the authorized automation tab. No reconnect grants access again,
   retries a mutation, or falls back to guest/host Chrome.
5. A disposable multi-tab profile with seeded fake cookies/storage verifies the
   isolation boundary without using any real personal profile or credential.
6. Selected Codex and Claude product callers use the official gateway successfully
   under explicit acceptance consent; a standalone harness is not completion.

This plan changes neither current Chrome grants nor product routing. Real CDP
compatibility under these restrictions is still an implementation and acceptance
gate. Personal execution remains unavailable in this partition until it passes.
