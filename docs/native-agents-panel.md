# Native child-agent panel: capabilities and acceptance boundary

MVP 42 requests a third-column list of native child agents, their status and a
popup conversation/composer independent of the main chat. This component must
not invent child sessions, substitute a separate CLI process, or route a child
message through the parent and describe that as direct steering.

## Verified contracts (2026-09-19)

OpenAI Docs was used for the [app-server protocol](https://learn.chatgpt.com/docs/app-server).
Existing Codex navigation verifies each descendant's native ancestry before
`thread/read`, `thread/items/list`, `turn/start`, `turn/steer` or `turn/interrupt`.
Steering includes the expected active turn ID; an unknown result is not replayed.

Claude's installed package is **2.1.222**. Public package tool declarations and
the installed stream-json schemas corroborate these primary references:
[SDK types](https://code.claude.com/docs/en/agent-sdk/typescript),
[SDK subagents](https://code.claude.com/docs/en/agent-sdk/subagents),
[agent teams](https://code.claude.com/docs/en/agent-teams), and
[native tools](https://code.claude.com/docs/en/tools-reference).

| Capability | Codex | Installed Claude |
| --- | --- | --- |
| Native child discovery | Ancestor-filtered thread list plus ancestry validation | `task_started` and correlated native Agent results; only `local_agent` tasks are agents |
| Status | Native thread/turn updates | Correlated `task_progress`, `task_updated`, `task_notification`; full-set notifications are not used as membership proof |
| Public child conversation | Native child item history and stream | `forwardSubagentText` opt-in, correlated `parent_tool_use_id`; no thinking/raw metadata display |
| Direct idle message | Native `turn/start` on the authorized child | No supported SDK/control route established |
| Direct active steering | Native `turn/steer` with expected turn | No supported SDK/control route established |
| Stop one child | Native exact-child `turn/interrupt` | Native `stop_task` with exact observed task ID; terminal status must be confirmed |
| Offline/restart display | Saved snapshot, never restored authority | Saved observed snapshot only; do not claim a complete live list after restart |

`supportedAgents()` returns invocable **definitions**, not running child
instances. Claude's `background_tasks` control backgrounds work; it is not a
listing API. The installed `background_tasks_changed` contract has no startup
snapshot. Newer documentation about reinitialization snapshots must not be
assumed to apply to this executable. Shell tasks and native workflows are not
child agents.

Claude's `SendMessage` is a model-called native tool. Native TTY teammate
messaging likewise does not establish a host stream-json target-routing API.
Consequently the Claude popup must explicitly report direct messaging as
unavailable, while allowing independently verified observation and Stop. **MVP
42 remains open for genuine Claude direct messaging.** No guessed request or
unsupported `parent_tool_use_id` input routing is permitted.

## Implementation boundary

The observer is separate from ClaudeSession's workflow-liveness tracker.
Public snapshots are bounded and credential-redacted, keyed by native root and
task ID, never by display name. Native task membership and each action require
the current owner/company/account/environment/workspace/chat/root/runtime binding. Stored snapshots
do not authorize actions. Unknown/late/foreign frames fail closed.

Claude discovery observes actual `Agent` invocations and matches native child
IDs from `task_started` or typed Agent tool results. The observer deliberately
does not treat `background_tasks_changed`, task names or agent definitions as
membership proof. It does not alter the separate workflow report FIFO.
Forwarded descendant frames are consumed by this observer, not the parent's
tool timeline, usage accounting or result boundary. A Stop ACK leaves the
child active until its exact native terminal event arrives. If confirmation
times out, the popup retains an explicit uncertainty warning and does not
replay Stop. The parent is never interrupted by this action.

New durable snapshot records carry an explicit scope binding. Changing owner,
provider, named account, company, environment, workspace or native root makes
the prior preview unavailable. Legacy records without this evidence are not
retroactively assigned to the current owner; reconnecting can build a fresh
verified snapshot. This changes display availability, not native history.
Per-child and aggregate preview limits are explicit, and snapshot consumers
cannot mutate the observer's internal text or usage values.

Opening the panel or a cached popup must not acquire a worker. Connect is an
explicit separate action. Codex keeps its existing direct-send/steer controls;
Claude exposes only capabilities actually demonstrated. Closing a popup does
not stop a child or its main session. Keyboard focus, mobile layout and separate
per-child drafts are part of the UI acceptance, not inferred from backend tests.

## Acceptance plan/status

The old Codex smoke uses a real CLI with synthetic stored descendant journals.
It establishes native API compatibility, not actual delegated-agent creation.
A genuine delegated-child smoke is still required; no synthetic history will be
reported as that proof.

`scripts/smoke-real-claude-agents.mjs` is a bounded, network-isolated
native capability fixture. An authored loopback provider asks one real Claude
process to invoke its actual Agent tool. Native code, not the fixture, assigns
child IDs and emits task/conversation frames. A completed child and a held
background child test correlation and exact-child Stop while the same parent
continues. It uses no personal profile, real provider or invented journal.
The original capability receipt below predates the observer wiring. The current
harness also feeds every actual native frame through `ClaudeAgentThreads` and
uses its Stop method; the third receipt below validates that implementation.

First runtime attempt (`96812`, exit 1) stopped on the fixture's overly strict
`POST` assertion when native startup sent a `HEAD` probe to its configured
loopback origin. It did not establish child creation or absence of support.
The harness now returns 404 for non-Messages/probe routes, matching the existing
isolated Claude fixture; it does not fabricate a successful health/model reply.
The failure log is retained at `/tmp/relay-real-claude-agents-v1.log`.

Second attempt (`63197`, exit 0) passed using the actual installed Claude
process: two real native Agent children/IDs, correlated forwarded public text,
the second child active after the parent's completed reply, exactly one
`stop_task` followed by a native terminal event, and a successful continuation
of the same parent session. Eight authored loopback requests were observed.
The two children used the same requested display name, but the first had
already completed before the second was stopped: this does **not** prove
selection between two simultaneously active children. That remains a separate
observer regression and, if claimed natively, needs its own native acceptance.
Log: `/tmp/relay-real-claude-agents-v2.log`. Independent parent review inspected
source and receipt without rerunning. This does not establish direct child
messaging, live-provider behavior or production acceptance.

Third attempt (`60084`, exit 0) passed with the production observer consuming
actual native frames. Its snapshots contained both native-assigned child IDs,
the completed child's forwarded public answer and the active second child.
`observer.interrupt(secondId)` sent exactly one native `stop_task`, waited for
the matching terminal event, left the first child's completed state unchanged,
and the same parent session answered an explicit continuation. Seven authored
loopback requests and zero approval requests occurred. Log:
`/tmp/relay-real-claude-agents-v3.log`. The same-name simultaneous-active and
live-provider limitations above still apply.

## Component validation

- Focused Node (`51894`): **137/137**, no skipped/cancelled tests, 17.01 seconds.
  Files: `test/agent-threads.test.mjs`, `test/claude-agent-threads.test.mjs`,
  `test/claude-session.test.mjs`. Includes exact environment/workspace changes
  across select/Stop awaits, scope-bound snapshot reload and delayed reads,
  held HTTP body with owner transfer and zero native actions, Codex revocation
  between cached authorization and resume or between goal pause and turn lookup,
  two simultaneously active same-name Claude children, uncertain Stop without
  replay, public-text redaction and forwarded child result isolation.
- Browser (`86673`): **6/6**, no retries, 15.1 seconds. Preserves independent
  drafts, approvals, older-message paging, delayed child replies, explicit-only
  Connect, popup keyboard navigation, and Claude's honest capability notice.
- Disposable desktop list and Codex/Claude mobile popup screenshots were
  inspected: all controls fit and the conversation scroll region stays inside
  the dialog. Artifacts are under `test-results/agent-threads-*.png` and
  `test-results/claude-agent-popup-mobile.png`, not personal state.
- Independent source review found a Codex pre-dispatch await gap. Every native
  RPC now uses a synchronous current-scope check, with regression coverage.
  The reviewer reread the correction and reported no remaining blocker; the
  reviewer did not independently rerun tests.

The first Node attempt (`65796`) was **129/135**: four new doubles omitted the
required `busy()` method, another omitted server initialization, and one mask
expectation differed from the generic redactor's `sk-***` format. The fixtures
were corrected and Claude-key normalization now precedes generic redaction.
No failed assertion was removed. Both logs are retained as
`/tmp/relay-native-agents-node-v1.log` and `-v2.log`. No browser failure/retry or
production deployment occurred in this component validation.
