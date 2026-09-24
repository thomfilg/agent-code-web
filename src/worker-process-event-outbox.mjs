import { createHash, randomUUID } from "node:crypto";
import { constants, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { safeId } from "./worker-transport-wire.mjs";

const filenamePattern = /^[a-f0-9]{64}\.json$/;
const sourcePattern = /^worker-supervisor:[a-f0-9]{64}$/;
const kinds = new Set(["started", "exited", "unconfirmed"]);
const digest = value => createHash("sha256").update(value).digest("hex");

// The worker owns this outbox, outside systemd's RuntimeDirectory. An exit is
// fsynced before its event is exposed to the controller; a lost SSH transport
// or daemon restart cannot turn it into an invisible successful exit.
export class WorkerProcessEventOutbox {
  constructor(directory) {
    if (!path.isAbsolute(directory)) throw new Error("Worker process event outbox requires an absolute directory");
    this.directory = directory;
  }

  initialize() {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const stat = lstatSync(this.directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || stat.mode & 0o077) {
      throw new Error("Worker process event outbox must be private");
    }
    return this;
  }

  record(kind, selected, receipt) {
    if (!kinds.has(kind) || !safeId(selected?.chatId) || !safeId(selected?.workerId) || !safeId(selected?.attemptId)
      || !safeId(receipt?.processId) || !safeId(receipt?.processInstanceId) || !safeId(receipt?.supervisorInstanceId)) {
      throw new Error("Worker process event identity is invalid");
    }
    const sourceId = `worker-supervisor:${digest(`${selected.workerId}:${receipt.supervisorInstanceId}:${receipt.processInstanceId}:${kind}`)}`;
    const value = { schema: 1, source: "worker-supervisor", sourceId, type: "native-process", action: kind,
      chatId: selected.chatId, workerId: selected.workerId, attemptId: selected.attemptId,
      processId: receipt.processId, processInstanceId: receipt.processInstanceId, supervisorInstanceId: receipt.supervisorInstanceId,
      observedAt: new Date().toISOString() };
    if (kind !== "started") value.exit = {
      code: Number.isInteger(receipt.exit?.code) && receipt.exit.code >= 0 && receipt.exit.code <= 255 ? receipt.exit.code : null,
      signal: typeof receipt.exit?.signal === "string" && /^SIG[A-Z0-9]{1,20}$/.test(receipt.exit.signal) ? receipt.exit.signal : null,
    };
    const filename = path.join(this.directory, `${sourceId.slice("worker-supervisor:".length)}.json`);
    if (existsSync(filename)) return value;
    if (readdirSync(this.directory).filter(name => filenamePattern.test(name)).length >= 1024) throw new Error("Worker process event outbox is full");
    const temporary = path.join(this.directory, `.${randomUUID()}.tmp`);
    let descriptor;
    try {
      descriptor = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      writeFileSync(descriptor, `${JSON.stringify(value)}\n`);
      fsyncSync(descriptor); closeSync(descriptor); descriptor = null;
      renameSync(temporary, filename);
      this.#syncDirectory();
      return value;
    } finally {
      if (descriptor !== undefined && descriptor !== null) closeSync(descriptor);
      if (existsSync(temporary)) unlinkSync(temporary);
    }
  }

  list(limit = 100) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("Worker process event limit is invalid");
    return readdirSync(this.directory).filter(name => filenamePattern.test(name)).map(name => {
      const filename = path.join(this.directory, name), stat = lstatSync(filename);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || stat.mode & 0o077 || stat.size > 4096) {
        throw new Error("Unsafe worker process event file");
      }
      const event = JSON.parse(readFileSync(filename, "utf8"));
      if (event?.schema !== 1 || event?.source !== "worker-supervisor" || event.sourceId !== `worker-supervisor:${name.slice(0, -5)}`
        || event.type !== "native-process" || !kinds.has(event.action) || !safeId(event.chatId) || !safeId(event.workerId)
        || !safeId(event.attemptId) || !safeId(event.processId) || !safeId(event.processInstanceId) || !safeId(event.supervisorInstanceId)
        || typeof event.observedAt !== "string" || event.observedAt.length > 40 || !Number.isFinite(Date.parse(event.observedAt))) {
        throw new Error("Invalid worker process event file");
      }
      return event;
    }).sort((left, right) => left.observedAt.localeCompare(right.observedAt)
      || (left.action === "started" ? -1 : 1) - (right.action === "started" ? -1 : 1)
      || left.sourceId.localeCompare(right.sourceId)).slice(0, limit);
  }

  acknowledge(sourceId) {
    if (!sourcePattern.test(sourceId || "")) throw new Error("Worker process event ID is invalid");
    const filename = path.join(this.directory, `${sourceId.slice("worker-supervisor:".length)}.json`);
    try { unlinkSync(filename); this.#syncDirectory(); return true; }
    catch (error) { if (error.code === "ENOENT") return false; throw error; }
  }

  #syncDirectory() {
    const descriptor = openSync(this.directory, constants.O_RDONLY | constants.O_DIRECTORY);
    try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
  }
}
