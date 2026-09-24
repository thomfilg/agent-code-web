# Guest official browser MCP — integration in progress

This partition follows the personal single-tab gateway in PR75. It is not a
deployment receipt or selected-native-model acceptance.

## Decision: one stable catalog, current-mode authorization

Native MCP clients may cache tool names and JSON schemas. The browser gateway
therefore advertises the same pinned official names, descriptions and bounded
argument schemas in guest and personal modes. Catalog presence is **not** a
grant: personal mode denies evaluate, resize, screenshots and tab mutations on
every call. Descriptions state those limits. Personal navigation, snapshot,
click and typing retain the grant-owned projection and hostname protections.
Unsafe official core tools remain absent and denied even if called directly.

The legacy `browser_fill`, `browser_select_tab`, `browser_screenshot`,
`browser_click(selector)` and `browser_evaluate(expression)` contracts are
replaced by official `browser_type`, `browser_tabs`, `browser_take_screenshot`,
`browser_click(target)` and `browser_evaluate(function)` respectively. Existing
native sessions created before this rollout still need a fresh session/catalog;
this does not invent native hot-refresh support. Within the new contract a mode
switch does not change schemas. Bridge loss never automatically selects guest
mode or replays a tool. A fresh explicit sharing grant or runtime is required.
`browser_tabs` retains the official result with a trusted mode/localhost-context
prefix derived only from the post-validated immutable call binding. Revoked
calls return no inferred mode; discovery schemas do not change with this prefix.

## Real caller and ownership

`/gateway/browser` uses `OfficialBrowserMcp` for both modes. Both require current
durable owner/chat/company/environment/named-account scope and the exact runtime
attempt guard. Discovery initializes the actual official MCP without acquiring
Chrome, waking a worker or starting a model. Legacy anonymous/mock browser UI
remains usable, but its agent gateway fails closed.

On an explicit guest tool call, `SharedBrowsers.ensure()` launches/reuses its
normal standalone worker and `BrowserProcess`. Chrome retains its private pipe;
there is no remote debug port or worker Playwright installation. The exact
reviewed protocol policy is embedded as a data module in the trusted standalone
source. A controller-private, single-client loopback socket connects the pinned
matching Playwright client to a narrowly authorized worker protocol. The socket
requires a random header token, rejects Origin and unexpected clients, and is
never exposed in agent tools, URLs or logs.

The separate opt-in local-validation reconnect journal is **not supported by
this partition**: its 128KiB input bound rejects the pinned renderer utility
(about 330KiB). That bound and its authenticated framing/uncertainty rules are
unchanged. Supporting it requires a separately reviewed transport change; no
hibernation or reconnect-transport acceptance is claimed here.

Guest projection sessions are separate from the existing UI session. Only the
worker's owned guest page targets are attached, with bounded target/handle/event
sets; browser-global profile APIs and arbitrary target attachment are absent.
Tab selection and resize call the same worker layout/screencast owner used by
the UI. Before each official action the official selected tab is synchronized
with the user-selected guest tab. Detaching the agent projection does not close
the user's browser. Explicit Stop proceeds to owned Chrome termination even if
projection detach is unconfirmed. The private helper emits a stop receipt only
after owned Chrome exit/absence; helper exit alone is not that receipt. A failed
Stop retains ownership for retry, never restarts Chrome, and never fabricates
cleanup success. The existing trusted remote group-termination contract is the
separate opt-in transport's authority; no new production reconnect claim is made.

Projection cleanup ownership is retained before sending open, including a lost
open acknowledgement. Exact-ID detach failures keep their target/session map,
block replacement acquisition, and are retried explicitly. Queued layout work
checks the same immutable projection and selected target inside its callback and
between native phases. Already-sent commands may complete after revocation;
later phases must not start and stale results remain unavailable.

Guest replies and events share a bounded authenticated FIFO. Guest and personal
event-prefix barriers capture a finite sequence watermark, rather than waiting
for all future network events to cease. Count/byte overflow, failed validation,
abort and release reject pending barriers and clear private output. No event is
silently dropped while the projection remains usable.

Screenshots accept only bounded viewport PNG parameters, never a filename or
full-page request. The worker captures its UI-owned viewport; output paths are
not returned, and the official backend's temporary output is removed after the
call. Personal screenshots remain unavailable until separately accepted.

## Validation and remaining acceptance

Independent review subsequently identified three blockers: queued mutations
after revocation, lost-open-ACK/failed-detach cleanup ownership, and starvation
under continuous events below the queue limits. The last was demonstrated by a
real private-WebSocket synthetic proof (2,561 events, 41 validation rounds, fewer
than 1,024 outstanding events) before implementing finite-prefix barriers.

After the fixes, focused session **33042 passed 22/22** in 6.03s
(`/tmp/relay-guest-blockers-focused.log`): guards before/after native phases,
same-tab session preservation and explicit invalid-session repair, coherent
status publication, exact cleanup retry/lost ACK, continuously replenished event
queues, abort, and Stop failure/receipt retention. Actual guest session **92757
passed 1/1** in 8.16s (`/tmp/relay-guest-blockers-actual.log`), including a
synthetic detached-link state followed by real owned Chrome termination through
the normal caller and its private receipt. This is not an actual remote network
partition or controller-restart proof. Independent read-only review found no new
blocker in the guards, finite barriers, cleanup retention and Stop receipt;
reviewers did not rerun these tests.

Final serial compatibility session **61321 passed 48/48** across nine files in
82.32s, with no retries (`/tmp/relay-guest-official-final-compat.log`):

```text
test/browser-projection-barriers.test.mjs
test/guest-browser-protocol.test.mjs
test/guest-projection-cleanup.test.mjs
test/guest-official-mcp.test.mjs
test/official-browser-mcp.test.mjs
test/personal-browser-authority.test.mjs
test/personal-chrome.test.mjs
test/personal-official-mcp.test.mjs
test/shared-browser.test.mjs
```

This includes overflow and failed-authorization rejection of pending barriers,
queued resize after UI selection change, screenshot revocation/selection change
during metrics lookup, and successful explicit retry after the exact private
Chrome receipt arrives. Actual guest and actual disposable personal extension
gateway/UI cases both passed in this same batch. No production profile, cloud
resource or real model was used. Full integrated application tests, installed
native-client cached-mode/model acceptance and deployment acceptance remain
separate gates; this receipt alone does not complete MVP item28.

The guest protocol/lifecycle batch **68993 passed 10/10** (10.94s), including
the real guest gateway case. Its temporary method-only diagnostic instrumentation
was then removed completely. The identical **unmodified-worker actual guest
case passed 1/1**, session **97653**, 7.35s. It covers official navigation,
click/type/evaluate, 96-resource SPA burst, viewport PNG, tab creation/selection/
close, UI-selected tab synchronization, durable-scope revocation, lost-link
result fencing/no replay, same helper identity, and explicit real Stop; no model
was started. The independent real official screenshot output/deadline cleanup
case passed in session92947. Broader personal/UI compatibility and independent
review were subsequently completed above; selected-native-model acceptance
remains open.

The first seven-file compatibility run, **19258**, completed **31/32** in
71.33s (`/tmp/relay-guest-official-compat.log`). Personal extension/official MCP
including the 96-resource burst, stable mode catalog/revocation, existing
personal consent UI, shared guest UI, screenshot cleanup and protocol cases
passed. The actual guest case failed with a direct worker `Session with given id
not found` error. Same-tab synchronization's unnecessary UI-session replacement
was reproduced independently in session24800 (10/11) and fixed without
swallowing errors. The final receipt above supersedes acceptance, but does not
erase this failed run.

First compatibility run (session23987) completed **0/1**, 21.49 seconds. Pinned
Playwright's mandatory headless font initialization was denied, leaving its
initial page unavailable. Source inspection confirmed the mandatory await;
the projection now validates that narrow font-default message and acknowledges
it without changing the UI-owned Chrome fonts. A file-chooser interception
message was also denied in the failed initialization trace; no generic method
forwarding was added. This result is not a passing acceptance receipt.

Second run (50954) completed **0/1**, 26.86 seconds. The remaining file-chooser
interception error is optional/caught in installed Playwright; it was not the
cause and was not allowed. The actual gap was the legacy standalone worker's
silent 100KB line drop versus Playwright's 330,364-byte injected renderer utility.
Only private projection envelopes now have a 1MiB bounded budget; ordinary UI
commands keep 100KB. Controller dispatch rejects oversize before writing.

Third run (84119) completed **0/1**, 11.75 seconds after successful actual
navigation. Its fixture counted the Chrome executable-probe shell and the Node
browser helper as two browser starts; accounting now counts only the actual
helper. No duplicate browser was observed or production behavior changed for
this fixture correction. No later acceptance is implied by these partial runs.

Fourth run (57820) completed **0/1**, 27.25 seconds. Actual navigation, click,
typing, evaluation, a 96-resource SPA burst, resize and a bounded 390×844 PNG
passed before a tabs operation timed out. Source review then found that separate
async response/event queues could invert native CDP ordering at both pipe hops.
Native projected replies now use synchronous, request-bound taps and one
bounded authenticated controller output queue. Deterministic held-validation
tests were added; the tabs timeout cause remains provisional until the real
case passes. Optional denied methods have not been generally enabled.

Fifth batch (34886) completed **4/5**: all four deterministic framing/ordering
cases passed, including held authority/revocation and exactly-once policy reply
validation before a following context-clear event. The real guest case passed
new/select after the prior timeout, then read the UI tab count before the
existing asynchronous close/status publication completed. Its assertion now
waits boundedly for exactly one tab selected and verifies the exact remaining
target through worker status; no fixed delay or weaker count was added. The
full real case is still pending and this partial result is not acceptance.

Sixth batch (92947) completed **6/7**, 27.81 seconds: five protocol/order cases
and the real official screenshot output/deadline cleanup case passed. The guest
case failed in `browser_tabs:close`, with `Target.closeTarget` still outstanding
at the official 15-second deadline. This disproves treating the earlier close
failure as only same-tick UI timing. Native nested close/layout ownership is
under investigation; the guest end-to-end gate remains open.

A direct deterministic close regression then reproduced commands to the
destroyed selected UI session: `Page.stopScreencast` and
`Target.detachFromTarget` after `Target.closeTarget` (0/1, 615ms). The minimal
fix stops the screencast before closing, clears the destroyed session identity,
selects the remaining owned tab and restores prior viewing. The identical case
passed (1/1, 748ms), without Chrome, timeout increases or permission changes.
The actual guest rerun remains required before assigning the live timeout's
cause or recording end-to-end acceptance.

Seventh actual guest run (29006) completed **0/1**, 12.89 seconds. The close tool
returned without the prior timeout, but the exact one-tab/original-selected UI
predicate did not become true within its unchanged two-second bound. The next
diagnostic compares UI and direct worker status using only symbolic
first/second/other target identities; no URLs, page data or credentials are
recorded. It does not assume the fixture predicate is wrong.

Eighth diagnostic batch (46556) completed **0/2**, 10.62 seconds. The held-tabs
unit proved that an old selected target could overwrite current UI state. The
actual guest result separately showed the second target removed but **both** UI
and native state selected none while the first target remained. Thus fixing
status coherence alone is not yet evidence of fixing the actual close path.
The reviewed stamp/publication fix is prepared; bounded method-only native
diagnostics will identify the remaining close/selection await. These temporary
diagnostics must be removed before the final unmodified-worker acceptance run.

The follow-up protocol batch reproduced stale target reselection independently
(8/9, 695ms): Chrome can still list the acknowledged closing target briefly;
choosing it as the successor caused `Browser tab no longer exists` and left no
selection. Filtering out precisely that closed ID before selecting another owned
target made the regression pass. Together with the separately reproduced
status-stamp fix, the actual guest path then passed as recorded above; no timeout,
target authority, count predicate or security flag was relaxed.

- Actual normal guest gateway with named synthetic durable scope, private-pipe
  Chrome, navigation/click/type/evaluate, UI tab selection and resize, screenshot
  bounds, tab lifecycle and Stop.
- Identical catalogs across guest/personal; personal unavailable operations
  denied without acquisition or fallback.
- Delayed scope revocation, helper detach, stale results and unknown mutation
  outcome never replay or reconnect automatically.
- Existing personal extension/consent and guest UI regressions.
- Installed native CLI discovery harness remains synthetic scope and no-model;
  it is not durable real-user or selected-native-model proof.
- Independent source/security review and real selected-native acceptance before
  declaring MVP item28 complete.
