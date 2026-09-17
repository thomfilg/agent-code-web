import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { PassThrough, Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import readline from "node:readline";
import { ClaudeControlChannel } from "./claude-mcp.mjs";
import { terminateWorker } from "./worker-process.mjs";
import { ClaudeRequests } from "./claude-requests.mjs";

const flag = (args, name) => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };

// A Claude application session outlives individual replies. Each turn exposes
// the same stream contract as the one-shot adapter, but a result closes only
// that logical turn, not the CLI which owns its background application tasks.
export class ClaudeSession {
  constructor(child, args, env, onBackgroundEvent = () => {}, { controlTimeoutMs = 30000, requestHooks, cwd } = {}) {
    this.child = child; this.args = args; this.env = env; this.active = null; this.pending = false;
    this.onBackgroundEvent = onBackgroundEvent;
    this.control = new ClaudeControlChannel(child, controlTimeoutMs);
    this.requests = requestHooks ? new ClaudeRequests(child, requestHooks, cwd) : null;
    this.closed = new Promise(resolve => { this.resolveClosed = resolve; });
    this.lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    this.lines.on("line", line => {
      let event; try { event = JSON.parse(line); } catch { return; }
      this.control.accept(event);
      if (this.requests?.accept(event)) return;
      if (event.type === "result") {
        const previous = this.usageBaseline;
        this.usageBaseline = event;
        event = claudeCallResult(event, previous);
      }
      const turn = this.active;
      if (event.type === "command_lifecycle" && event.command_uuid === turn?.commandUuid && event.state === "started") turn.started = true;
      if (turn && (turn.started || event.type === "control_response" || event.type === "system" || event.type === "command_lifecycle")) {
        turn.stdout.write(`${JSON.stringify(event)}\n`);
        if (event.type === "result") this.finish(turn, 0, null);
      } else if (event.type !== "command_lifecycle") this.onBackgroundEvent(event);
    });
    child.stderr.on("data", chunk => this.active?.stderr.write(chunk));
    child.once("error", error => {
      this.error = error;
      if (this.active?.listenerCount("error")) this.active.emit("error", error);
    });
    child.once("close", (code, signal) => {
      this.ended = true; this.control.close(); this.lines.close();
      // A logical reply is successful only after its native result. An empty
      // clean process exit must not masquerade as a completed application run.
      if (this.active) this.finish(this.active, code === 0 ? 1 : code, signal);
      this.resolveClosed();
    });
  }

  async open(args, env) {
    if (this.ended || this.error) throw this.error || Error("Claude application session ended; retry to resume it");
    if (this.pending || this.active) throw Error("A Claude application turn is already running");
    this.pending = true;
    try {
      if (!this.initialized) { await this.control.request("initialize"); this.initialized = true; }
      else {
        // The native controls cannot replace an appended system prompt. Never
        // keep using stale handoff/security instructions or replace Claude's
        // entire base prompt just to update Relay's suffix.
        if (flag(args, "--append-system-prompt") !== flag(this.args, "--append-system-prompt")) {
          throw Error("This chat's system instructions changed. Stop the application session before retrying to apply them; its running applications have not been stopped.");
        }
        if (env.CLAUDE_CODE_SKIP_FAST_MODE_ORG_CHECK === "1" && this.env.CLAUDE_CODE_SKIP_FAST_MODE_ORG_CHECK !== "1") {
          throw Error("Fast needs a Claude startup setting. Stop this application session before enabling Fast; its running applications have not been stopped.");
        }
        await this.control.request("set_permission_mode", { mode: flag(args, "--permission-mode") });
        await this.control.request("set_model", { model: flag(args, "--model") || "default" });
        const settings = JSON.parse(flag(args, "--settings") || "{}");
        settings.effortLevel = flag(args, "--effort") || null;
        await this.control.request("apply_flag_settings", { settings });
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
