# ADR: chat lifecycle state machine and the model-catalog/updater path

Status: accepted. Source: four production defects reported against a live chat
(controller digest `sha256:6acbc93db1b0a9d5056787af0a429f65ffb6ca9832d5de6e3e2415bded1341ca`).
Each defect below was independently reproduced against `main` with a failing
unit/integration test before any source change, per the investigation in this
repository's history for this change.

## 1. Native goal continuation must never create a visible queue message

**Symptom:** an unfinished active-goal turn became Ready and the scheduler
inserted a literal `"/goal resume"` message into the chat's visible queue
twice; both had to be removed by hand before delivery.

**Root cause:** `RuntimeManager.goalAction(chatId, "resume")`
(`src/runtime-manager.mjs`) is the only code path that ever calls
`enqueue(chatId, "/goal resume")`. Every other action of `goalAction` (pause,
clear) is serialized through the `#switching` set before touching state; the
`resume` branch was not — it read `isBusy`/`queuedMessages` and acted on that
read without holding any lock. Two overlapping calls (a double click, a client
retry racing a slow request) both observe the same pre-enqueue snapshot and
both push the literal command text, which is exactly the kind of thing that
must stay invisible: native continuation itself (the `awaitingContinuation` /
`continuationTimer` machinery in `src/adapters/codex.mjs`) already resumes a
goal with no queued message and no visible transcript entry when the native
dispatcher's own next turn arrives within the 2-second window; only the
*manual*/out-of-band resume path could leak a visible artifact, and only when
raced.

**Fix:** the `resume` branch now takes the same `#switching` lock as every
other goal action (so two overlapping calls fail-fast instead of racing), and
independently de-duplicates against an already-queued `"/goal resume"` entry
before calling `enqueue` at all. See
`test/commands.test.mjs: "concurrent goalAction resume calls queue the
literal command at most once"` (fails with 2 queued copies against the
pre-fix code, passes with exactly 1 after).

**Known scope gap:** `goalAction` remains Codex-only
(`chat.agent !== "codex"` throws). Claude's adapter already surfaces a
`stop-hook-error` notification that tells the user to "use /goal", implying a
symmetrical native Stop-hook-driven goal feature for Claude was intended but
is not implemented in this repository. Building that is a separate, larger
feature (a Claude-side goal object, Stop-hook wiring, and a `goalAction`
implementation in `src/adapters/claude.mjs`) and is out of scope for this fix;
the notification text should not over-promise until it exists.

## 2. An idle queue must atomically start the next turn exactly once

**Symptom:** a message queued while the chat was Working appeared in the
queue within 577 ms and preserved the goal/EC2 worker, but stayed queued after
the turn became Ready; it required "Send now" to actually go out.

**Root cause:** `RuntimeManager.#runQueue` treats `isBusy(chatId)` as a single
signal, but `isBusy` ORs together several independent conditions — including
`runtime.adapter.isBackgroundBusy?.()`. A foreground turn finishing always
re-triggers a drain via `#submit`'s `finish()` callback, so that half of
`isBusy` self-heals. `isBackgroundBusy()` (driven by a Claude
`applicationSession`'s `backgroundCommand`/`hasWorkflowWork()` state) has no
equivalent guarantee: its only re-trigger was the adapter's
`onWorkflowsChanged` callback emitting a `background_turn` event
(`src/adapters/claude.mjs`), which is scoped to a `ClaudeSession` the adapter
happens to have built for that turn. If a queued message's drain attempt
observes `isBackgroundBusy() === true` with no active foreground turn, and
nothing else external happens to fire `background_turn` again afterward, the
queue is stuck indefinitely with no automatic recovery — an ambiguous
condition that a prior implementation implicitly treated as terminal by doing
nothing further.

**Fix:** `#runQueue` now distinguishes "a foreground turn is running" (which
self-heals) from "the adapter reports background-only busy with no foreground
turn" (which does not), and in the latter case schedules a bounded recheck
(`#scheduleBackgroundRecheck`, 1s) that re-attempts the drain. This makes the
queue's FIFO completion self-healing regardless of whether an external event
ever fires, without stopping or restarting the chat/session/worker. See
`test/session-queue.test.mjs: "a queued message eventually drains when only
background work, not a foreground turn, keeps the adapter busy"`.

As a side effect, `#scheduleIdleStop`'s early-return on `isBackgroundBusy()`
was replaced with a proper `"background"` keep-awake reason in the same
ternary chain used for scheduled work, side chats, browsers, etc. — so a
background-busy chat's status/`idleKeepAwakeReason` is now visible and
consistent instead of silently freezing whatever status it last had.

## 3. Every native-launched or explicitly awaited background process must be durably tracked

**Symptom:** Claude launched and fully awaited a Playwright run in the
background; afterward, "Machine health" showed no active tool and
"Background tasks" said "no active tool calls", while the EC2 host was
visibly still under heavy load from the same process.

**Root cause:** the entire "Background tasks" UI
(`public/chat-controls.js`/`public/app.js`) was backed only by
`state.liveTools`, a client-side `Map` populated from per-tool SSE events and
unconditionally cleared on every `turn_started`/`turn_completed`/
`turn_failed`/reconnect. Server-side, `src/adapters/claude.mjs` tracked a
started Bash tool only in a per-call local `activeTools` Map that is force-
completed (`completeTool(itemId, "", false, true)`) the instant the CLI's own
`result` event arrives — regardless of whether the OS process the tool
launched (e.g. `run_in_background: true`) had actually exited. Additionally,
the one piece of code that noticed a `local_bash` background task
(`task_started` events) only ran when the turn had already built a managed
`ClaudeSession` (`interactive`/`pluginReload`/`settingsPrompt`/`debugRequest`/
`applicationRequest`); an ordinary default turn — the common case — never
retained any record of the task at all once its own turn ended.

**Fix:** `ClaudeAdapter` now keeps an adapter-level (not per-call) durable
`backgroundTasks` map, populated the moment a `local_bash` `task_started`
event is observed, independent of whether the turn is "managed":
- Each entry carries a sanitized `{id, title, pid, pgid, state, startedAt,
  deadlineAt, durationMs}` and emits a `background_task` hook event on every
  state transition (`running` → `completed`/`failed`/`unknown`).
- `state: "unknown"` is used whenever the turn's own `result` arrives before
  a matching `tool_result` for that task (i.e. the outcome is genuinely
  ambiguous) — it is never reported as `"failed"`, honoring "ambiguous
  timeouts stay non-terminal". The same state is reached if a task's 30-minute
  deadline elapses with no completion signal (checked lazily in
  `hasBackgroundTasks()`).
- `RuntimeManager` persists each `background_task` event onto
  `chat.backgroundTasks` (survives reload/reconnect, unlike `liveTools`), adds
  a `"background"` reason to the existing idle-keep-awake ternary chain so a
  chat with a running background task is never idle-stopped out from under it
  (the "worker lease"), and treats a task finishing as an internal
  continuation trigger (`#drainQueue`/`#scheduleIdleStop` re-run).
- `public/chat-controls.js`'s "Background tasks" dialog now also renders
  `chat.backgroundTasks`, so the dialog reflects durable state even after a
  reload, not just the current tab's ephemeral SSE history.

**Known scope gap:** the Claude Code CLI's stream-json protocol, as consumed
here, does not report a distinct OS PID per background task — only a
`tool_use_id`/`task_id`. `pid`/`pgid` on a tracked entry therefore anchor to
the *owning worker process* (the already-known `child.pid` of the spawned
`claude` CLI), which is the best real, non-fabricated handle available today.
True per-task PID isolation would require either a CLI protocol change or
walking `/proc/<workerPid>/task/*/children` to find the actual descendant —
deliberately not attempted here to avoid depending on Linux-only `/proc`
introspection inside a security-sensitive path without further design review.

See `test/claude-session.test.mjs`: `"a durably-tracked background task
survives a plain turn that never builds a managed application session"` and
`"a background task force-completed by the turn's own result stays ambiguous,
never silently 'failed'"`.

## 4. The effective model catalog must invalidate and refresh live after a CLI update

**Symptom:** a daily updater reported `Codex 0.156.1 · Claude 2.1.280`, but
after a hard reload the model picker still disabled newer models as if Claude
were on the old version.

**Root cause:** there is no daily-updater feature, stored CLI-version field,
or semver comparator anywhere in this repository — `src/models.mjs`'s
`ModelCatalog.claude()` live-execs `claude --help` and does a bare substring
check (`stdout.includes("fable")`) with no version comparison at all, so it
structurally cannot express "available only from version X". Separately,
`ModelCatalog` cached each agent's catalog for a flat 5-minute TTL with **no
`invalidate()` method at all** (unlike the sibling `CommandCatalog`, which
has one), and its cache-write on resolution was unconditional — a stale
in-flight lookup started before some future invalidation could silently
overwrite a fresher result (the same race `CommandCatalog.list()` already
guards against with a pending-promise identity check).

**Fix:**
- `ModelCatalog.claude()` now also reads the installed CLI's real version
  (`claude --version`) and gates version-sensitive aliases (currently
  `fable`, minimum `2.1.280`) with a real numeric semver comparison
  (`compareSemver` in `src/utils.mjs`), not a string/substring guess. An
  unparsable installed version fails open (does not disable an
  otherwise-advertised alias) rather than getting stuck disabled forever.
- `ModelCatalog.invalidate(agent?)` was added, mirroring
  `CommandCatalog.invalidate()`, and the cache-write in `list()` now checks
  `this.pending.get(agent) === promise` before writing — a superseded lookup
  can no longer clobber a fresher cache entry.
- `GET /api/models?agent=...&refresh=1` calls `models.invalidate(agent)`
  before serving the list, giving a real, callable refresh path a daily
  updater (or an operator, immediately after a manual CLI install) can hit so
  the picker reflects the new version without waiting out the TTL or
  restarting the process.

See `test/models-catalog.test.mjs` (semver gate against a real fixture CLI
binary reporting `--help`/`--version`; the stale-in-flight-overwrite race;
scoped vs. full invalidation).

**Known scope gap:** there is still no actual "daily updater" process in this
repository — it is out-of-repo infrastructure (or does not exist yet). This
ADR only guarantees that *when* such an updater runs and calls the refresh
endpoint (or restarts the process), the catalog it serves afterward is
correct and immediately live; it does not implement the updater itself.

## Cross-cutting invariants this change establishes

- **No ambiguous state is treated as terminal.** A background task whose
  outcome cannot be confirmed becomes `"unknown"`, never `"failed"`; an
  unparsable CLI version does not disable a model; a superseded queue drain
  attempt retries instead of giving up.
- **Nothing here stops EC2/the worker merely to recover control.** The queue
  self-heals via a bounded in-process recheck timer, not via `stop()`/
  `restart()`; a running background task actively *prevents* idle-stop
  (worker lease) rather than the reverse.
- **Durable state lives on the chat record, not only in a live SSE stream.**
  `chat.backgroundTasks` and the model-catalog refresh both survive
  reconnects/reloads; the previous behavior of trusting only in-flight SSE
  events was the direct cause of item 3's inconsistent "Machine health" vs.
  "Background tasks" reporting.

## Production validation checklist

This change was validated locally (unit/integration tests, `git stash`
before/after comparisons per fix) but **not against live AWS production**,
and no build/deploy credentials were available in the environment that
produced this change. Whoever deploys this image should confirm each
original failure no longer reproduces, using the same chat used to gather
the original evidence (`chat_cbb56dcb19134351b024b8db73c649fe`) or an
equivalent fresh chat against the deployed digest:

1. **Goal resume never queues visibly.** Start a goal, let a turn run long
   enough to still be active when you'd normally expect it to finish, and
   let it reach Ready on its own. Confirm the transcript and message queue
   never show a literal `/goal resume` entry — continuation should be
   invisible, and the goal/session/worktree must be unchanged before and
   after.
2. **Idle queue drains exactly once, unattended.** While a turn is
   Working, queue a message. Once the turn reaches Ready, confirm the
   queued message starts automatically — no "Send all now" click needed —
   and that it runs exactly once (not duplicated, not dropped).
3. **Background work stays durably tracked.** Launch or await a
   long-running background tool call (e.g. a Playwright run). After it
   finishes, open "Background tasks" / "Machine health" and confirm the
   task is listed with a sane state/duration instead of "Tool: none" /
   "no active tool calls", even though the worker was busy. Confirm CPU/
   load on the box actually correlates with what the UI reports as
   running.
4. **Model picker reflects a fresh catalog after an update.** After the
   daily updater reports a new Claude version, hard-reload the page and
   confirm previously-gated models (e.g. Fable 5.1, Opus 5.5) become
   selectable without needing a full worker restart, and that the gate is
   keyed off the actual installed version, not a cached one.

If any of these still reproduce on the deployed image, treat it as a
regression against this change, not as expected behavior.

