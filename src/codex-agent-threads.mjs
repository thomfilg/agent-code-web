import { createHash, randomUUID } from "node:crypto";
import { publicRequest, responseFor } from "./agent-requests.mjs";
import { clampText, errorMessage, redact } from "./utils.mjs";
import { extractResponse } from "./response-protocol.mjs";
import { SecretTextStream } from "./secret-text-stream.mjs";

const conflict = message => Object.assign(new Error(message), { statusCode: 409 });
const denied = () => Object.assign(new Error("Agent thread not found in this chat"), { statusCode: 404 });
const validId = id => typeof id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(id);
const parentId = thread => thread?.parentThreadId || thread?.source?.subAgent?.thread_spawn?.parent_thread_id;
const supportedRequests = new Set(["item/commandExecution/requestApproval", "item/fileChange/requestApproval", "item/tool/requestUserInput", "item/permissions/requestApproval"]);

function visibleItem(item, turnId) {
  if (!item?.id) return null;
  let role, text;
  if (item.type === "userMessage") { role = "user"; text = (item.content || []).map(part => part.type === "text" ? part.text : part.type === "localImage" || part.type === "image" ? "[Image supplied to this agent]" : "").filter(Boolean).join("\n"); }
  else if (item.type === "agentMessage" || item.type === "plan") { role = "assistant"; text = extractResponse(item.text || "", false).text; }
  else if (item.type === "commandExecution") { role = "tool"; text = `${item.command || "Shell command"}\n${item.aggregatedOutput || ""}`; }
  else if (item.type === "fileChange") { role = "tool"; text = `${item.changes?.length || 0} file changes`; }
  else if (item.type === "mcpToolCall" || item.type === "dynamicToolCall") { role = "tool"; text = `${item.tool || "Tool"} · ${item.status || "completed"}`; }
  else if (item.type === "collabAgentToolCall") { role = "tool"; text = `${item.tool} · ${item.status}`; }
  else return null; // Never render private reasoning or protocol metadata as chat prose.
  text = redact(String(text));
  return { id: item.id, turnId, role, text: text.length > 16000 ? `${text.slice(0, 15900)}\n[Long item truncated in this preview]` : text };
}

// One observer per main Codex session. Membership is a chain of native parent
// IDs, never a shared CODEX_HOME, cwd, sessionId or forkedFromId. Side forks and
// other Relay chats therefore cannot enter this picker or receive its input.
export class CodexAgentThreads {
  constructor({ rpc, root, workspace, model, publish, saved = null, log = () => {}, secrets = null, assertCurrent = null }) {
    Object.assign(this, { rpc, root, workspace, model, publish, saved, log, secrets, assertCurrent });
    this.entries = new Map(); this.revision = 0; this.epoch = randomUUID(); this.closed = false; this.pending = new Set(); this.queues = new Map();
    this.listeners = {
      notification: message => this.#enqueue(message, false),
      request: message => this.#enqueue(message, true),
    };
    for (const [event, listener] of Object.entries(this.listeners)) rpc.on(event, listener);
  }
  #track(task) { this.pending.add(task); task.catch(error => { if (!this.closed) this.log(errorMessage(error)); }).finally(() => this.pending.delete(task)); }
  #enqueue(message, request) {
    const id = message.params?.threadId || message.params?.thread?.id;
    if (!id || this.closed) return;
    const task = (this.queues.get(id) || Promise.resolve()).catch(() => {}).then(() => request ? this.#request(message) : this.#notification(message));
    this.queues.set(id, task); this.#track(task);
    void task.finally(() => { if (this.queues.get(id) === task) this.queues.delete(id); }).catch(() => {});
  }
  #check() { if (this.closed || !this.root()) throw conflict("The agent worker is no longer available"); this.assertCurrent?.(this.root()); }
  #nativeRequest(...args) { this.#check(); return this.rpc.request(...args); }
  #emit() {
    if (this.closed) return;
    clearTimeout(this.timer); this.timer = null; this.revision++;
    this.publish(this.snapshot());
  }
  #later() { if (!this.closed) this.timer ||= setTimeout(() => this.#emit(), 80); }
  snapshot() {
    let remaining = 1_000_000;
    // Recently viewed threads keep their bounded transcript first.
    const ordered = [...this.entries.values()].sort((a, b) => (b.viewedAt || 0) - (a.viewedAt || 0));
    return this.#safe({ rootThreadId: this.root(), epoch: this.epoch, revision: this.revision, awake: !this.closed, truncated: Boolean(this.truncated), threads: ordered.map(entry => {
      const messages = entry.messages || [], size = messages.reduce((n, item) => n + item.text.length, 0);
      const include = size <= remaining; if (include) remaining -= size;
      return { id: entry.id, parentThreadId: entry.parentThreadId, name: entry.name, role: entry.role, status: this.closed ? "stopped" : entry.status,
        canAcceptDirectInput: entry.canAcceptDirectInput, messages: include ? messages : [], historyLoaded: include && Boolean(entry.historyLoaded),
        nextCursor: entry.nextCursor || null, pendingRequest: this.closed ? null : [...entry.requests.values()][0]?.public || null, error: entry.error || null };
    }) });
  }
  #safe(value) {
    if (!this.secrets) return value;
    return JSON.parse(JSON.stringify(value, (_key, item) => {
      if (typeof item !== "string") return item;
      for (const secret of [...this.secrets].sort((a, b) => b.length - a.length)) item = item.replaceAll(secret, "[redacted]");
      return item;
    }));
  }
  #finishText(entry, itemId = null) {
    for (const [id, stream] of entry.textRedactors) {
      if (itemId && itemId !== id) continue;
      const item = entry.messages.find(item => item.id === id), tail = stream.finish();
      if (item && tail) item.text = (item.text + tail).slice(0, 16000);
      entry.textRedactors.delete(id);
    }
  }
  busy() { return !this.closed && [...this.entries.values()].some(entry => entry.status === "active" || entry.requests.size || entry.sending); }
  #remember(thread) {
    let entry = this.entries.get(thread.id);
    if (!entry && this.entries.size >= 200) { this.truncated = true; throw conflict("This chat has more than 200 agent threads; the picker is limited to 200"); }
    if (!entry) {
      // Saved content is not proof of membership. Only restore it after a fresh
      // native ancestry check has reached this chat's root.
      const previous = this.saved?.rootThreadId === this.root() ? this.saved.threads.find(item => item.id === thread.id) : null;
      entry = { id: thread.id, messages: structuredClone(previous?.messages || []), historyLoaded: Boolean(previous?.historyLoaded), nextCursor: previous?.nextCursor || null,
        messageVersions: new Map(), requests: new Map(), accepted: new Map(), textRedactors: new Map() };
      this.entries.set(thread.id, entry);
    }
    Object.assign(entry, { parentThreadId: parentId(thread), name: String(thread.agentNickname || thread.name || thread.preview || "Agent").slice(0, 160), role: String(thread.agentRole || "agent").slice(0, 80),
      status: thread.status?.type || entry.status || "notLoaded", canAcceptDirectInput: thread.canAcceptDirectInput ?? null, model: thread.model || entry.model,
      effort: thread.reasoningEffort ?? entry.effort ?? null });
    return entry;
  }
  async #authorize(id, supplied = null) {
    this.#check();
    if (!validId(id) || id === this.root()) throw denied();
    if (this.entries.has(id)) return this.entries.get(id);
    const chain = [], visited = new Set(); let next = id;
    while (next !== this.root() && !this.entries.has(next)) {
      if (!validId(next) || visited.has(next) || chain.length >= 64) throw denied();
      visited.add(next);
      let thread = supplied?.id === next ? supplied : null;
      if (!thread) {
        try { thread = (await this.#nativeRequest("thread/read", { threadId: next, includeTurns: false }, 10000)).thread; }
        catch { throw denied(); }
      }
      this.#check();
      if (thread?.id !== next || !parentId(thread)) throw denied();
      chain.push(thread); next = parentId(thread);
    }
    for (const thread of chain.reverse()) this.#remember(thread);
    return this.entries.get(id);
  }
  async refresh() {
    this.#check();
    let cursor = null; const seen = new Set();
    do {
      const result = await this.#nativeRequest("thread/list", { ancestorThreadId: this.root(), sourceKinds: ["subAgentThreadSpawn"], limit: 100, ...(cursor ? { cursor } : {}) }, 10000);
      this.#check();
      for (const thread of result.data || []) {
        try { await this.#authorize(thread.id, thread); const entry = this.#remember(thread); if (["active", "idle"].includes(entry.status)) await this.#subscribe(entry); } catch (error) { if (error.statusCode !== 404) throw error; }
      }
      cursor = result.nextCursor;
      if (cursor && seen.has(cursor)) throw new Error("Codex repeated an agent-list cursor");
      if (cursor) seen.add(cursor);
      if (this.entries.size >= 200 || seen.size >= 20) { this.truncated = Boolean(cursor); break; }
    } while (cursor);
    this.#emit(); return this.snapshot();
  }
  async select(id, cursor = null) {
    const entry = await this.#authorize(id);
    if (cursor != null && (typeof cursor !== "string" || cursor.length > 4096)) throw new Error("Invalid agent history cursor");
    // Resuming a loaded thread joins it; do not set cwd, role, model, goals or
    // recreate a missing thread. Merely viewing must not change its work.
    await this.#subscribe(entry);
    const page = await this.#history(entry, cursor);
    entry.viewedAt = Date.now(); this.#emit();
    return { ...this.snapshot(), page: this.#safe(page) };
  }
  async #subscribe(entry) {
    if (entry.subscribed) return;
    entry.subscribing ||= (async () => {
      const result = await this.#nativeRequest("thread/resume", { threadId: entry.id, excludeTurns: true }, 10000);
      this.#check(); if (result.thread?.id !== entry.id || parentId(result.thread) !== entry.parentThreadId) throw denied();
      this.#remember(result.thread); entry.subscribed = true;
    })().finally(() => { entry.subscribing = null; });
    await entry.subscribing;
  }
  async #history(entry, cursor = null) {
    const generation = entry.version || 0;
    const result = await this.#nativeRequest("thread/items/list", { threadId: entry.id, limit: 20, sortDirection: "desc", ...(cursor ? { cursor } : {}) }, 10000);
    this.#check();
    const messages = (result.data || []).map(row => visibleItem(row.item, row.turnId)).filter(Boolean).reverse();
    if (!cursor) {
      // A live delta/completion received while history was in flight wins.
      const live = entry.messages.filter(item => (entry.messageVersions.get(item.id) || 0) > generation);
      const merged = new Map(messages.map(item => [item.id, item])); for (const item of live) merged.set(item.id, item);
      entry.messages = [...merged.values()]; this.#bound(entry); entry.historyLoaded = true; entry.nextCursor = result.nextCursor || null;
    }
    return { threadId: entry.id, messages, nextCursor: result.nextCursor || null };
  }
  #bound(entry) {
    let size = entry.messages.reduce((n, message) => n + message.text.length, 0);
    while (entry.messages.length > 60 || size > 500000) { const removed = entry.messages.shift(); size -= removed.text.length; entry.messageVersions.delete(removed.id); entry.textRedactors.delete(removed.id); }
  }
  async send(id, input, mode) {
    const entry = await this.#authorize(id), text = clampText(input.text, 100000, "agent message"), requestId = input.requestId;
    if (!/^[A-Za-z0-9_-]{8,100}$/.test(requestId || "")) throw new Error("An agent message request ID is required");
    if (/^\/[\w:-]+(?:\s|$)/.test(text)) throw new Error("Use the main composer for slash commands; this composer sends text to the selected agent");
    const digest = createHash("sha256").update(text).digest("hex"), prior = entry.accepted.get(requestId);
    if (prior) { if (prior.digest !== digest) throw conflict("This request ID was used for a different message"); await prior.promise; return this.snapshot(); }
    if (entry.sending) throw conflict("An input is already being sent to this agent");
    entry.sending = true; entry.error = null;
    const action = { digest }; entry.accepted.set(requestId, action);
    action.promise = (async () => {
      await this.select(id);
      if (entry.canAcceptDirectInput === false) throw conflict("This native agent cannot accept direct input");
      const current = await this.#nativeRequest("thread/turns/list", { threadId: id, limit: 1, sortDirection: "desc", itemsView: "notLoaded" }, 10000);
      this.#check();
      const active = current.data?.find(turn => turn.status === "inProgress");
      const start = () => this.#nativeRequest("turn/start", { threadId: id, clientUserMessageId: requestId, input: [{ type: "text", text }],
        approvalPolicy: "on-request", approvalsReviewer: mode === "auto" ? "auto_review" : "user",
        sandboxPolicy: mode === "plan" ? { type: "readOnly" } : { type: "workspaceWrite", writableRoots: [this.workspace], networkAccess: false },
        collaborationMode: { mode: mode === "plan" ? "plan" : "default", settings: { model: entry.model || this.model, reasoning_effort: entry.effort, developer_instructions: null } },
      }, 10000);
      if (active) {
        try { await this.#nativeRequest("turn/steer", { threadId: id, expectedTurnId: active.id, clientUserMessageId: requestId, input: [{ type: "text", text }] }, 10000); }
        catch (error) {
          // The previous turn can finish after our read. Only this definitive
          // not-delivered rejection is safe to retry as a fresh native turn.
          if (!/turn\/steer: no active turn to steer\b/i.test(error.message)) throw error;
          this.#check(); await start();
        }
      } else await start();
      // Native item notifications/history are the source of truth. Do not
      // fabricate a user message in the main transcript or duplicate a steer.
    })();
    this.#emit();
    try { await action.promise; while (entry.accepted.size > 128) entry.accepted.delete(entry.accepted.keys().next().value); }
    catch (error) {
      entry.error = errorMessage(error);
      // A definitive native rejection is safe to retry. A timeout might have
      // delivered input; retain that request ID rather than sending it twice.
      if (!/timed?\s*out|timeout/i.test(error.message)) entry.accepted.delete(requestId);
      throw error;
    }
    finally { entry.sending = false; this.#emit(); }
    return this.snapshot();
  }
  async interrupt(id) {
    const entry = await this.#authorize(id);
    const { goal } = await this.#nativeRequest("thread/goal/get", { threadId: id }, 10000);
    this.#check();
    if (goal?.status === "active") await this.#nativeRequest("thread/goal/set", { threadId: id, status: "paused" }, 10000);
    const current = await this.#nativeRequest("thread/turns/list", { threadId: id, limit: 1, sortDirection: "desc", itemsView: "notLoaded" }, 10000);
    this.#check(); const active = current.data?.find(turn => turn.status === "inProgress");
    if (active) await this.#nativeRequest("turn/interrupt", { threadId: id, turnId: active.id }, 10000);
    this.#check();
    entry.error = null; this.#emit(); return this.snapshot();
  }
  async respond(id, requestId, input) {
    const entry = await this.#authorize(id), request = entry.requests.get(requestId);
    if (!request) throw conflict("This agent request is no longer active");
    const result = responseFor(request.public, input);
    this.#check(); this.rpc.respond(request.rpcId, result); entry.requests.delete(requestId); this.#emit(); return this.snapshot();
  }
  async #request(message) {
    const id = message.params?.threadId;
    if (!validId(id) || id === this.root() || this.closed || !this.root()) return;
    let entry; try { entry = await this.#authorize(id); } catch { return; }
    if (!supportedRequests.has(message.method)) { this.rpc.respondError(message.id, -32601, `Unsupported agent request: ${message.method}`); return; }
    const requestId = `approval_${message.id}`;
    entry.requests.set(requestId, { rpcId: message.id, public: publicRequest({ requestId, method: message.method, params: message.params }) });
    this.#emit();
  }
  async #notification({ method, params = {} }) {
    const id = params.threadId || params.thread?.id;
    if (!validId(id) || this.closed || !this.root()) return;
    if (id === this.root()) {
      if (method === "item/completed" || method === "item/started") await this.#discover(params.item);
      return;
    }
    // Ignore global/foreign events. A first child event can precede list refresh.
    if (!this.entries.has(id) && !["thread/started", "thread/status/changed", "turn/started"].includes(method)) return;
    let entry; try { entry = await this.#authorize(id, params.thread); } catch { return; }
    entry.version = (entry.version || 0) + 1;
    if (method === "thread/started") { this.#remember(params.thread); if (["active", "idle"].includes(entry.status)) await this.#subscribe(entry); }
    if (method === "thread/status/changed") entry.status = params.status?.type || entry.status;
    if (method === "thread/name/updated") entry.name = String(params.threadName || params.name || entry.name).slice(0, 160);
    if (["turn/started", "turn/completed", "thread/closed", "thread/archived", "thread/deleted"].includes(method)) this.#finishText(entry);
    if (method === "turn/started") { entry.status = "active"; entry.turnId = params.turn?.id; }
    if (method === "turn/completed") { entry.status = "idle"; entry.turnId = null; entry.requests.clear(); entry.error = params.turn?.error?.message || null; }
    if (method === "thread/closed" || method === "thread/archived" || method === "thread/deleted") { entry.status = "notLoaded"; entry.requests.clear(); entry.subscribed = false; }
    if (method === "serverRequest/resolved") entry.requests.delete(`approval_${params.requestId}`);
    if (method === "item/agentMessage/delta") {
      let item = entry.messages.find(item => item.id === params.itemId);
      if (!item) { item = { id: params.itemId, turnId: params.turnId, role: "assistant", text: "" }; entry.messages.push(item); }
      if (this.secrets && !entry.textRedactors.has(item.id)) entry.textRedactors.set(item.id, new SecretTextStream(this.secrets));
      const stream = entry.textRedactors.get(item.id);
      item.text = (item.text + (stream ? stream.push(params.delta || "") : params.delta || "")).slice(0, 16000); this.#bound(entry);
      entry.messageVersions.set(item.id, entry.version);
    }
    if (method === "item/started" || method === "item/completed") {
      if (method === "item/completed") this.#finishText(entry, params.item?.id);
      const item = visibleItem(params.item, params.turnId);
      if (item) { const index = entry.messages.findIndex(row => row.id === item.id); if (index < 0) entry.messages.push(item); else entry.messages[index] = item; entry.messageVersions.set(item.id, entry.version); this.#bound(entry); }
      await this.#discover(params.item);
    }
    this.#later();
  }
  async #discover(item) {
    const ids = item?.type === "collabAgentToolCall" ? item.receiverThreadIds || [] : item?.type === "subAgentActivity" ? [item.agentThreadId] : [];
    for (const id of ids) {
      try { const child = await this.#authorize(id); if (["active", "idle"].includes(child.status)) await this.#subscribe(child); } catch { /* Tool text alone is never proof of ancestry. */ }
    }
    if (ids.length) this.#later();
  }
  async close() {
    if (this.closed) return;
    this.closed = true; clearTimeout(this.timer);
    for (const [event, listener] of Object.entries(this.listeners)) this.rpc.off(event, listener);
    // The owning adapter stops the shared process. Hiding a panel never closes
    // native child agents or changes their parent/goal/queue.
    await Promise.allSettled([...this.pending]);
    for (const entry of this.entries.values()) this.#finishText(entry);
    this.revision++; this.publish(this.snapshot());
  }
}
