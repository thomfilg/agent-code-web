import net from "node:net";
import path from "node:path";
import { lstat, chmod, realpath } from "node:fs/promises";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { MAX_INPUT_BYTES, PROTOCOL, TransportError, identity, readFrames, safeId, sequence, transportError, writeFrame } from "./worker-transport-wire.mjs";

const hash = value => createHash("sha256").update(value).digest("hex");
const own = (stat, mode) => stat.uid === process.getuid?.() && (stat.mode & 0o777) === mode;
const validLease = lease => lease && safeId(lease.id) && Number.isSafeInteger(lease.generation) && lease.generation >= 1
  && Number.isSafeInteger(lease.expiresAt) && lease.expiresAt > Date.now() && lease.expiresAt <= Date.now() + 60000;
const sameLease = (a, b) => a?.id === b?.id && a?.generation === b?.generation;
const fenced = (lease, entry) => lease.generation < entry.lease.generation || lease.generation === entry.lease.generation && !sameLease(lease, entry.lease);
const actions = new Set(["launch", "inspect", "attach", "input", "endInput", "ackOutput", "status", "terminate"]);
const processIdentity = pid => {
  const raw = readFileSync(`/proc/${pid}/stat`, "utf8"), fields = raw.slice(raw.lastIndexOf(") ") + 2).split(" ");
  return { pid, state: fields[0], group: Number(fields[2]), session: Number(fields[3]), start: fields[19] };
};
const groupAlive = group => readdirSync("/proc").some(name => {
  if (!/^\d+$/.test(name)) return false;
  try { const item = processIdentity(Number(name)); return item.group === group && item.state !== "Z" && item.state !== "X"; }
  catch (error) { if (error.code === "ENOENT" || error.code === "ESRCH") return false; throw error; }
});

// Worker-owned lifetime: client EOF, socket errors and controller replacement
// never close child stdin or signal a process. The authorizer is mandatory and
// supplied by the future coordinator; client-provided epochs are not authority.
export class WorkerProcessSupervisor extends EventEmitter {
  constructor({ socketPath, expectedIdentity, authorize, maxSpoolBytes = 1024 * 1024, inputWindow = 256, maxProcesses = 16 }) {
    super();
    if (!path.isAbsolute(socketPath) || typeof authorize !== "function" || !Number.isSafeInteger(maxSpoolBytes) || maxSpoolBytes < 1024 || maxSpoolBytes > 16 * 1024 * 1024
      || !Number.isSafeInteger(inputWindow) || inputWindow < 1 || inputWindow > 4096 || !Number.isSafeInteger(maxProcesses) || maxProcesses < 1 || maxProcesses > 128) throw transportError("CONFIG_INVALID");
    Object.assign(this, { socketPath, expectedIdentity: identity(expectedIdentity), authorize, maxSpoolBytes, inputWindow, maxProcesses });
    this.processes = new Map(); this.releasedProcesses = new Map(); this.connections = new Set(); this.instanceId = randomUUID(); this.invalidatedLeases = new Set(); this.authorizations = 0;
  }
  async listen() {
    const parent = await lstat(path.dirname(this.socketPath));
    if (!parent.isDirectory() || parent.isSymbolicLink() || !own(parent, 0o700)
      || await realpath(path.dirname(this.socketPath)) !== path.resolve(path.dirname(this.socketPath))) throw transportError("PRIVATE_DIRECTORY_REQUIRED");
    try { await lstat(this.socketPath); throw transportError("SOCKET_ALREADY_EXISTS"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    this.server = net.createServer(socket => this.connection(socket));
    await new Promise((resolve, reject) => { this.server.once("error", reject); this.server.listen(this.socketPath, resolve); });
    await chmod(this.socketPath, 0o600);
    const socket = await lstat(this.socketPath);
    if (!socket.isSocket() || !own(socket, 0o600)) throw transportError("PRIVATE_SOCKET_REQUIRED");
    this.server.on("error", () => this.emit("diagnostic", { code: "SOCKET_ERROR" }));
    return this;
  }
  connection(socket) {
    if (this.connections.size >= 16) { socket.destroy(); return; }
    const connection = { socket, pending: 0, queue: Promise.resolve(), attachment: null };
    connection.expiry = setTimeout(() => socket.destroy(), 5000); connection.expiry.unref();
    this.connections.add(connection);
    const detach = () => {
      this.connections.delete(connection);
      clearTimeout(connection.expiry);
      if (connection.attachment?.connection === connection) connection.attachment.connection = null;
    };
    socket.on("close", detach); socket.on("error", detach);
    socket.on("drain", () => { if (connection.attachment?.connection === connection) this.pump(connection.attachment); });
    readFrames(socket, frame => {
      // Bound queued requests even when authorization or pipe writes are slow.
      if (++connection.pending > 16) { socket.destroy(); return; }
      // A child that stopped reading stdin must not make explicit termination
      // wait behind its blocked pipe callback. Authorization is still required.
      if (frame.action === "terminate") {
        this.dispatch(connection, frame).catch(() => socket.destroy()).finally(() => connection.pending--); return;
      }
      connection.queue = connection.queue.then(() => this.dispatch(connection, frame)).catch(() => socket.destroy()).finally(() => connection.pending--);
    }, () => socket.destroy());
  }
  async authorized(frame, connection) {
    let submitted;
    try { submitted = identity(frame.identity); } catch { throw transportError("ADMISSION_DENIED"); }
    if (JSON.stringify(submitted) !== JSON.stringify(this.expectedIdentity) || typeof frame.lease !== "string" || !frame.lease || frame.lease.length > 512) throw transportError("ADMISSION_DENIED");
    if (this.admissionClosed || this.authorizations >= 16) throw transportError("ADMISSION_DENIED");
    let lease;
    let timeout;
    this.authorizations++;
    // A broken authorizer that ignores cancellation cannot grow unbounded
    // promises by cycling sockets after timeout: retain its slot until settled.
    const authorization = Promise.resolve().then(() => this.authorize({ action: frame.action, identity: this.expectedIdentity, lease: frame.lease, processId: frame.processId, processInstanceId: frame.processInstanceId }))
      .finally(() => this.authorizations--);
    try { lease = await Promise.race([
      authorization,
      new Promise((_, reject) => { timeout = setTimeout(() => reject(transportError("ADMISSION_DENIED")), 3000); timeout.unref(); }),
    ]); }
    catch { throw transportError("ADMISSION_DENIED"); }
    finally { clearTimeout(timeout); }
    if (!validLease(lease) || connection.socket.destroyed || this.admissionClosed || this.invalidatedLeases.has(lease.id)) throw transportError("ADMISSION_DENIED");
    clearTimeout(connection.expiry);
    connection.expiry = setTimeout(() => connection.socket.destroy(), lease.expiresAt - Date.now()); connection.expiry.unref();
    return { id: lease.id, generation: lease.generation, expiresAt: lease.expiresAt };
  }
  async dispatch(connection, frame) {
    const socket = connection.socket;
    if (socket.destroyed) return;
    if (!safeId(frame.id) || !safeId(frame.processId) || frame.protocol !== PROTOCOL || !actions.has(frame.action)) { socket.destroy(); return; }
    try {
      const lease = await this.authorized(frame, connection);
      if (this.admissionClosed || this.invalidatedLeases.has(lease.id) || lease.expiresAt <= Date.now() || socket.destroyed) throw transportError("ADMISSION_DENIED");
      let entry = this.processes.get(frame.processId);
      if (frame.action === "launch") {
        entry = await this.launch(frame, lease, entry);
        writeFrame(socket, { id: frame.id, result: this.receipt(entry) }); return;
      }
      if (!entry) throw transportError("PROCESS_NOT_FOUND");
      if (frame.action === "inspect") {
        if (fenced(lease, entry)) throw transportError("LEASE_FENCED");
        writeFrame(socket, { id: frame.id, result: this.receipt(entry) }); return;
      }
      if (frame.processInstanceId !== entry.instanceId) throw transportError("PROCESS_IDENTITY_CHANGED");
      if (frame.action === "attach") {
        // Each replacement must receive a NEW externally issued generation.
        // Reusing a token cannot let a late old socket steal the attachment.
        if (fenced(lease, entry) || entry.attached && lease.generation <= entry.lease.generation) throw transportError("LEASE_FENCED");
        if (connection.attachment) throw transportError("CONNECTION_ALREADY_ATTACHED");
        this.validateCursor(entry, frame.committedOutputSeq);
        entry.connection?.socket.destroy(); entry.connection = connection; connection.attachment = entry;
        entry.attached = true; entry.lease = lease; entry.sentThrough = frame.committedOutputSeq;
        this.acknowledge(entry, frame.committedOutputSeq);
        writeFrame(socket, { id: frame.id, result: this.receipt(entry) }); this.drain(entry); this.pump(entry); return;
      }
      if (entry.connection !== connection || !sameLease(entry.lease, lease)) throw transportError("LEASE_FENCED");
      entry.lease = lease;
      let result;
      if (frame.action === "input" || frame.action === "endInput") result = await this.input(entry, frame);
      else if (frame.action === "ackOutput") {
        this.validateCursor(entry, frame.seq);
        if (frame.seq > entry.sentThrough) throw transportError("OUTPUT_NOT_DELIVERED");
        this.acknowledge(entry, frame.seq); result = this.receipt(entry);
      } else if (frame.action === "status") result = this.receipt(entry);
      else if (frame.action === "terminate") { await this.terminate(entry); result = this.receipt(entry); }
      else throw transportError("ACTION_INVALID");
      if (!socket.destroyed && entry.connection === connection) writeFrame(socket, { id: frame.id, result });
      this.drain(entry); this.pump(entry);
    } catch (error) {
      // Never expose authorization errors, launch arguments/env or child output.
      const code = error instanceof TransportError ? error.code : "OPERATION_FAILED";
      if (!socket.destroyed) writeFrame(socket, { id: frame.id, error: { code } });
      if (code === "ADMISSION_DENIED" || code === "LEASE_FENCED") {
        if (connection.attachment?.connection === connection) connection.attachment.connection = null;
        socket.end();
      }
    }
  }
  async launch(frame, lease, existing) {
    const spec = frame.spec;
    if (!spec || typeof spec.command !== "string" || !spec.command || spec.command.length > 4096 || !Array.isArray(spec.args) || spec.args.length > 256
      || spec.args.some(arg => typeof arg !== "string") || typeof spec.cwd !== "string" || !path.isAbsolute(spec.cwd)
      || !spec.env || typeof spec.env !== "object" || Array.isArray(spec.env) || Object.entries(spec.env).some(([key, value]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== "string")) throw transportError("LAUNCH_INVALID");
    const specHash = hash(JSON.stringify(spec));
    if (existing) {
      if (fenced(lease, existing)) throw transportError("LEASE_FENCED");
      if (existing.specHash !== specHash) throw transportError("LAUNCH_CONFLICT");
      await existing.ready; return existing; // Retry never spawns a second child.
    }
    if (this.processes.size >= this.maxProcesses) throw transportError("PROCESS_LIMIT");
    const entry = { processId: frame.processId, instanceId: randomUUID(), specHash, lease, startedAt: new Date().toISOString(), records: [], spoolBytes: 0, outputSeq: 0, ackedSeq: 0,
      sentThrough: 0, everSentThrough: 0, inputSeq: 0, inputHashes: new Map(), inputEnded: false, connection: null, exited: false, blocked: false };
    this.processes.set(frame.processId, entry);
    try { entry.child = spawn(process.execPath, [fileURLToPath(new URL("./worker-process-anchor.mjs", import.meta.url))], {
      cwd: spec.cwd, env: {}, detached: true, stdio: ["pipe", "pipe", "pipe", "ipc"],
    }); }
    catch {
      entry.exited = true; entry.spawnFailed = true; entry.groupCleaned = true; entry.anchorNeverStarted = true;
      entry.exit = { code: null, signal: null }; this.record(entry, "exit", Buffer.from(JSON.stringify(entry.exit))); entry.exitRecorded = true;
      throw transportError("LAUNCH_FAILED");
    }
    entry.child.stdin.on("error", () => {});
    for (const channel of ["stdout", "stderr"]) {
      entry.child[channel].on("readable", () => this.drain(entry));
      entry.child[channel].on("end", () => this.drain(entry));
    }
    entry.ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(transportError("LAUNCH_OUTCOME_UNKNOWN")), 3000); timer.unref();
      entry.child.on("message", message => {
        if (message.type === "ready" && !entry.commandPid) {
          try {
            const anchor = processIdentity(entry.child.pid);
            if (message.anchorPid !== entry.child.pid || anchor.group !== anchor.pid || anchor.session !== anchor.pid
              || !Number.isInteger(message.pid) || message.pid < 1) throw Error();
            entry.anchor = anchor; entry.commandPid = message.pid; clearTimeout(timer); resolve();
          } catch { clearTimeout(timer); reject(transportError("LAUNCH_OUTCOME_UNKNOWN")); }
        } else if (message.type === "commandExit") {
          entry.exited = true; entry.exit = { code: message.code, signal: message.signal }; this.drain(entry); this.emit("processExit", this.receipt(entry));
        } else if (message.type === "launchFailed") {
          try { entry.anchor = processIdentity(entry.child.pid); } catch {}
          entry.spawnFailed = true; entry.exited = true; entry.exit = { code: null, signal: null };
          clearTimeout(timer); reject(transportError("LAUNCH_FAILED")); this.drain(entry);
        }
      });
      entry.child.once("error", () => {
        clearTimeout(timer); entry.spawnFailed = true; entry.exited = true;
        if (!entry.child.pid) {
          entry.anchorNeverStarted = true; entry.groupCleaned = true; entry.exit = { code: null, signal: null };
        }
        reject(transportError("LAUNCH_FAILED")); this.drain(entry);
      });
      entry.child.once("exit", () => { clearTimeout(timer); reject(transportError("LAUNCH_OUTCOME_UNKNOWN")); });
    });
    entry.ready.catch(() => {});
    entry.child.once("close", () => { entry.anchorStreamsClosed = true; this.drain(entry); });
    entry.child.once("exit", () => {
      entry.anchorExited = true;
      if (!entry.killIssued) entry.cleanupUnconfirmed = true;
      if (!entry.exited) { entry.exited = true; entry.exit = { code: null, signal: null }; }
      this.drain(entry);
    });
    entry.child.send(spec, error => { if (error) this.emit("diagnostic", { code: "LAUNCH_OUTCOME_UNKNOWN" }); });
    await entry.ready; this.emit("processStarted", this.receipt(entry)); return entry;
  }
  receipt(entry) {
    return { protocol: PROTOCOL, supervisorInstanceId: this.instanceId, processId: entry.processId, processInstanceId: entry.instanceId, pid: entry.commandPid || null, startedAt: entry.startedAt,
      groupAnchor: entry.anchor ? { pid: entry.anchor.pid, start: entry.anchor.start } : null,
      groupCleanup: entry.cleanupUnconfirmed ? "unconfirmed" : entry.groupCleaned ? "confirmed" : "pending",
      inputAcceptedThrough: entry.inputSeq, outputProducedThrough: entry.outputSeq, outputCommittedThrough: entry.ackedSeq,
      outputSpoolBytes: entry.spoolBytes, outputBlocked: entry.blocked, state: entry.exited ? "exited" : "running", ...(entry.exit ? { exit: entry.exit } : {}) };
  }
  validateCursor(entry, cursor) {
    if (!sequence(cursor) || cursor > entry.everSentThrough) throw transportError("OUTPUT_CURSOR_INVALID");
    if (cursor < entry.ackedSeq) throw transportError("OUTPUT_CURSOR_EXPIRED");
  }
  acknowledge(entry, seq) {
    while (entry.records[0]?.seq <= seq) entry.spoolBytes -= entry.records.shift().bytes;
    entry.ackedSeq = seq;
  }
  record(entry, channel, data) {
    entry.records.push({ seq: ++entry.outputSeq, channel, data: data.toString("base64"), bytes: data.length }); entry.spoolBytes += data.length;
  }
  drain(entry) {
    if (!entry.child || entry.draining) return;
    entry.draining = true;
    try {
      let progress;
      do {
        progress = false;
        for (const channel of ["stdout", "stderr"]) {
          const capacity = this.maxSpoolBytes - entry.spoolBytes;
          if (capacity <= 0 || entry.records.length >= 4096) break;
          const length = Math.min(16 * 1024, capacity, entry.child[channel].readableLength);
          if (length) { const data = entry.child[channel].read(length); if (data) { this.record(entry, channel, data); progress = true; } }
        }
      } while (progress);
      const outputEnded = entry.child.stdout.readableEnded && entry.child.stderr.readableEnded || entry.anchorNeverStarted && entry.anchorStreamsClosed;
      if (entry.exited && outputEnded && !entry.exitRecorded && entry.spoolBytes + 128 <= this.maxSpoolBytes && entry.records.length < 4096) {
        this.record(entry, "exit", Buffer.from(JSON.stringify(entry.exit || { code: null, signal: null }))); entry.exitRecorded = true;
      }
      const blocked = entry.spoolBytes >= this.maxSpoolBytes || entry.records.length >= 4096;
      if (blocked !== entry.blocked) { entry.blocked = blocked; this.emit("backpressure", { processId: entry.processId, blocked }); }
      this.pump(entry);
    } finally { entry.draining = false; }
  }
  pump(entry) {
    const socket = entry.connection?.socket;
    if (!socket || socket.destroyed || socket.writableNeedDrain) return;
    if (entry.lease.expiresAt <= Date.now()) { socket.destroy(); return; }
    for (const record of entry.records) {
      if (record.seq <= entry.sentThrough) continue;
      entry.sentThrough = record.seq; entry.everSentThrough = Math.max(entry.everSentThrough, record.seq);
      if (!writeFrame(socket, { event: "output", supervisorInstanceId: this.instanceId, processId: entry.processId, processInstanceId: entry.instanceId, seq: record.seq, channel: record.channel, data: record.data })) return;
    }
  }
  async input(entry, frame) {
    if (!sequence(frame.seq) || frame.seq < 1) throw transportError("INPUT_SEQUENCE_INVALID");
    const data = frame.action === "endInput" ? Buffer.alloc(0) : typeof frame.data === "string" ? Buffer.from(frame.data, "base64") : null;
    if (!data || data.length > MAX_INPUT_BYTES || frame.action === "input" && data.toString("base64") !== frame.data) throw transportError("INPUT_INVALID");
    const digest = hash(frame.action + ":" + data.toString("base64"));
    if (frame.seq <= entry.inputSeq) {
      if (!entry.inputHashes.has(frame.seq)) throw transportError("INPUT_RETRY_EXPIRED");
      const previous = entry.inputHashes.get(frame.seq);
      if (previous.digest !== digest) throw transportError("INPUT_CONFLICT");
      if (previous.outcome !== "written") throw transportError("INPUT_OUTCOME_UNKNOWN");
      return { inputAcceptedThrough: entry.inputSeq, duplicate: true };
    }
    if (frame.seq !== entry.inputSeq + 1) throw transportError("INPUT_GAP");
    if (entry.inputPending) throw transportError("INPUT_BACKPRESSURE");
    if (entry.exited || entry.terminating || entry.inputEnded || !entry.child.stdin.writable) throw transportError("INPUT_CLOSED");
    if (entry.inputUncertain) throw transportError("INPUT_OUTCOME_UNKNOWN");
    // Reserve the sequence before writing: a lost pipe acknowledgement is an
    // unknown outcome, never permission to deliver the bytes twice.
    const accepted = { digest, outcome: "pending" };
    entry.inputPending = true; entry.inputSeq = frame.seq; entry.inputHashes.set(frame.seq, accepted);
    while (entry.inputHashes.size > this.inputWindow) entry.inputHashes.delete(entry.inputHashes.keys().next().value);
    if (frame.action === "endInput") entry.inputEnded = true;
    await new Promise((resolve, reject) => {
      const done = error => {
        entry.inputPending = false;
        if (error) entry.inputUncertain = true;
        accepted.outcome = error ? "unknown" : "written";
        if (error) reject(transportError("INPUT_OUTCOME_UNKNOWN")); else resolve();
      };
      if (entry.inputEnded) entry.child.stdin.end(done); else entry.child.stdin.write(data, done);
    });
    return { inputAcceptedThrough: entry.inputSeq, duplicate: false };
  }
  async terminate(entry) {
    if (entry.groupCleaned) return;
    if (entry.termination) return entry.termination;
    if (entry.cleanupUnconfirmed || entry.anchorExited) throw transportError("GROUP_CLEANUP_UNCONFIRMED");
    entry.terminating = true;
    entry.termination = new Promise((resolve, reject) => {
      let finished = false;
      const kill = signal => {
        // No await between verifying this unreaped direct-child anchor and
        // signaling its group. After its exit callback, never signal that PID.
        if (entry.anchorExited || entry.child.exitCode !== null || entry.child.signalCode !== null || !entry.anchor) throw transportError("GROUP_CLEANUP_UNCONFIRMED");
        const actual = processIdentity(entry.anchor.pid);
        if (actual.start !== entry.anchor.start || actual.group !== entry.anchor.pid || actual.session !== entry.anchor.pid || actual.state === "Z") throw transportError("GROUP_CLEANUP_UNCONFIRMED");
        if (signal === "SIGKILL") entry.killIssued = true;
        process.kill(-entry.anchor.pid, signal);
      };
      const fail = () => {
        if (finished) return; finished = true; clearTimeout(timer); clearTimeout(deadline);
        entry.cleanupUnconfirmed = true; reject(transportError("GROUP_CLEANUP_UNCONFIRMED"));
      };
      const timer = setTimeout(() => { try { kill("SIGKILL"); } catch { fail(); } }, 250); timer.unref();
      const deadline = setTimeout(() => { clearTimeout(timer); fail(); }, 1500); deadline.unref();
      entry.child.once("exit", () => {
        clearTimeout(timer);
        if (!entry.killIssued) { clearTimeout(deadline); fail(); return; }
        const verify = () => {
          if (finished) return;
          try {
            if (groupAlive(entry.anchor.pid)) { const retry = setTimeout(verify, 10); retry.unref(); return; }
            finished = true; clearTimeout(deadline); entry.groupCleaned = true; resolve();
          } catch { clearTimeout(deadline); fail(); }
        };
        verify();
      });
      try { kill("SIGTERM"); } catch { clearTimeout(timer); clearTimeout(deadline); fail(); }
    });
    return entry.termination;
  }
  disconnectClients() { for (const { socket } of this.connections) socket.destroy(); }
  // Trusted coordinator hook: revoke admission in the authorizer FIRST, then
  // synchronously fence already attached output. This never signals the child.
  invalidateLease(id) {
    if (!safeId(id)) throw transportError("LEASE_INVALID");
    // Keep revocation through delayed authorization completions. Never evict a
    // tombstone and accidentally readmit an old credential when capacity fills.
    if (this.invalidatedLeases.size >= 4096 && !this.invalidatedLeases.has(id)) this.admissionClosed = true;
    else this.invalidatedLeases.add(id);
    for (const entry of this.processes.values()) if (this.admissionClosed || entry.lease.id === id) entry.connection?.socket.destroy();
  }
  // Trusted coordinator compaction after an exact process has already exited,
  // its whole group is confirmed gone and every output record is acknowledged.
  // This never signals a process and cannot discard ambiguous input/output.
  release(processId, processInstanceId) {
    if (!safeId(processId) || !safeId(processInstanceId)) throw transportError("PROCESS_IDENTITY_CHANGED");
    const entry = this.processes.get(processId);
    if (!entry) {
      if (this.releasedProcesses.get(processId) === processInstanceId) return { released: true };
      throw transportError("PROCESS_NOT_FOUND");
    }
    if (entry.instanceId !== processInstanceId) throw transportError("PROCESS_IDENTITY_CHANGED");
    if (!entry.exited || !entry.groupCleaned || entry.cleanupUnconfirmed || !entry.exitRecorded
      || entry.records.length || entry.ackedSeq !== entry.outputSeq || entry.inputPending) throw transportError("PROCESS_RELEASE_UNSAFE");
    entry.connection?.socket.destroy(); entry.connection = null;
    this.processes.delete(processId); this.releasedProcesses.set(processId, processInstanceId);
    return { released: true };
  }
  async close() {
    if ([...this.processes.values()].some(entry => !entry.exited || !entry.groupCleaned)) throw transportError("LIVE_PROCESSES_REQUIRE_EXPLICIT_TERMINATION");
    if ([...this.processes.values()].some(entry => !entry.exitRecorded || entry.records.length)) throw transportError("UNCOMMITTED_OUTPUT_REMAINS");
    this.disconnectClients();
    if (this.server?.listening) await new Promise(resolve => this.server.close(resolve));
  }
}
