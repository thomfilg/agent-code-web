import { randomUUID } from "node:crypto";
import { WorkerLeaseAuthority } from "./worker-lease-authority.mjs";
import { workerAttemptKey } from "./worker-lease-scope.mjs";
import { identity as exactIdentity, safeId } from "./worker-transport-wire.mjs";

const failure = message => new Error(`Remote browser supervisor: ${message}`);
const sameBase = (left, right) => ["deploymentId", "ownerId", "chatId", "workerId", "provider", "accountId"].every(key => left?.[key] === right?.[key]);

// Controller-side coordinator for one worker-owned supervisor. The daemon is
// the authoritative source of a retained attempt ID after controller restart;
// PostgreSQL remains authoritative for user/company/account admission.
export class RemoteBrowserAttemptCoordinator {
  constructor({ records, deploymentId, workerId, bootId, control, connect, controllerId = randomUUID(), legacyOwnerId = null, ttlMs = 30000 }) {
    if (!records || !safeId(deploymentId) || !safeId(workerId) || !/^[a-f0-9]{64}$/.test(bootId || "")
      || typeof control !== "function" || typeof connect !== "function" || !safeId(controllerId)) throw failure("invalid configuration");
    Object.assign(this, { records, deploymentId, workerId, bootId, control, connect, controllerId, legacyOwnerId, ttlMs });
    this.contexts = new Map();
  }
  open(chat) {
    if (this.contexts.has(chat.id)) return this.contexts.get(chat.id);
    const pending = this.#open(chat).catch(error => { if (this.contexts.get(chat.id) === pending) this.contexts.delete(chat.id); throw error; });
    this.contexts.set(chat.id, pending); return pending;
  }
  async #open(chat) {
    if (!chat || !/^user_[a-f0-9]{32}$/.test(chat.ownerId || "") || !/^chat_[a-f0-9]{32}$/.test(chat.id || "")
      || !["codex", "claude"].includes(chat.agent) || !/^account_[a-f0-9-]{36}$/.test(chat.agentAccountId || "")) throw failure("chat binding is invalid");
    const status = await this.control({ action: "status" });
    if (status?.protocol !== "relay-worker-supervisor/1" || status.version !== "v1" || !safeId(status.daemonInstanceId)
      || typeof status.configured !== "boolean" || status.configured && (!Array.isArray(status.processes) || !safeId(status.supervisorInstanceId))) throw failure("daemon status is invalid");
    const base = { deploymentId: this.deploymentId, ownerId: chat.ownerId, chatId: chat.id, workerId: this.workerId,
      provider: chat.agent, accountId: chat.agentAccountId };
    let selected;
    if (status.configured) {
      try { selected = exactIdentity(status.identity); } catch { throw failure("retained identity is invalid"); }
      if (!sameBase(selected, base) || status.processes.length > 1 || status.processes.some(process => process.processId !== "shared-chrome"
        || process.supervisorInstanceId !== status.supervisorInstanceId)) throw failure("retained identity does not match the selected chat");
    } else selected = exactIdentity({ ...base, attemptId: randomUUID() });

    let context;
    const authority = new WorkerLeaseAuthority({ records: this.records, deploymentId: this.deploymentId, bootForWorker: candidate => {
      if (!sameBase(candidate, selected)) throw failure("worker identity changed"); return this.bootId;
    }, legacyOwnerId: this.legacyOwnerId, ttlMs: this.ttlMs, invalidateLease: id => this.control({ action: "invalidate", leaseId: id }) });
    const binding = await authority.prepare(selected);
    let claim;
    if (status.configured) {
      const row = await this.records.workerAttemptGet(workerAttemptKey(selected));
      if (!row.value) throw failure("retained attempt has no durable authority record");
      claim = await authority.takeover(binding, this.controllerId, { expectedRevision: row.revision });
    } else claim = await authority.claim(binding, this.controllerId);
    const admitted = authority.forAttempt(binding, this.controllerId);
    let currentLease = null, disposed = false;
    const install = async lease => {
      const receipt = await this.control({ action: "configure", identity: selected,
        lease: { id: lease.id, generation: lease.generation, expiresAt: lease.expiresAt, credential: lease.credential || currentLease?.credential } });
      if (receipt?.configured !== true || receipt.daemonInstanceId !== status.daemonInstanceId || !safeId(receipt.supervisorInstanceId)
        || status.configured && receipt.supervisorInstanceId !== status.supervisorInstanceId
        || receipt.lease?.id !== lease.id || receipt.lease?.generation !== lease.generation) throw failure("daemon rejected the authoritative lease");
      return receipt;
    };
    context = {
      boundary: "worker-supervisor", identity: selected, binding, claim, records: this.records, authority, admitted,
      issueLease: async () => {
        const lease = await admitted.issue();
        try { await install(lease); }
        catch (error) { await admitted.revoke(lease.id).catch(() => {}); throw error; }
        currentLease = lease; return lease;
      },
      renewLease: async id => {
        if (!currentLease || currentLease.id !== id) throw failure("lease changed");
        const renewed = await admitted.renew(id), lease = { ...renewed, credential: currentLease.credential };
        await install(lease); currentLease = lease; return renewed;
      },
      connectTransport: credential => this.connect({ identity: selected, credential }),
      dispose: async () => {
        if (disposed) return;
        if (currentLease) await admitted.revoke(currentLease.id);
        else await admitted.revoke();
        await this.control({ action: "reset" }); disposed = true;
        if (this.contexts.get(chat.id) === context || await this.contexts.get(chat.id).catch(() => null) === context) this.contexts.delete(chat.id);
      },
    };
    return context;
  }
}
