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
export const CLAUDE_SCHEDULE_DIAGNOSTICS = ["--debug=ScheduledTasks,resume", "--debug-to-stderr"];

// A Claude application session outlives individual replies. Each turn exposes
// the same stream contract as the one-shot adapter, but a result closes only
// that logical turn, not the CLI which owns its background application tasks.
export class ClaudeSession {
  constructor(child, args, env, onBackgroundEvent = () => {}, { controlTimeoutMs = 30000, requestHooks, cwd, onSchedulesChanged = () => {} } = {}) {
    this.child = child; this.args = args; this.env = env; this.active = null; this.pending = false;
    this.sessionId = flag(args, "--session-id") || flag(args, "--resume");
    this.controlTimeoutMs = controlTimeoutMs;
    this.scheduledJobs = new Set(); this.scheduleCalls = new Map(); this.onSchedulesChanged = onSchedulesChanged;
    this.restoredJobs = 0;
    this.onBackgroundEvent = onBackgroundEvent;
    this.control = new ClaudeControlChannel(child, controlTimeoutMs);
    this.requests = requestHooks ? new ClaudeRequests(child, requestHooks, cwd) : null;
    this.closed = new Promise(resolve => { this.resolveClosed = resolve; });
    this.lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    this.lines.on("line", line => {
      let event; try { event = JSON.parse(line); } catch { return; }
      this.control.accept(event);
      if (this.requests?.accept(event)) return;
      this.trackSchedules(event);
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
      this.scheduleCalls.clear();
      if (this.hasScheduledWork()) { this.scheduledJobs.clear(); this.restoredJobs = 0; this.onSchedulesChanged(); }
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

  hasScheduledWork() { return Boolean(this.scheduledJobs.size || this.restoredJobs); }

  trackScheduleDiagnostic(line) {
    if (this.ended || this.stopping) return;
    const match = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z \[DEBUG\] (.*)$/.exec(line);
    if (!match) return;
    const text = match[1], before = this.hasScheduledWork();
    const restored = /^resume: resurrected ([1-9]\d?) session cron task\(s\)$/.exec(text);
    const scheduled = /^\[ScheduledTasks\] scheduled ([a-f0-9]{8}) for (never|\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z)$/.exec(text);
    const fired = /^\[ScheduledTasks\] firing ([a-f0-9]{8})( \(recurring\))?$/.exec(text);
    const expired = /^\[ScheduledTasks\] recurring task ([a-f0-9]{8}) aged out \(\d+h since creation\), deleting after final fire$/.exec(text);
    if (restored && !this.restorationObserved && Number(restored[1]) <= 50 && !this.active?.interrupting && !this.requests?.suspended) {
      this.restorationObserved = true; this.restoredJobs = Number(restored[1]);
    }
    if (scheduled && !this.active?.interrupting && !this.requests?.suspended) {
      if (!this.scheduledJobs.has(scheduled[1])) this.restoredJobs = Math.max(0, this.restoredJobs - 1);
      if (scheduled[2] === "never") this.scheduledJobs.delete(scheduled[1]);
      else if (this.scheduledJobs.size < 50) this.scheduledJobs.add(scheduled[1]);
    }
    if (fired && !fired[2]) this.scheduledJobs.delete(fired[1]);
    if (expired) this.scheduledJobs.delete(expired[1]);
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
        && ["CronCreate", "CronDelete", "CronList"].includes(block.name)) this.scheduleCalls.set(block.id, block);
    } else if (event.type === "user" && Array.isArray(blocks)) {
      const results = blocks.filter(block => block.type === "tool_result");
      if (results.length !== 1) return;
      const result = results[0], call = this.scheduleCalls.get(result.tool_use_id);
      this.scheduleCalls.delete(result.tool_use_id);
      const data = event.tool_use_result, validId = id => typeof id === "string" && /^[a-f0-9]{8}$/.test(id);
      if (!call || result.is_error || !data || typeof data !== "object" || Array.isArray(data)) return;
      const before = `${this.restoredJobs}:${[...this.scheduledJobs].sort().join(",")}`;
      if (call.name === "CronCreate" && validId(data.id) && typeof data.recurring === "boolean" && typeof data.humanSchedule === "string") this.scheduledJobs.add(data.id);
      if (call.name === "CronDelete" && validId(data.id) && data.id === call.input?.id) {
        if (!this.scheduledJobs.delete(data.id)) this.restoredJobs = Math.max(0, this.restoredJobs - 1);
      }
      if (call.name === "CronList" && Array.isArray(data.jobs) && data.jobs.length <= 50 && data.jobs.every(job => job && validId(job.id))) {
        this.scheduledJobs = new Set(data.jobs.map(job => job.id)); this.restoredJobs = 0;
      }
      if (before !== `${this.restoredJobs}:${[...this.scheduledJobs].sort().join(",")}`) this.onSchedulesChanged();
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
