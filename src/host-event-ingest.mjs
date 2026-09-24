import { watch } from "node:fs";
import { lstat, mkdir, readFile, readdir, unlink } from "node:fs/promises";
import path from "node:path";

const eventFile = /^[a-f0-9]{64}\.json$/;
const exactContainer = /^[a-f0-9]{64}$/;
const exactName = /^(?:relay|relay-rollback-[a-f0-9]{7,40}-[0-9]{8,16})$/;
const actions = new Set(["create", "start", "stop", "die", "oom", "destroy", "restart", "kill", "health_status", "snapshot"]);

export function validHostEvent(name, value) {
  if (!eventFile.test(name) || !value || typeof value !== "object" || Array.isArray(value)
    || value.schema !== 1 || value.source !== "docker-host" || value.sourceId !== `docker:${name.slice(0, -5)}`
    || !exactContainer.test(value.containerId || "") || !exactName.test(value.containerName || "")
    || !actions.has(value.action) || typeof value.observedAt !== "string" || value.observedAt.length > 40
    || !Number.isFinite(Date.parse(value.observedAt))
    || value.health !== undefined && (value.action !== "health_status" || !["healthy", "unhealthy", "starting"].includes(value.health))
    || value.status !== undefined && (value.action !== "snapshot" || !["created", "running", "paused", "restarting", "exited", "dead"].includes(value.status))
    || value.oomKilled !== undefined && (value.action !== "snapshot" || typeof value.oomKilled !== "boolean")
    || value.exitCode !== undefined && (!["die", "snapshot"].includes(value.action) || !Number.isInteger(value.exitCode) || value.exitCode < 0 || value.exitCode > 255)
    || value.action === "snapshot" && (value.status === undefined || value.oomKilled === undefined || value.exitCode === undefined)) return false;
  const allowed = new Set(["schema", "source", "sourceId", "containerId", "containerName", "action", "observedAt", "health", "exitCode", "status", "oomKilled"]);
  return Object.keys(value).every(key => allowed.has(key));
}

export class HostEventIngestor {
  constructor({ directory, records, onError = () => {}, auditIntervalMs = 60_000 }) {
    if (!path.isAbsolute(directory) || !records?.appendSystemEvent) throw new Error("Host event ingestor requires a private absolute outbox and durable records");
    if (!Number.isSafeInteger(auditIntervalMs) || auditIntervalMs < 1000) throw new Error("Host event audit interval is invalid");
    Object.assign(this, { directory, records, onError, auditIntervalMs });
    this.closed = false; this.pending = null; this.retry = null; this.watcher = null;
  }

  async start() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const stat = await lstat(this.directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.mode & 0o077) throw new Error("Host event outbox must be private");
    this.#listen();
    await this.refresh();
    // inotify is a wake hint too: recover a missed/coalesced filesystem event
    // without relying on the browser or requiring a controller restart.
    this.audit = setInterval(() => {
      if (!this.watcher) { try { this.#listen(); } catch (error) { this.onError(error); } }
      void this.refresh();
    }, this.auditIntervalMs);
    this.audit.unref?.();
    return this;
  }

  #listen() {
    if (this.closed) return;
    this.watcher = watch(this.directory, () => { void this.refresh(); });
    this.watcher.on("error", error => {
      this.onError(error); this.watcher?.close(); this.watcher = null;
      this.#retry();
    });
  }

  #retry() {
    if (this.closed || this.retry) return;
    this.retry = setTimeout(() => {
      this.retry = null;
      if (!this.watcher) {
        try { this.#listen(); } catch (error) { this.onError(error); this.#retry(); return; }
      }
      void this.refresh();
    }, 2_000);
    this.retry.unref?.();
  }

  refresh() {
    if (this.closed) return Promise.resolve();
    if (this.pending) { this.again = true; return this.pending; }
    this.pending = this.#drain().catch(error => { this.onError(error); this.#retry(); }).finally(() => {
      this.pending = null;
      if (this.again && !this.closed) { this.again = false; void this.refresh(); }
    });
    return this.pending;
  }

  async #drain() {
    const names = (await readdir(this.directory)).filter(name => eventFile.test(name)).sort();
    for (const name of names) {
      if (this.closed) return;
      const filename = path.join(this.directory, name);
      try {
        const stat = await lstat(filename);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096 || stat.mode & 0o077) throw new Error("Unsafe host event file");
        const value = JSON.parse(await readFile(filename, "utf8"));
        if (!validHostEvent(name, value)) throw new Error("Invalid host event payload");
        await this.records.appendSystemEvent(value.sourceId, value);
        // If the process dies after commit but before unlink, source-ID dedupe
        // makes the next start a harmless replay.
        await unlink(filename);
      } catch (error) {
        if (error.code === "ENOENT") continue;
        if (error instanceof SyntaxError || /Unsafe host event file|Invalid host event payload/.test(error.message)) {
          this.onError(new Error(`Host event ${name} rejected`));
          continue;
        }
        throw error;
      }
    }
  }

  async close() {
    this.closed = true; clearTimeout(this.retry); clearInterval(this.audit); this.watcher?.close();
    await this.pending;
  }
}
