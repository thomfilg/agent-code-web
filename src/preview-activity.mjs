const cancelled = () => Object.assign(new Error("App preview is no longer active"), { statusCode: 409 });

// Request/stream leases only. This does not start an agent, inspect browsing,
// emit transcript events, or refresh a lease after its fixed deadline.
export class PreviewActivity {
  constructor({ generation, acquire, onChange = async () => {}, timeoutMs = 300000, maxPerChat = 12 }) {
    if (typeof generation !== "function" || typeof acquire !== "function" || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000 || !Number.isSafeInteger(maxPerChat) || maxPerChat < 1 || maxPerChat > 32) throw new Error("Invalid preview activity configuration");
    Object.assign(this, { generation, acquire, onChange, timeoutMs, maxPerChat });
    this.chats = new Map(); this.closed = false;
  }
  has(chatId) { return Boolean(this.chats.get(chatId)?.size); }
  changed(chatId) { void Promise.resolve().then(() => this.onChange(chatId)).catch(() => {}); }
  async hold(chatId, generation, signal) {
    if (this.closed || !Number.isSafeInteger(generation) || generation < 0 || !(signal instanceof AbortSignal) || signal.aborted || this.generation(chatId) !== generation) throw cancelled();
    let entries = this.chats.get(chatId);
    if ((entries?.size || 0) >= this.maxPerChat) throw Object.assign(new Error("Too many active app preview requests"), { statusCode: 429 });
    if (!entries) { entries = new Set(); this.chats.set(chatId, entries); }
    const controller = new AbortController();
    const entry = { controller, release: null };
    let timer, released = false;
    const release = () => {
      if (released) return; released = true;
      clearTimeout(timer); signal.removeEventListener("abort", release); controller.abort();
      entries.delete(entry);
      if (!entries.size && this.chats.get(chatId) === entries) this.chats.delete(chatId);
      this.changed(chatId);
    };
    entry.release = release; entries.add(entry);
    timer = setTimeout(release, this.timeoutMs); timer.unref?.();
    signal.addEventListener("abort", release, { once: true });
    if (signal.aborted) release();
    this.changed(chatId);
    try {
      if (controller.signal.aborted) throw cancelled();
      const executor = await this.acquire(chatId);
      if (this.closed || controller.signal.aborted || this.generation(chatId) !== generation) throw cancelled();
      return Object.freeze({ executor, signal: controller.signal, release });
    } catch (error) { release(); throw error; }
  }
  revokeChat(chatId) { for (const entry of [...(this.chats.get(chatId) || [])]) entry.release(); }
  close() { this.closed = true; for (const chatId of [...this.chats.keys()]) this.revokeChat(chatId); }
}
