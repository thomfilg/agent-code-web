import net from "node:net";
import path from "node:path";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { chmod, lstat, mkdir, realpath, rm, utimes } from "node:fs/promises";
import { WorkerProcessSupervisor } from "./worker-process-supervisor.mjs";
import { WorkerProcessEventOutbox } from "./worker-process-event-outbox.mjs";
import { identity, readFrames, safeId, writeFrame } from "./worker-transport-wire.mjs";
import { WORKER_SUPERVISOR_CONTROL_SOCKET, WORKER_SUPERVISOR_ROOT, WORKER_SUPERVISOR_SOCKET } from "./worker-supervisor-paths.mjs";
import { workerSupervisorVersion } from "./worker-supervisor-service.mjs";

const digest = value => createHash("sha256").update(value).digest();
const fail = code => Object.assign(new Error(`Worker supervisor daemon: ${code}`), { code });
const exactIdentity = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const own = (stat, mode) => stat.uid === process.getuid?.() && (stat.mode & 0o777) === mode;
const validLease = lease => lease && safeId(lease.id) && Number.isSafeInteger(lease.generation) && lease.generation >= 1
  && Number.isSafeInteger(lease.expiresAt) && lease.expiresAt > Date.now() && lease.expiresAt <= Date.now() + 60000
  && typeof lease.credential === "string" && /^[A-Za-z0-9_-]{43}$/.test(lease.credential);

async function removeOwnedSocket(filename) {
  try {
    const stat = await lstat(filename);
    if (!stat.isSocket() || stat.isSymbolicLink() || stat.uid !== process.getuid?.()) throw fail("PRIVATE_SOCKET_REQUIRED");
    await rm(filename);
  } catch (error) { if (error.code !== "ENOENT") throw error; }
}

// Worker-owned, single-chat daemon. Its in-memory process/lease state survives
// controller and SSH loss, and is intentionally lost on a real worker reboot.
// systemd owns the daemon cgroup so a daemon failure cannot leave unowned child
// processes running outside the worker lifecycle.
export class WorkerSupervisorDaemon {
  constructor({ root = WORKER_SUPERVISOR_ROOT, processSocket = WORKER_SUPERVISOR_SOCKET, controlSocket = WORKER_SUPERVISOR_CONTROL_SOCKET,
    heartbeat = null, eventOutboxDirectory = path.join(root, "events") } = {}) {
    if (!path.isAbsolute(root) || path.dirname(processSocket) !== root || path.dirname(controlSocket) !== root || processSocket === controlSocket
      || heartbeat !== null && !path.isAbsolute(heartbeat) || !path.isAbsolute(eventOutboxDirectory)) throw fail("CONFIG_INVALID");
    Object.assign(this, { root, processSocket, controlSocket, heartbeat, eventOutbox: new WorkerProcessEventOutbox(eventOutboxDirectory) });
    this.instanceId = randomUUID(); this.connections = new Set(); this.leases = new Map(); this.leaseGenerations = new Map(); this.lastInvalidatedLeases = new Map();
  }
  async listen() {
    this.eventOutbox.initialize();
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await chmod(this.root, 0o700);
    const parent = await lstat(this.root);
    if (!parent.isDirectory() || parent.isSymbolicLink() || !own(parent, 0o700) || await realpath(this.root) !== path.resolve(this.root)) throw fail("PRIVATE_DIRECTORY_REQUIRED");
    // Never unlink a path merely because this process is starting. A duplicate
    // daemon must fail closed instead of disconnecting a live supervisor. The
    // service runtime directory is cleaned by its owner between real boots.
    for (const filename of [this.controlSocket, this.processSocket]) {
      try { await lstat(filename); throw fail("SOCKET_ALREADY_EXISTS"); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    this.server = net.createServer(socket => this.connection(socket));
    await new Promise((resolve, reject) => { this.server.once("error", reject); this.server.listen(this.controlSocket, resolve); });
    await chmod(this.controlSocket, 0o600);
    const endpoint = await lstat(this.controlSocket);
    if (!endpoint.isSocket() || !own(endpoint, 0o600)) throw fail("PRIVATE_SOCKET_REQUIRED");
    this.server.on("error", () => {});
    return this;
  }
  connection(socket) {
    if (this.connections.size >= 8) { socket.destroy(); return; }
    const connection = { socket, requests: 0, queue: Promise.resolve() }; this.connections.add(connection);
    const close = () => this.connections.delete(connection); socket.on("close", close); socket.on("error", close);
    const timer = setTimeout(() => socket.destroy(), 5000); timer.unref();
    readFrames(socket, frame => {
      if (++connection.requests > 8) { socket.destroy(); return; }
      connection.queue = connection.queue.then(() => this.dispatch(frame)).then(result => {
        if (!socket.destroyed) writeFrame(socket, { id: safeId(frame.id) ? frame.id : "invalid", result });
      }, error => {
        if (!socket.destroyed) writeFrame(socket, { id: safeId(frame.id) ? frame.id : "invalid", error: { code: /^[A-Z_]{1,80}$/.test(error?.code || "") ? error.code : "OPERATION_FAILED" } });
      }).finally(() => { connection.requests--; });
    }, () => socket.destroy());
    socket.once("close", () => clearTimeout(timer));
  }
  async dispatch(frame) {
    if (!safeId(frame?.id) || !["status", "events", "ackEvent", "configure", "invalidate", "release", "reset"].includes(frame.action)) throw fail("REQUEST_INVALID");
    if (frame.action === "status") return this.status();
    if (frame.action === "events") return { events: this.eventOutbox.list() };
    if (frame.action === "ackEvent") {
      try { return { acknowledged: this.eventOutbox.acknowledge(frame.sourceId) }; }
      catch { throw fail("EVENT_ACK_FAILED"); }
    }
    if (frame.action === "configure") return this.configure(frame.identity, frame.processId, frame.lease);
    if (frame.action === "invalidate") {
      if (!safeId(frame.processId) || !safeId(frame.leaseId)) throw fail("REQUEST_INVALID");
      const lease = this.leases.get(frame.processId);
      if (!lease && this.lastInvalidatedLeases.get(frame.processId) === frame.leaseId) return { invalidated: true };
      if (!lease || lease.id !== frame.leaseId) throw fail("LEASE_CHANGED");
      this.leases.delete(frame.processId); this.lastInvalidatedLeases.set(frame.processId, lease.id); this.supervisor?.invalidateLease(lease.id); return { invalidated: true };
    }
    if (frame.action === "release") {
      if (!safeId(frame.processId) || !safeId(frame.processInstanceId) || !safeId(frame.leaseId)) throw fail("REQUEST_INVALID");
      const lease = this.leases.get(frame.processId);
      if (!lease || lease.id !== frame.leaseId || !this.supervisor) throw fail("LEASE_CHANGED");
      return this.supervisor.release(frame.processId, frame.processInstanceId);
    }
    if (!this.supervisor) { this.selectedIdentity = null; this.leases.clear(); this.leaseGenerations.clear(); this.lastInvalidatedLeases.clear(); return { reset: true }; }
    try { await this.supervisor.close(); }
    catch { throw fail("SUPERVISOR_BUSY"); }
    await removeOwnedSocket(this.processSocket);
    this.supervisor = null; this.selectedIdentity = null; this.leases.clear(); this.leaseGenerations.clear(); this.lastInvalidatedLeases.clear();
    return { reset: true };
  }
  status() {
    return { protocol: "relay-worker-supervisor/1", version: workerSupervisorVersion, daemonInstanceId: this.instanceId, configured: Boolean(this.supervisor),
      leaseHeartbeat: Boolean(this.heartbeat), eventOutbox: true, eventOutboxError: Boolean(this.eventOutboxError),
      ...(this.selectedIdentity ? { identity: this.selectedIdentity } : {}),
      ...(this.leases.size ? { leases: [...this.leases].map(([processId, lease]) => ({ processId, id: lease.id, generation: lease.generation, expiresAt: lease.expiresAt })) } : {}),
      ...(this.supervisor ? { supervisorInstanceId: this.supervisor.instanceId,
        processes: [...this.supervisor.processes.values()].map(entry => this.supervisor.receipt(entry)) } : {}) };
  }
  async configure(selected, processId, lease) {
    try { selected = identity(selected); } catch { throw fail("IDENTITY_INVALID"); }
    if (!safeId(processId) || !validLease(lease)) throw fail("LEASE_INVALID");
    if (this.selectedIdentity && !exactIdentity(this.selectedIdentity, selected)) throw fail("IDENTITY_CHANGED");
    const credentialHash = digest(lease.credential), current = this.leases.get(processId), generationFloor = this.leaseGenerations.get(processId) || 0;
    if (!current && lease.generation <= generationFloor) throw fail("LEASE_FENCED");
    if (current && (lease.generation < current.generation || lease.generation === current.generation
      && (lease.id !== current.id || !timingSafeEqual(credentialHash, current.credentialHash)))) throw fail("LEASE_FENCED");
    if (!this.supervisor) {
      this.selectedIdentity = selected;
      this.leases.set(processId, { id: lease.id, generation: lease.generation, expiresAt: lease.expiresAt, credentialHash });
      this.leaseGenerations.set(processId, lease.generation);
      try {
        this.supervisor = await new WorkerProcessSupervisor({ socketPath: this.processSocket, expectedIdentity: selected,
          authorize: request => this.authorize(request) }).listen();
        for (const [signal, action] of [["processStarted", "started"], ["processExit", "exited"]]) {
          this.supervisor.on(signal, (receipt, observation) => {
            try { this.eventOutbox.record(action === "exited" && observation?.commandExitObserved !== true ? "unconfirmed" : action,
              this.selectedIdentity, receipt); }
            catch { this.eventOutboxError = true; this.supervisor.emit("diagnostic", { code: "EVENT_OUTBOX_FAILED" }); }
          });
        }
      } catch (error) { this.supervisor = null; this.selectedIdentity = null; this.leases.clear(); this.leaseGenerations.clear(); throw error; }
    } else {
      const prior = current;
      this.leases.set(processId, { id: lease.id, generation: lease.generation, expiresAt: lease.expiresAt, credentialHash });
      this.leaseGenerations.set(processId, Math.max(generationFloor, lease.generation));
      if (prior && prior.id !== lease.id) this.supervisor.invalidateLease(prior.id);
    }
    // Reconnectable native processes no longer have a long-lived SSH launcher
    // to refresh the machine watchdog. Every authoritative lease issue/renewal
    // proves that the controller still owns this worker, so keep the watchdog
    // alive at that exact boundary. If the controller disappears, leases stop
    // renewing and the existing guest watchdog still powers the orphan down.
    if (this.heartbeat) {
      const now = new Date();
      try { await utimes(this.heartbeat, now, now); }
      catch { throw fail("HEARTBEAT_FAILED"); }
    }
    return { configured: true, daemonInstanceId: this.instanceId, supervisorInstanceId: this.supervisor.instanceId,
      processId, lease: { id: lease.id, generation: lease.generation, expiresAt: lease.expiresAt } };
  }
  authorize(request) {
    const lease = this.leases.get(request.processId);
    if (!lease || lease.expiresAt <= Date.now() || typeof request.lease !== "string") throw fail("ADMISSION_DENIED");
    const submitted = digest(request.lease);
    if (!timingSafeEqual(submitted, lease.credentialHash)) throw fail("ADMISSION_DENIED");
    return { id: lease.id, generation: lease.generation, expiresAt: lease.expiresAt };
  }
  async close() {
    if (this.supervisor) await this.supervisor.close();
    for (const connection of this.connections) connection.socket.destroy();
    if (this.server?.listening) await new Promise(resolve => this.server.close(resolve));
    await removeOwnedSocket(this.controlSocket); await removeOwnedSocket(this.processSocket);
  }
}
