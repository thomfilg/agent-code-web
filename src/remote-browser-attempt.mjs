import { randomUUID } from "node:crypto";
import { WorkerLeaseAuthority } from "./worker-lease-authority.mjs";
import { workerAttemptKey } from "./worker-lease-scope.mjs";
import { identity as exactIdentity, safeId } from "./worker-transport-wire.mjs";
import { workerSupervisorVersion } from "./worker-supervisor-service.mjs";

const failure = message => new Error(`Remote worker supervisor: ${message}`);
const processNotFound = error => error?.code === "PROCESS_NOT_FOUND" || /(?:^|:\s*)PROCESS_NOT_FOUND$/.test(error?.message || "");
const sameBase = (left, right) => ["deploymentId", "ownerId", "chatId", "workerId", "provider", "accountId"].every(key => left?.[key] === right?.[key]);
const processIds = Object.freeze(["native-agent", "shared-chrome"]);

// Controller-side coordinator for one worker-owned supervisor. Browser and
// native-agent transports share one durable attempt/controller epoch but hold
// independent leases. The daemon is authoritative for retained process IDs;
// PostgreSQL remains authoritative for user/company/account admission.
export class RemoteBrowserAttemptCoordinator {
  constructor({ records, deploymentId, workerId, bootId, control, connect, controllerId = randomUUID(), legacyOwnerId = null, ttlMs = 30000 }) {
    if (!records || !safeId(deploymentId) || !safeId(workerId) || !/^[a-f0-9]{64}$/.test(bootId || "")
      || typeof control !== "function" || typeof connect !== "function" || !safeId(controllerId)) throw failure("invalid configuration");
    Object.assign(this, { records, deploymentId, workerId, bootId, control, connect, controllerId, legacyOwnerId, ttlMs });
    this.attempts = new Map();
  }
  open(chat, processId = "shared-chrome") {
    if (!processIds.includes(processId)) return Promise.reject(failure("process is not allowed"));
    let pending = this.attempts.get(chat?.id);
    if (!pending) {
      pending = this.#open(chat).catch(error => { if (this.attempts.get(chat?.id) === pending) this.attempts.delete(chat?.id); throw error; });
      this.attempts.set(chat.id, pending);
    }
    return pending.then(attempt => attempt.context(processId));
  }
  async #open(chat) {
    if (!chat || !/^user_[a-f0-9]{32}$/.test(chat.ownerId || "") || !/^chat_[a-f0-9]{32}$/.test(chat.id || "")
      || !["codex", "claude"].includes(chat.agent) || !/^account_[a-f0-9-]{36}$/.test(chat.agentAccountId || "")) throw failure("chat binding is invalid");
    const status = await this.control({ action: "status" });
    if (status?.protocol !== "relay-worker-supervisor/1" || status.version !== workerSupervisorVersion || !safeId(status.daemonInstanceId)
      || typeof status.configured !== "boolean" || status.configured && (!Array.isArray(status.processes) || !safeId(status.supervisorInstanceId))) throw failure("daemon status is invalid");
    const retained = new Set();
    if (status.configured) {
      for (const process of status.processes) {
        if (!processIds.includes(process?.processId) || process.supervisorInstanceId !== status.supervisorInstanceId || retained.has(process.processId)) throw failure("retained process set is invalid");
        retained.add(process.processId);
      }
    }
    const base = { deploymentId: this.deploymentId, ownerId: chat.ownerId, chatId: chat.id, workerId: this.workerId,
      provider: chat.agent, accountId: chat.agentAccountId };
    let selected;
    if (status.configured) {
      try { selected = exactIdentity(status.identity); } catch { throw failure("retained identity is invalid"); }
      if (!sameBase(selected, base)) throw failure("retained identity does not match the selected chat");
    } else selected = exactIdentity({ ...base, attemptId: randomUUID() });

    const authority = new WorkerLeaseAuthority({ records: this.records, deploymentId: this.deploymentId, processIds,
      bootForWorker: candidate => { if (!sameBase(candidate, selected)) throw failure("worker identity changed"); return this.bootId; },
      legacyOwnerId: this.legacyOwnerId, ttlMs: this.ttlMs,
      invalidateLease: (id, processId) => this.control({ action: "invalidate", processId, leaseId: id }) });
    const binding = await authority.prepare(selected);
    let claim;
    if (status.configured) {
      const row = await this.records.workerAttemptGet(workerAttemptKey(selected));
      if (!row.value) throw failure("retained attempt has no durable authority record");
      claim = await authority.takeover(binding, this.controllerId, { expectedRevision: row.revision });
    } else claim = await authority.claim(binding, this.controllerId);

    const contexts = new Map();
    const attempt = { authority, binding, claim, retained, contexts, finalized: false, finalizing: null };
    const stableAttempt = Promise.resolve(attempt);
    const finalize = async () => {
      if (attempt.finalized) return;
      if (attempt.finalizing) return attempt.finalizing;
      attempt.finalizing = (async () => {
        const current = await this.control({ action: "status" });
        if (!current.configured || current.daemonInstanceId !== status.daemonInstanceId) throw failure("daemon identity changed during cleanup");
        if (current.processes?.length) return;
        await authority.revoke(binding);
        await this.control({ action: "reset" });
        attempt.finalized = true;
        if (this.attempts.get(chat.id) === stableAttempt) this.attempts.delete(chat.id);
      })();
      try { await attempt.finalizing; } finally { attempt.finalizing = null; }
    };
    this.attempts.set(chat.id, stableAttempt);
    attempt.context = processId => {
      const existing = contexts.get(processId);
      if (existing && !existing.disposed) return existing;
      const admitted = authority.forAttempt(binding, this.controllerId, processId);
      let currentLease = null, released = false;
      const context = {
        boundary: "worker-supervisor", processId, identity: selected, binding, claim, records: this.records, authority, admitted,
        issueLease: async () => {
          if (context.disposed) throw failure("process context is disposed");
          const lease = await admitted.issue();
          try {
            const receipt = await this.control({ action: "configure", identity: selected, processId,
              lease: { id: lease.id, generation: lease.generation, expiresAt: lease.expiresAt, credential: lease.credential } });
            if (receipt?.configured !== true || receipt.daemonInstanceId !== status.daemonInstanceId || !safeId(receipt.supervisorInstanceId)
              || status.configured && receipt.supervisorInstanceId !== status.supervisorInstanceId
              || receipt.processId !== processId || receipt.lease?.id !== lease.id || receipt.lease?.generation !== lease.generation) throw failure("daemon rejected the authoritative lease");
          } catch (error) { await admitted.release(lease.id).catch(() => {}); throw error; }
          currentLease = lease; return lease;
        },
        renewLease: async id => {
          if (!currentLease || currentLease.id !== id || context.disposed) throw failure("lease changed");
          const renewed = await admitted.renew(id), lease = { ...renewed, credential: currentLease.credential };
          const receipt = await this.control({ action: "configure", identity: selected, processId, lease });
          if (receipt?.configured !== true || receipt.daemonInstanceId !== status.daemonInstanceId || receipt.processId !== processId
            || receipt.lease?.id !== id || receipt.lease?.generation !== renewed.generation) throw failure("daemon rejected the renewed lease");
          currentLease = lease; return renewed;
        },
        connectTransport: credential => this.connect({ identity: selected, credential }),
        retain: receipt => {
          if (receipt?.processId !== processId || !safeId(receipt.processInstanceId)) throw failure("retained process identity is invalid");
          retained.add(processId); context.receipt = receipt;
        },
        dispose: async ({ receipt = context.receipt, processAbsent = false } = {}) => {
          if (context.disposed) { if (!retained.size) await finalize(); return; }
          if (receipt) {
            if (receipt.processId !== processId || !safeId(receipt.processInstanceId) || !currentLease?.id) throw failure("cleanup process identity is invalid");
            if (!released) {
              let result;
              try { result = await this.control({ action: "release", processId, processInstanceId: receipt.processInstanceId, leaseId: currentLease.id }); }
              catch (error) {
                if (!processAbsent || !processNotFound(error)) throw error;
                const current = await this.control({ action: "status" });
                if (current.processes?.some(process => process.processId === processId)) throw failure("process release was not confirmed");
                result = { released: true };
              }
              if (result?.released !== true) {
                if (!processAbsent) throw failure("process release was not confirmed");
                const current = await this.control({ action: "status" });
                if (current.processes?.some(process => process.processId === processId)) throw failure("process release was not confirmed");
              }
              released = true;
            }
          } else {
            const current = await this.control({ action: "status" });
            if (current.processes?.some(process => process.processId === processId)) throw failure("process cleanup is unconfirmed");
          }
          if (currentLease) { await admitted.release(currentLease.id); currentLease = null; }
          retained.delete(processId); contexts.delete(processId); context.disposed = true;
          if (!retained.size) await finalize();
        },
      };
      contexts.set(processId, context); return context;
    };
    return attempt;
  }
}
