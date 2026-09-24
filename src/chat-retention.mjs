const DAY_MS = 86_400_000;
const SCAN_INTERVAL_MS = 60 * 60_000;

export function chatExpired(chat, { now, days, isBusy = () => false }) {
  if (!days || !chat || isBusy(chat.id) || ["starting", "running", "stopping"].includes(chat.status) || chat.queuedMessages?.length) return false;
  const activity = Date.parse(chat.lastActivityAt || chat.createdAt || "");
  return Number.isFinite(activity) && activity <= now - days * DAY_MS;
}

export class ChatRetention {
  #timer = null;
  #running = null;

  constructor({ store, manager, days, now = Date.now, intervalMs = SCAN_INTERVAL_MS, log = console }) {
    Object.assign(this, { store, manager, days, now, intervalMs, log });
  }

  start() {
    if (!this.days || this.#timer) return;
    void this.run().catch(error => this.log.error(`Chat retention scan failed: ${error.message}`));
    this.#timer = setInterval(() => { void this.run().catch(error => this.log.error(`Chat retention scan failed: ${error.message}`)); }, this.intervalMs);
    this.#timer.unref?.();
  }

  async stop() {
    clearInterval(this.#timer);
    this.#timer = null;
    await this.#running;
  }

  run() {
    if (this.#running) return this.#running;
    this.#running = this.#sweep().finally(() => { this.#running = null; });
    return this.#running;
  }

  async #sweep() {
    if (!this.days) return;
    for (const listed of this.store.list()) {
      const chat = this.store.get(listed.id);
      if (!chatExpired(chat, { now: this.now(), days: this.days, isBusy: id => this.manager.isBusy(id) || this.manager.sideChats?.busy(id) })) continue;
      try {
        const result = await this.manager.removeExpired(chat.id, this.now() - this.days * DAY_MS);
        if (result.skipped) continue;
        if (result.cleanupPending) this.log.warn(`Chat retention: worker cleanup pending for ${chat.id}`);
        else this.log.info(`Chat retention: deleted ${chat.id}`);
      } catch (error) {
        this.log.error(`Chat retention: could not delete ${chat.id}: ${error.message}`);
      }
    }
  }
}
