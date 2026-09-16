// Controller-owned display snapshots, not native configuration or live approval
// capabilities. Reads never acquire a worker; a new process treats saved
// state as offline until a fresh native observer publishes its own epoch.
export class NativeAgentSnapshots {
  constructor(store, publish) { this.store = store; this.publish = publish; this.cache = new Map(); this.writes = new Map(); this.pending = new Map(); }
  async get(chatId) {
    const chat = this.store.get(chatId);
    let value = this.cache.get(chatId);
    if (!value && this.store.records) {
      const saved = await this.store.records.get("native-agents", chatId);
      if (saved) value = { ...saved, awake: false, threads: saved.threads.map(thread => ({ ...thread, status: "stopped", pendingRequest: null })) };
      if (this.cache.has(chatId)) value = this.cache.get(chatId);
      else if (value) this.cache.set(chatId, value);
    }
    if (chat?.agent !== "codex" || value?.rootThreadId !== chat?.agentSessionId) return { rootThreadId: chat?.agentSessionId || null, epoch: null, revision: 0, awake: false, threads: [] };
    return value || { rootThreadId: chat?.agentSessionId || null, epoch: null, revision: 0, awake: false, threads: [] };
  }
  update(chatId, snapshot) {
    if (!snapshot.rootThreadId || this.store.get(chatId)?.agentSessionId !== snapshot.rootThreadId) return;
    this.cache.set(chatId, snapshot); this.publish(chatId, snapshot);
    const saved = { ...snapshot, awake: false, threads: snapshot.threads.map(thread => ({ ...thread, pendingRequest: null })) };
    this.pending.set(chatId, saved);
    if (this.writes.has(chatId)) return this.writes.get(chatId);
    const writing = Promise.resolve().then(async () => {
      // Coalesce live updates when encrypted storage is slower than streaming.
      // Keep the newest snapshot, never an unbounded queue of large copies.
      while (this.pending.has(chatId)) {
        const next = this.pending.get(chatId); this.pending.delete(chatId);
        if (this.store.get(chatId)?.agentSessionId === next.rootThreadId) await this.store.records?.put("native-agents", chatId, next);
      }
    }).finally(() => { this.writes.delete(chatId); });
    this.writes.set(chatId, writing); return writing;
  }
  async flush(chatId) { await this.writes.get(chatId); }
  forget(chatId) { this.cache.delete(chatId); this.pending.delete(chatId); this.writes.delete(chatId); }
}
