import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { PassThrough, Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import readline from "node:readline";
import { ClaudeControlChannel } from "./claude-mcp.mjs";
import { terminateWorker } from "./worker-process.mjs";
import { ClaudeRequests } from "./claude-requests.mjs";

const flag = (args, name) => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };

// The SDK has no scheduled-task snapshot/change control. These filtered native
// diagnostics report restoration, automatic deletion and expiry without an
// extra user turn, model call, transcript replay or controller-side scheduler.
// Keep them on the owned process pipe, not in debug files or chat messages.
export const CLAUDE_SCHEDULE_DIAGNOSTICS = ["--debug=ScheduledTasks,resume,loop/dynamic", "--debug-to-stderr"];

// A Claude application session outlives individual replies. Each turn exposes
// the same stream contract as the one-shot adapter, but a result closes only
// that logical turn, not the CLI which owns its background application tasks.
export class ClaudeSession {
  constructor(child, args, env, onBackgroundEvent = () => {}, { controlTimeoutMs = 30000, requestHooks, cwd, onSchedulesChanged = () => {}, onWorkflowsChanged = () => {} } = {}) {
    this.child = child; this.args = args; this.env = env; this.active = null; this.pending = false;
    this.sessionId = flag(args, "--session-id") || flag(args, "--resume");
    this.controlTimeoutMs = controlTimeoutMs;
    this.scheduledJobs = new Set(); this.scheduleCalls = new Map(); this.onSchedulesChanged = onSchedulesChanged;
    this.restoredJobs = 0;
    this.fixedJobs = new Set(); this.reportedJobs = new Set(); this.dynamicWakeup = null;
    this.workflowCalls = new Set(); this.workflows = new Map(); this.onWorkflowsChanged = onWorkflowsChanged;
    this.onBackgroundEvent = onBackgroundEvent;
    this.control = new ClaudeControlChannel(child, controlTimeoutMs);
    this.requests = requestHooks ? new ClaudeRequests(child, requestHooks, cwd) : null;
    this.closed = new Promise(resolve => { this.resolveClosed = resolve; });
    this.lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    this.lines.on("line", line => {
      let event; try { event = JSON.parse(line); } catch { return; }
      if (event.type === "result") event.relayWorkflowInterrupted = false;
      this.control.accept(event);
      if (this.requests?.accept(event)) return;
      this.trackSchedules(event);
      const workflowsCompleted = this.trackWorkflows(event);
      if (event.type === "result") {
        const previous = this.usageBaseline;
        this.usageBaseline = event;
        event = claudeCallResult(event, previous);
      }
      const turn = this.active;
      if (event.type === "command_lifecycle" && event.command_uuid === turn?.commandUuid && event.state === "started") turn.started = true;
      if (event.type === "command_lifecycle" && event.session_id === this.sessionId && !event.parent_tool_use_id
        && typeof event.command_uuid === "string" && event.command_uuid) {
        if (event.state === "started" && event.command_uuid !== turn?.commandUuid && event.command_uuid !== this.backgroundCommand && !this.stopping) {
          this.backgroundCommand = event.command_uuid; this.backgroundDone = Promise.withResolvers();
          this.onBackgroundEvent({ type: "background_turn", active: true });
        } else if (["completed", "cancelled"].includes(event.state) && event.command_uuid === this.backgroundCommand) this.finishBackground();
      }
      if (turn && (turn.started || event.type === "control_response" || event.type === "system" || event.type === "command_lifecycle")) {
        turn.stdout.write(`${JSON.stringify(event)}\n`);
        if (event.type === "result") this.finish(turn, 0, null);
      } else if (event.type !== "command_lifecycle") this.onBackgroundEvent(event);
      // Persist the final native report before releasing queued user input.
      if (workflowsCompleted) this.onWorkflowsChanged();
    });
    const diagnostics = CLAUDE_SCHEDULE_DIAGNOSTICS.every(argument => args.includes(argument));
    const decoder = new StringDecoder("utf8"); let stderr = "", dropping = false;
    const stderrLine = line => {
      if (/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z \[DEBUG\] /.test(line)) this.trackScheduleDiagnostic(line);
      else this.active?.stderr.write(`${line}\n`);
    };
    child.stderr.on("data", chunk => {
      if (!diagnostics) { this.active?.stderr.write(chunk); return; }
      const lines = (stderr + decoder.write(chunk)).split("\n"); stderr = lines.pop();
      for (const line of lines) {
        if (!dropping && line.length <= 8192) stderrLine(line);
        dropping = false;
      }
      if (stderr.length > 8192) { stderr = ""; dropping = true; }
    });
    child.once("error", error => {
      this.error = error;
      if (this.active?.listenerCount("error")) this.active.emit("error", error);
    });
    child.once("close", (code, signal) => {
      if (diagnostics && stderr && !dropping) stderrLine(stderr + decoder.end());
      this.ended = true; this.control.close(); this.lines.close();
      this.finishBackground();
      this.workflowCalls.clear();
      const workflows = this.workflows.size;
      for (const workflow of this.workflows.values()) workflow.terminal.resolve();
      this.workflowReport?.done.resolve(); this.workflowReport = null;
      this.workflows.clear();
      if (workflows) this.onWorkflowsChanged();
      this.scheduleCalls.clear();
      const scheduled = this.hasScheduledWork();
      this.scheduledJobs.clear(); this.fixedJobs.clear(); this.reportedJobs.clear(); this.restoredJobs = 0; this.dynamicWakeup = null;
      if (scheduled) this.onSchedulesChanged();
      // A logical reply is successful only after its native result. An empty
      // clean process exit must not masquerade as a completed application run.
      if (this.active) this.finish(this.active, code === 0 ? 1 : code, signal);
      this.resolveClosed();
    });
  }

  finishBackground() {
    if (!this.backgroundCommand) return;
    this.backgroundCommand = null; this.backgroundDone.resolve();
    this.onBackgroundEvent({ type: "background_turn", active: false });
  }

  async interruptBackground() {
    if (!this.backgroundCommand) return;
    const done = this.backgroundDone.promise;
    this.requests?.cancel(); this.scheduleCalls.clear();
    await this.control.request("interrupt");
    let timer;
    try {
      await Promise.race([done, new Promise((_, reject) => { timer = setTimeout(() => reject(Error("Native scheduled task did not acknowledge cancellation. Stop the worker before retrying; the queued message was not sent.")), this.controlTimeoutMs); })]);
    } finally { clearTimeout(timer); }
  }

  hasWorkflowWork() { return this.workflows.size > 0; }

  trackWorkflows(event) {
    if (this.ended || this.stopping || event.session_id !== this.sessionId || event.parent_tool_use_id) return;
    const before = this.workflows.size;
    const canStart = !this.active?.interrupting && !this.requests?.suspended;
    const validId = id => typeof id === "string" && id.length > 0 && id.length <= 200;
    // Retain only an actual native task bound to this main session's tool use.
    // Workflow prompts, child tasks and quoted/foreign IDs are not evidence.
    if (canStart && event.type === "assistant" && Array.isArray(event.message?.content)) {
      for (const block of event.message.content) if (block.type === "tool_use" && ["Workflow", "RunWorkflow"].includes(block.name)
        && validId(block.id) && this.workflowCalls.size < 100) this.workflowCalls.add(block.id);
    } else if (event.type === "user" && Array.isArray(event.message?.content)) {
      for (const block of event.message.content) if (block.type === "tool_result") this.workflowCalls.delete(block.tool_use_id);
    } else if (canStart && event.type === "system" && event.subtype === "task_started" && event.task_type === "local_workflow"
      && validId(event.task_id) && this.workflowCalls.has(event.tool_use_id) && !this.workflows.has(event.task_id)) {
      this.workflows.set(event.task_id, { toolUseId: event.tool_use_id, terminal: Promise.withResolvers(), settled: false });
    } else if (event.type === "system" && event.subtype === "task_notification") {
      const workflow = this.workflows.get(event.task_id);
      if (workflow && workflow.toolUseId === event.tool_use_id && ["completed", "failed", "stopped"].includes(event.status)) {
        workflow.settled = true; workflow.terminal.resolve();
        if (event.status === "stopped") this.workflows.delete(event.task_id);
        // This reports computation, not consumption of its result. Even when
        // a foreground command is active, a separate native notification query
        // can still be pending after that command's lifecycle completes.
      }
    } else if (event.type === "result") {
      this.workflowCalls.clear();
      if (event.origin?.kind === "task-notification" && this.workflowReport) {
        event.relayWorkflowInterrupted = this.workflowReport.interrupting === true && event.subtype === "error_during_execution";
        for (const id of this.workflowReport.ids) this.workflows.delete(id);
        this.workflowReport.done.resolve(); this.workflowReport = null;
      }
    }
    if (!this.active?.started && !this.backgroundCommand && !this.workflowReport
      && (event.type === "stream_event" && event.event?.type === "message_start" || event.type === "assistant")) {
      // Installed SDK task-notification turns do not emit command_lifecycle.
      // Bind the report's first main output to already-settled tasks. A later
      // completion must wait for its own report rather than this one's result.
      const ids = [...this.workflows].filter(([, workflow]) => workflow.settled).map(([id]) => id);
      if (ids.length) this.workflowReport = { ids, done: Promise.withResolvers() };
    }
    if (before !== this.workflows.size) {
      if (event.type === "result") return true;
      this.onWorkflowsChanged();
    }
  }

  async interruptWorkflows() {
    this.workflowCalls.clear();
    const targets = [...this.workflows];
    for (const [id, workflow] of targets) {
      try { await this.control.request("stop_task", { task_id: id }); }
      catch (error) { throw Error(error.message === "Blocked by managed policy" ? "Native workflow cancellation was blocked by managed policy; the queued message was not sent." : "Native workflow cancellation failed; the queued message was not sent. Retry or explicitly Stop the worker."); }
      let timer;
      try {
        await Promise.race([workflow.terminal.promise, new Promise((_, reject) => {
          timer = setTimeout(() => reject(Error("Native workflow did not acknowledge cancellation. Stop the worker before retrying; the queued message was not sent.")), this.controlTimeoutMs);
        })]);
        if (this.ended) throw Error("Native workflow owner stopped during cancellation; the queued message was not sent.");
      } finally { clearTimeout(timer); }
    }
    // Work can complete while stop_task is in flight. Inspect the latest
    // state after its receipt, including a summary query before its first
    // token; it still needs an actual task-notification cancellation result.
    const awaitingReport = targets.filter(([id, workflow]) => this.workflows.get(id) === workflow && workflow.settled).map(([id]) => id);
    if (!this.workflowReport && awaitingReport.length) this.workflowReport = { ids: awaitingReport, done: Promise.withResolvers() };
    const report = this.workflowReport;
    if (report && this.workflowReport === report) {
      report.interrupting = true;
      try { await this.control.request("interrupt"); }
      catch {
        report.interrupting = false;
        throw Error("Native workflow report cancellation failed; the queued message was not sent. Retry or explicitly Stop the worker.");
      }
      let timer;
      try {
        await Promise.race([report.done.promise, new Promise((_, reject) => {
          timer = setTimeout(() => reject(Error("Native workflow report did not acknowledge cancellation; the queued message was not sent.")), this.controlTimeoutMs);
        })]);
        if (this.ended) throw Error("Native workflow owner stopped during report cancellation; the queued message was not sent.");
      } finally { clearTimeout(timer); }
    }
    for (const [id, workflow] of targets) {
      if (this.workflows.get(id) === workflow) { this.workflows.delete(id); this.onWorkflowsChanged(); }
    }
  }

  hasScheduledWork() { return Boolean(this.scheduledJobs.size || this.restoredJobs || this.dynamicWakeup); }

  scheduleState() { return `${this.restoredJobs}:${this.dynamicWakeup?.id || (this.dynamicWakeup ? "pending" : "")}:${[...this.scheduledJobs].sort().join(",")}`; }

  clearDynamicWakeup() {
    if (this.dynamicWakeup?.id) {
      this.scheduledJobs.delete(this.dynamicWakeup.id); this.reportedJobs.delete(this.dynamicWakeup.id);
    }
    this.dynamicWakeup = null;
  }

  bindDynamicWakeup() {
    if (!this.dynamicWakeup) return;
    // Keep an already-observed identity while a replacement is being armed.
    // A later scheduling record must not erase the old ID before its native
    // replacement receipt lets us remove it from the observed pending set.
    if (this.dynamicWakeup.id && this.reportedJobs.has(this.dynamicWakeup.id) && !this.fixedJobs.has(this.dynamicWakeup.id)) return;
    // Native wakeup results have no ID. Pair only a unique new native job
    // since that bound tool call; existing/restored/CronCreate jobs cannot be
    // cancelled with the dynamic loop. Ambiguous IDs stay conservatively
    // awake until a native snapshot/deletion resolves them; never guess.
    const candidates = [...this.reportedJobs].filter(id => !this.fixedJobs.has(id) && !this.dynamicWakeup.existing.has(id));
    this.dynamicWakeup.id = candidates.length === 1 ? candidates[0] : null;
  }

  removeSchedule(id) {
    this.scheduledJobs.delete(id); this.fixedJobs.delete(id); this.reportedJobs.delete(id);
    if (this.dynamicWakeup?.id === id) this.dynamicWakeup = null;
  }

  trackScheduleDiagnostic(line) {
    if (this.ended || this.stopping) return;
    const match = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z \[DEBUG\] (.*)$/.exec(line);
    if (!match) return;
    const text = match[1], before = this.hasScheduledWork();
    const restored = /^resume: resurrected ([1-9]\d?) session cron task\(s\)$/.exec(text);
    const scheduled = /^\[ScheduledTasks\] scheduled ([a-f0-9]{8}) for (never|\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z)$/.exec(text);
    const fired = /^\[ScheduledTasks\] firing ([a-f0-9]{8})( \(recurring\))?$/.exec(text);
    const expired = /^\[ScheduledTasks\] recurring task ([a-f0-9]{8}) aged out \(\d+h since creation\), deleting after final fire$/.exec(text);
    const cancelled = /^\[loop\/dynamic\] cancelled \d+ pending loop wakeup\(s\) on user abort(?: \(tick in flight\))?$/.test(text);
    if (restored && !this.restorationObserved && Number(restored[1]) <= 50 && !this.active?.interrupting && !this.requests?.suspended) {
      this.restorationObserved = true; this.restoredJobs = Number(restored[1]);
    }
    if (scheduled && !this.active?.interrupting && !this.requests?.suspended) {
      const fixed = this.restoredJobs || !this.dynamicWakeup && ![...this.scheduleCalls.values()].some(call => call.name === "ScheduleWakeup");
      if (!this.scheduledJobs.has(scheduled[1])) this.restoredJobs = Math.max(0, this.restoredJobs - 1);
      if (scheduled[2] === "never") this.removeSchedule(scheduled[1]);
      else if (this.scheduledJobs.has(scheduled[1]) || this.scheduledJobs.size < 50) {
        if (fixed) this.fixedJobs.add(scheduled[1]);
        this.scheduledJobs.add(scheduled[1]); this.reportedJobs.add(scheduled[1]); this.bindDynamicWakeup();
      }
    }
    if (fired && !fired[2]) this.removeSchedule(fired[1]);
    if (expired) this.removeSchedule(expired[1]);
    if (cancelled) this.clearDynamicWakeup();
    if (before !== this.hasScheduledWork()) this.onSchedulesChanged();
  }

  trackSchedules(event) {
    // Native structured results, bound to a reported main-session tool call.
    // Neither quoted text nor child/foreign/failed/late results keep a worker
    // awake. This observes native scheduling; it never grants tool permission.
    if (this.ended || this.stopping || this.active?.interrupting || this.requests?.suspended
      || event.session_id !== this.sessionId || event.parent_tool_use_id) return;
    const blocks = event.message?.content;
    if (event.type === "assistant" && Array.isArray(blocks)) {
      for (const block of blocks) if (block.type === "tool_use" && typeof block.id === "string" && block.id
        && ["CronCreate", "CronDelete", "CronList", "ScheduleWakeup"].includes(block.name)) this.scheduleCalls.set(block.id, {
          ...block, ...(block.name === "ScheduleWakeup" ? { existing: new Set([...this.scheduledJobs, ...this.reportedJobs]) } : {}),
        });
    } else if (event.type === "user" && Array.isArray(blocks)) {
      const results = blocks.filter(block => block.type === "tool_result");
      if (results.length !== 1) return;
      const result = results[0], call = this.scheduleCalls.get(result.tool_use_id);
      this.scheduleCalls.delete(result.tool_use_id);
      const data = event.tool_use_result, validId = id => typeof id === "string" && /^[a-f0-9]{8}$/.test(id);
      if (!call || result.is_error || !data || typeof data !== "object" || Array.isArray(data)) return;
      const before = this.scheduleState();
      if (call.name === "CronCreate" && validId(data.id) && typeof data.recurring === "boolean" && typeof data.humanSchedule === "string") {
        this.scheduledJobs.add(data.id); this.fixedJobs.add(data.id); this.bindDynamicWakeup();
      }
      if (call.name === "CronDelete" && validId(data.id) && data.id === call.input?.id) {
        if (!this.scheduledJobs.has(data.id)) this.restoredJobs = Math.max(0, this.restoredJobs - 1);
        this.removeSchedule(data.id);
      }
      if (call.name === "CronList" && Array.isArray(data.jobs) && data.jobs.length <= 50 && data.jobs.every(job => job && validId(job.id))) {
        this.scheduledJobs = new Set(data.jobs.map(job => job.id)); this.restoredJobs = 0;
        this.reportedJobs = new Set(this.scheduledJobs);
        this.fixedJobs = new Set([...this.fixedJobs].filter(id => this.scheduledJobs.has(id)));
        if ((this.dynamicWakeup?.id && !this.scheduledJobs.has(this.dynamicWakeup.id)) || !data.jobs.length) this.clearDynamicWakeup();
        else if (this.dynamicWakeup) this.bindDynamicWakeup();
        else this.fixedJobs = new Set(this.scheduledJobs);
      }
      if (call.name === "ScheduleWakeup" && Number.isSafeInteger(data.scheduledFor) && data.scheduledFor >= 0
        && typeof data.wasClamped === "boolean" && Number.isInteger(data.clampedDelaySeconds)
        && (data.scheduledFor === 0 && data.clampedDelaySeconds === 0 && (call.input?.stop === true ? data.stopped === true : data.stopped !== true)
          || call.input?.stop !== true && data.stopped !== true && data.scheduledFor > 0 && data.clampedDelaySeconds >= 60 && data.clampedDelaySeconds <= 3600)) {
        // A zero non-stop result means no NEW wakeup (gate off or expiry),
        // not proof that an already-pending native job was removed. A fired
        // job, explicit stop or native list supplies that removal evidence.
        if (data.stopped === true || data.scheduledFor > 0) this.clearDynamicWakeup();
        if (data.scheduledFor > 0) { this.dynamicWakeup = { id: null, existing: call.existing }; this.bindDynamicWakeup(); }
      }
      if (before !== this.scheduleState()) this.onSchedulesChanged();
    } else if (event.type === "result") this.scheduleCalls.clear();
  }

  async open(args, env, { resetEffort = false } = {}) {
    if (this.ended || this.error) throw this.error || Error("Claude application session ended; retry to resume it");
    if (this.pending || this.active) throw Error("A Claude application turn is already running");
    this.pending = true;
    try {
      if (!this.initialized) {
        await this.control.request("initialize");
        if (resetEffort) await this.control.request("apply_flag_settings", { settings: { effortLevel: null } });
        this.initialized = true;
      }
      else {
        // The native controls cannot replace an appended system prompt. Never
        // keep using stale handoff/security instructions or replace Claude's
        // entire base prompt just to update Relay's suffix.
        if (flag(args, "--append-system-prompt") !== flag(this.args, "--append-system-prompt")) {
          throw Error("This chat's system instructions changed. Stop the application session before retrying to apply them; its running applications have not been stopped.");
        }
        if (env.CLAUDE_CODE_EFFORT_LEVEL !== this.env.CLAUDE_CODE_EFFORT_LEVEL) {
          throw Error("The worker's Claude effort environment changed. Stop the application session before retrying to apply it; its running applications have not been stopped.");
        }
        await this.control.request("set_permission_mode", { mode: flag(args, "--permission-mode") });
        await this.control.request("set_model", { model: flag(args, "--model") || "default" });
        const settings = JSON.parse(flag(args, "--settings") || "{}");
        settings.effortLevel = flag(args, "--effort") || null;
        const enableGatewayFast = env.CLAUDE_CODE_SKIP_FAST_MODE_ORG_CHECK === "1" && this.env.CLAUDE_CODE_SKIP_FAST_MODE_ORG_CHECK !== "1";
        if (enableGatewayFast) {
          // Only the adapter's fresh authenticated account check supplies this
          // compatibility flag. The native settings control applies env changes
          // to a retained CLI too; preserve unrelated flag-layer environment.
          const snapshot = await this.control.request("get_settings");
          if (!Array.isArray(snapshot.sources) || snapshot.sources.some(source => !source || typeof source !== "object") || snapshot.errors?.length) throw Error("Cannot verify native Fast settings; retry after checking the Claude session.");
          const existing = snapshot.sources.find(source => source.source === "flagSettings")?.settings?.env ?? {};
          if (typeof existing !== "object" || Array.isArray(existing)) throw Error("Cannot verify native Fast environment; retry after checking the Claude session.");
          settings.env = { ...existing, CLAUDE_CODE_SKIP_FAST_MODE_ORG_CHECK: "1" };
        }
        await this.control.request("apply_flag_settings", { settings });
        if (enableGatewayFast) this.env = { ...this.env, CLAUDE_CODE_SKIP_FAST_MODE_ORG_CHECK: "1" };
      }
      if (this.ended) throw Error("Claude application session stopped before input");
      const turn = new EventEmitter();
      Object.assign(turn, { stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, signalCode: null });
      const streaming = flag(args, "--input-format") === "stream-json";
      const write = packet => {
        if (this.active !== turn || this.ended) throw Error("Claude application turn stopped before input");
        if (packet.type === "user") {
          if (turn.commandUuid) throw Error("Only one user input is allowed per Claude application turn");
          turn.commandUuid = randomUUID(); packet = { ...packet, uuid: turn.commandUuid };
        }
        this.child.stdin.write(`${JSON.stringify(packet)}\n`);
      };
      let buffer = ""; const decoder = new StringDecoder("utf8");
      turn.stdin = new Writable({
        write: (chunk, _encoding, done) => {
          buffer += decoder.write(chunk);
          if (streaming) {
            const lines = buffer.split("\n"); buffer = lines.pop();
            try { for (const line of lines) if (line) write(JSON.parse(line)); }
            catch (error) { done(error); return; }
          }
          done();
        },
        final: done => {
          try {
            buffer += decoder.end();
            if (buffer.trim()) write(streaming ? JSON.parse(buffer) : { type: "user", message: { role: "user", content: buffer } });
            done();
          } catch (error) { done(error); }
        },
      });
      turn.stdin.on("error", error => {
        if (turn.listenerCount("error")) turn.emit("error", error);
        // A partial native input may already be running: close the transport
        // rather than replaying it or leaving an orphan turn accepting input.
        void this.stop();
      });
      turn.kill = signal => {
        this.requests?.cancel();
        this.scheduleCalls.clear();
        if (signal === "SIGKILL") void terminateWorker(this.child, 0);
        else if (!turn.interrupting) turn.interrupting = this.control.request("interrupt").catch(() => terminateWorker(this.child));
      };
      this.active = turn;
      this.requests?.resume();
      return turn;
    } finally { this.pending = false; }
  }

  finish(turn, code, signal) {
    if (turn !== this.active) return;
    this.active = null;
    turn.exitCode = code; turn.signalCode = signal;
    turn.stdout.end(); turn.stderr.end(); turn.emit("exit", code, signal); turn.emit("close", code, signal);
  }

  async stop() {
    if (this.ended) return;
    this.stopping ||= (async () => {
      this.requests?.cancel();
      this.child.stdin.end();
      await terminateWorker(this.child);
      await this.closed;
    })();
    await this.stopping;
  }
}

// In a streaming session result.usage is per turn, but modelUsage and cost are
// process totals. Relay adds call samples, so convert only those cumulative
// fields to deltas. A native counter reset begins a new baseline.
export function claudeCallResult(current, previous) {
  const difference = (value, before) => typeof value === "number" && Number.isFinite(value)
    ? typeof before === "number" && Number.isFinite(before) && value >= before ? value - before : value
    : value;
  const modelUsage = Object.fromEntries(Object.entries(current.modelUsage || {}).filter(([, model]) => model && typeof model === "object").map(([name, model]) => [name, {
    ...model,
    ...Object.fromEntries(["inputTokens", "outputTokens", "cacheReadInputTokens", "cacheCreationInputTokens", "webSearchRequests", "costUSD"]
      .filter(key => Object.hasOwn(model, key)).map(key => [key, difference(model[key], previous?.modelUsage?.[name]?.[key])])),
  }]));
  return { ...current, modelUsage, total_cost_usd: difference(current.total_cost_usd, previous?.total_cost_usd) };
}
