// Ephemeral per-tab leases. They expire after crashes/disconnects and never
// wake a stopped worker or enter the agent's transcript/context.
export class ChatPresence {
  constructor({ ttlMs = 45000, onChange = async () => {} } = {}) { this.ttlMs = ttlMs; this.onChange = onChange; this.chats = new Map(); }
  has(chatId) { return [...(this.chats.get(chatId)?.clients.values() || [])].some(expires => expires > Date.now()); }
  async set(chatId, clientId, active) {
    if (typeof clientId !== "string" || !/^[a-zA-Z0-9_-]{16,80}$/.test(clientId) || typeof active !== "boolean") throw new Error("Invalid tab presence");
    let entry = this.chats.get(chatId);
    // Compare against the last announced state, not the wall clock. An expired
    // lease may be closed/refreshed before its queued timer gets CPU time.
    const before = Boolean(entry?.active);
    if (!entry) { if (!active) return; entry = { clients: new Map(), active: false }; this.chats.set(chatId, entry); }
    if (active && !entry.clients.has(clientId) && entry.clients.size >= 32) throw new Error("Too many active chat tabs");
    if (active) entry.clients.set(clientId, Date.now() + this.ttlMs); else entry.clients.delete(clientId);
    this.schedule(chatId, entry);
    entry.active = entry.clients.size > 0;
    if (before !== entry.active) await this.onChange(chatId);
  }
  schedule(chatId, entry) {
    clearTimeout(entry.timer);
    const now = Date.now();
    for (const [id, expires] of entry.clients) if (expires <= now) entry.clients.delete(id);
    if (!entry.clients.size) { this.chats.delete(chatId); return; }
    entry.timer = setTimeout(() => {
      if (this.chats.get(chatId) !== entry) return;
      const before = entry.active;
      this.schedule(chatId, entry);
      entry.active = entry.clients.size > 0;
      // A timer just before expiry can reschedule across a clock boundary.
      // Notify only when pruning actually removes the last client, once.
      if (before !== entry.active) void this.onChange(chatId).catch(() => {});
    }, Math.max(1, Math.min(...entry.clients.values()) - Date.now()));
    entry.timer.unref?.();
  }
  remove(chatId) { clearTimeout(this.chats.get(chatId)?.timer); this.chats.delete(chatId); }
  clear() { for (const chatId of this.chats.keys()) this.remove(chatId); }
}
