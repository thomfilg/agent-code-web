// Controller-owned display snapshots, not native configuration or live approval
// capabilities. Reads never acquire a worker; a new process treats saved
// state as offline until a fresh native observer publishes its own epoch.
import { companyForChat } from "../public/company-scope.js";

const binding = chat => chat ? JSON.stringify([chat.ownerId || null, chat.agent, chat.agentAccountId || null, chat.environmentId || null, chat.workspace || null, companyForChat(chat), chat.agentSessionId || null]) : null;
const empty = chat => ({ provider: chat?.agent, rootThreadId: chat?.agentSessionId || null, epoch: null, revision: 0, awake: false, threads: [] });

export class NativeAgentSnapshots {
  constructor(store, publish) { this.store = store; this.publish = publish; this.cache = new Map(); this.writes = new Map(); this.pending = new Map(); }
  async get(chatId) {
    const initial = binding(this.store.get(chatId));
    let value = this.cache.get(chatId);
    if (!value && this.store.records) {
      const saved = await this.store.records.get("native-agents", chatId);
      // Old records have no owner/account/environment evidence. Do not infer it
      // from whichever chat happens to own the same native ID today.
      if (saved?.binding === initial && saved.snapshot) value = { binding: initial, snapshot: { ...saved.snapshot, awake: false, threads: saved.snapshot.threads.map(thread => ({ ...thread, status: "stopped", canStop: false, pendingRequest: null })) } };
      if (this.cache.has(chatId)) value = this.cache.get(chatId);
      else if (value) this.cache.set(chatId, value);
    }
    const chat = this.store.get(chatId), snapshot = value?.snapshot;
    if (binding(chat) !== initial || value?.binding !== initial || !["codex", "claude"].includes(chat?.agent) || chat.agent === "claude" && snapshot?.provider !== "claude" || snapshot?.rootThreadId !== chat?.agentSessionId) return empty(chat);
    return snapshot || empty(chat);
  }
  update(chatId, snapshot) {
    if (!snapshot.rootThreadId || this.store.get(chatId)?.agentSessionId !== snapshot.rootThreadId) return;
    const scope = binding(this.store.get(chatId));
    this.cache.set(chatId, { binding: scope, snapshot }); this.publish(chatId, snapshot);
    const saved = { binding: scope, snapshot: { ...snapshot, awake: false, threads: snapshot.threads.map(thread => ({ ...thread, pendingRequest: null })) } };
    this.pending.set(chatId, saved);
    if (this.writes.has(chatId)) return this.writes.get(chatId);
    const writing = Promise.resolve().then(async () => {
      // Coalesce live updates when encrypted storage is slower than streaming.
      // Keep the newest snapshot, never an unbounded queue of large copies.
      while (this.pending.has(chatId)) {
        const next = this.pending.get(chatId); this.pending.delete(chatId);
        if (binding(this.store.get(chatId)) === next.binding) await this.store.records?.put("native-agents", chatId, next);
      }
    }).finally(() => { this.writes.delete(chatId); });
    this.writes.set(chatId, writing); return writing;
  }
  async flush(chatId) { await this.writes.get(chatId); }
  async reconcileStopped(chatId) {
    const current = await this.get(chatId);
    if (!current?.rootThreadId) return current;
    const snapshot = { ...current, awake: false, revision: (current.revision || 0) + 1,
      threads: current.threads.map(thread => ({ ...thread,
        status: ["active", "paused"].includes(thread.status) ? "stopped" : thread.status,
        stopping: false, canStop: false, pendingRequest: null })) };
    await this.update(chatId, snapshot);
    return snapshot;
  }
  forget(chatId) { this.cache.delete(chatId); this.pending.delete(chatId); this.writes.delete(chatId); }
}
