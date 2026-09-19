import { randomUUID } from "node:crypto";
import { redact } from "./utils.mjs";

const validId = value => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const unavailable = () => Object.assign(Error("Native child agent is unavailable in this chat"), { statusCode: 409 });
const terminal = new Set(["idle", "failed", "stopped"]);
const statuses = { pending: "active", running: "active", paused: "paused", completed: "idle", failed: "failed", killed: "stopped", stopped: "stopped" };

// Display/child-control observer only. Never alter ClaudeSession's independent
// workflow/result FIFO, invent a task ID, read child files, or prompt the parent
// on behalf of a child. Membership needs a native Agent call and native ID.
export class ClaudeAgentThreads {
  constructor({ root, control, current, publish = () => {}, secrets = new Set(), stopTimeoutMs = 10000 }) {
    Object.assign(this, { root, control, current, publish, secrets, stopTimeoutMs });
    this.epoch = randomUUID(); this.revision = 0; this.calls = new Map(); this.entries = new Map(); this.closed = false;
  }
  #check() { if (this.closed || !validId(this.root()) || this.current() !== true) throw unavailable(); }
  #safe(value, limit = 16000) {
    let text = String(value ?? "");
    for (const secret of [...this.secrets].filter(value => typeof value === "string" && value).sort((a, b) => b.length - a.length)) text = text.replaceAll(secret, "[redacted]");
    return redact(text.replace(/sk-ant-[A-Za-z0-9_-]{8,}/g, "[redacted]")).slice(0, limit);
  }
  #emit() { if (!this.closed) { this.revision++; this.publish(this.snapshot()); } }
  #message(call, message) {
    const text = this.#safe(message.text); if (!text.trim()) return;
    const row = { ...message, text }, index = call.messages.findIndex(item => item.id === row.id);
    if (index >= 0) call.messages[index] = row; else call.messages.push(row);
    while (call.messages.length > 40 || call.messages.reduce((sum, item) => sum + item.text.length, 0) > 50000) { call.messages.shift(); this.truncated = true; }
  }
  #bind(call, id) {
    if (!validId(id) || id === this.root() || call.id && call.id !== id) return null;
    const previous = this.entries.get(id);
    if (previous && previous !== call) return null;
    call.id = id; this.entries.set(id, call); return call;
  }
  #status(entry, status) {
    if (!statuses[status]) return;
    entry.status = statuses[status];
    if (terminal.has(entry.status)) { entry.stopping = false; entry.error = null; entry.terminal?.resolve(); }
  }
  observe(event) {
    try { this.#check(); } catch { return; }
    if (!event || event.session_id !== this.root()) return;
    const parentCall = event.parent_tool_use_id ? this.calls.get(event.parent_tool_use_id) : null;
    if (event.parent_tool_use_id && !parentCall) return;
    const blocks = event.message?.content;
    if (event.type === "assistant" && Array.isArray(blocks)) {
      if (parentCall && validId(event.uuid || event.message?.id)) {
        for (const [index, block] of blocks.entries()) {
          if (block.type === "text" && typeof block.text === "string") this.#message(parentCall, { id: `${event.uuid || event.message.id}:${index}`, role: "assistant", text: block.text });
          else if (block.type === "tool_use" && typeof block.name === "string") this.#message(parentCall, { id: `${event.uuid || event.message.id}:${index}`, role: "tool", text: `Tool: ${this.#safe(block.name, 100)}` });
        }
      }
      for (const block of blocks) {
        if (block.type !== "tool_use" || block.name !== "Agent" || !validId(block.id) || this.calls.has(block.id)) continue;
        // Nested ancestry must already be backed by a native parent task ID.
        if (parentCall && !parentCall.id) continue;
        if (this.calls.size >= 200) { this.truncated = true; continue; }
        const input = block.input && typeof block.input === "object" ? block.input : {};
        const call = { toolUseId: block.id, parentId: parentCall?.id || this.root(), parentToolUseId: event.parent_tool_use_id || null,
          name: this.#safe(input.name || input.description || "Claude agent", 160), role: this.#safe(input.subagent_type || "agent", 80), status: "active", messages: [] };
        if (typeof input.prompt === "string") this.#message(call, { id: `${block.id}:task`, role: "user", text: input.prompt });
        this.calls.set(block.id, call);
      }
    } else if (event.type === "user" && Array.isArray(blocks)) {
      const results = blocks.filter(block => block.type === "tool_result"); if (results.length !== 1 || results[0].is_error) return;
      const call = this.calls.get(results[0].tool_use_id), data = event.tool_use_result;
      if (!call || call.parentToolUseId !== (event.parent_tool_use_id || null) || !data || !["completed", "async_launched"].includes(data.status) || !this.#bind(call, data.agentId)) return;
      if (data.status === "completed") {
        this.#status(call, "completed");
        const text = Array.isArray(data.content) ? data.content.filter(block => block.type === "text" && typeof block.text === "string").map(block => block.text).join("\n") : "";
        if (text && !call.messages.some(item => item.role === "assistant" && item.text === this.#safe(text))) this.#message(call, { id: `${call.toolUseId}:result`, role: "assistant", text });
      }
    } else if (event.type === "system" && event.subtype === "task_started") {
      const call = this.calls.get(event.tool_use_id);
      if (event.task_type !== "local_agent" || !call || !this.#bind(call, event.task_id)) return;
    } else if (event.type === "system" && ["task_progress", "task_updated", "task_notification"].includes(event.subtype)) {
      const entry = this.entries.get(event.task_id);
      if (!entry || event.tool_use_id && event.tool_use_id !== entry.toolUseId) return;
      if (event.subtype === "task_updated") this.#status(entry, event.patch?.status);
      else if (event.subtype === "task_notification") this.#status(entry, event.status);
      else {
        const usage = event.usage;
        entry.usage = Object.fromEntries(["total_tokens", "tool_uses", "duration_ms"].filter(key => Number.isSafeInteger(usage?.[key]) && usage[key] >= 0).map(key => [key, usage[key]]));
        entry.lastTool = typeof event.last_tool_name === "string" ? this.#safe(event.last_tool_name, 100) : null;
      }
    } else return; // No reasoning, arbitrary task output, ambient workflows or global agent definitions.
    this.#emit();
  }
  snapshot() {
    let remaining = 1_000_000, omitted = false;
    const snapshot = { provider: "claude", rootThreadId: this.root(), epoch: this.epoch, revision: this.revision, awake: !this.closed,
      truncated: Boolean(this.truncated), coverage: "Observed native children from this process only. Direct child messaging is unavailable in this Claude interface.",
      threads: [...this.entries.values()].map(entry => {
        const size = entry.messages.reduce((sum, item) => sum + item.text.length, 0), included = size <= remaining; if (included) remaining -= size; else omitted = true;
        return { id: entry.id, parentThreadId: entry.parentId, name: entry.name, role: entry.role, status: entry.status, messages: included ? entry.messages.map(message => ({ ...message })) : [], historyLimited: !included,
          historyLoaded: false, nextCursor: null, canAcceptDirectInput: false, canStop: !this.closed && ["active", "paused"].includes(entry.status) && !entry.stopping,
          stopping: Boolean(entry.stopping), pendingRequest: null, error: entry.error || null, usage: entry.usage ? { ...entry.usage } : null, lastTool: entry.lastTool || null };
      }) };
    snapshot.truncated ||= omitted;
    return snapshot;
  }
  busy() { return !this.closed && [...this.entries.values()].some(entry => ["active", "paused"].includes(entry.status)); }
  async refresh() { this.#check(); return this.snapshot(); } // No unsupported discovery control or synthetic turn.
  async select(id) { this.#check(); if (!this.entries.has(id)) throw unavailable(); return this.snapshot(); }
  async send() { throw Object.assign(Error("Direct child messaging is not supported by this Claude interface"), { statusCode: 409 }); }
  async respond() { throw Object.assign(Error("Use the main conversation for Claude approval requests"), { statusCode: 409 }); }
  async interrupt(id) {
    this.#check(); const entry = this.entries.get(id);
    if (!entry || !["active", "paused"].includes(entry.status)) throw unavailable();
    if (entry.stopPromise) return entry.stopPromise;
    entry.stopping = true; entry.terminal = Promise.withResolvers(); this.#emit();
    entry.stopPromise = (async () => {
      this.#check(); await this.control.request("stop_task", { task_id: entry.id }); this.#check();
      let timer;
      try {
        await Promise.race([entry.terminal.promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error("Waiting for native confirmation that this child stopped")), this.stopTimeoutMs); })]);
        this.#check(); return this.snapshot();
      } finally { clearTimeout(timer); }
    })().catch(error => {
      entry.error = "Child Stop could not be confirmed. Native status is retained; no input was replayed.";
      this.#emit(); throw error;
    });
    return entry.stopPromise;
  }
  close() {
    if (this.closed) return;
    this.closed = true; for (const entry of this.entries.values()) entry.terminal?.resolve();
    this.revision++; this.publish(this.snapshot());
  }
}
