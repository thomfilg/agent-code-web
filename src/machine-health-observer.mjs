import { createHash } from "node:crypto";

const safeState = value => typeof value === "string" && /^[a-z][a-z0-9-]{0,40}$/.test(value) ? value : "unknown";

// Resource utilization has to be sampled; worker/container/EC2 transitions
// arrive through independent event sources. Only changed, sanitized health
// states are committed, so the browser never drives monitoring by polling.
export class MachineHealthObserver {
  constructor({ manager, store, records, intervalMs = 30_000, onError = () => {} }) {
    if (!manager?.machineHealth || !store?.list || !records?.appendWorkerEvent || !records?.get || !records?.put
      || !Number.isSafeInteger(intervalMs) || intervalMs < 5_000 || intervalMs > 300_000) throw new Error("Machine health observer configuration is invalid");
    Object.assign(this, { manager, store, records, intervalMs, onError });
    this.closed = false;
  }

  start() {
    this.timer = setInterval(() => { void this.sample().catch(error => this.onError(new Error(`Machine health sample unavailable (${error?.code || error?.name || "error"})`))); }, this.intervalMs);
    this.timer.unref?.();
    void this.sample().catch(error => this.onError(new Error(`Machine health sample unavailable (${error?.code || error?.name || "error"})`)));
    return this;
  }

  async sample() {
    if (this.closed) return;
    if (this.sampling) return this.sampling;
    this.sampling = this.#sample();
    try { return await this.sampling; } finally { this.sampling = null; }
  }

  async #sample() {
    for (const chat of this.store.list()) {
      if (this.closed) return;
      if (!(["running", "idle", "starting"].includes(chat.status) && chat.workerLifecycle?.state === "active")) continue;
      let snapshot;
      try { snapshot = await this.manager.machineHealth(chat.id); }
      catch (error) { this.onError(new Error(`Machine health unavailable for ${chat.id} (${error?.code || error?.name || "error"})`)); continue; }
      const anomaly = safeState(snapshot.system?.unavailable ? "monitor-unavailable" : snapshot.anomaly || "none");
      const agentState = safeState(snapshot.agent?.state), workerState = safeState(snapshot.worker?.state);
      const generation = chat.workerLifecycle.generation;
      const prior = await this.records.get("health-observation", chat.id);
      if (prior?.anomaly === anomaly && prior?.agentState === agentState && prior?.workerState === workerState
        && prior?.generation === generation) continue;
      const sourceId = `health:${createHash("sha256").update(`${chat.id}:${generation}:${anomaly}:${agentState}:${workerState}:${prior?.sourceId || "initial"}`).digest("hex")}`;
      const event = { type: "machine-health-change", anomaly, agentState, workerState, generation,
        observedAt: typeof snapshot.sampledAt === "string" && Number.isFinite(Date.parse(snapshot.sampledAt)) ? snapshot.sampledAt : new Date().toISOString() };
      if (!this.store.get(chat.id)) continue;
      await this.records.appendWorkerEvent(chat.id, sourceId, event);
      await this.records.put("health-observation", chat.id, { anomaly, agentState, workerState, generation, sourceId });
    }
  }

  async close() {
    this.closed = true; clearInterval(this.timer);
    await this.sampling;
  }
}
