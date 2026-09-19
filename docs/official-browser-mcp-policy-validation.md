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
