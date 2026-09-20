import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { identity } from "./worker-transport-wire.mjs";
import { companyForChat } from "../public/company-scope.js";
import { environmentAllows } from "../public/environment-scope.js";
import { canonical, digest, leaseFailure, leaseId, revision, scopeRecords, workerAttemptKey } from "./worker-lease-scope.mjs";

const actions = new Set(["launch", "inspect", "attach", "input", "endInput", "ackOutput", "status", "terminate"]);
const hash = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const positive = value => revision(value) && value > 0;
const matches = (first, second) => canonical(first) === canonical(second);
const publicClaim = row => ({ attemptId: workerAttemptKey(row.value.binding.identity), controllerId: row.value.controllerId, controllerEpoch: row.value.controllerEpoch, revision: row.revision });
const leaseView = lease => ({ id: lease.id, generation: lease.generation, expiresAt: lease.expiresAt });
const pending = value => Array.isArray(value?.pendingInvalidations) ? value.pendingInvalidations : [];
const processList = value => Array.isArray(value) && value.length > 0 && value.length <= 16 && value.every(leaseId)
  && new Set(value).size === value.length ? [...value].sort() : null;

// Internal coordinator service only. No HTTP route, global account, deployment
// switch or provider credentials are created or exposed by this partition.
// Leases are process-scoped: reconnecting Chrome cannot fence an attached native
// agent, while a controller takeover still revokes every process atomically.
export class WorkerLeaseAuthority {
  constructor({ records, deploymentId, bootForWorker, legacyOwnerId = null, ttlMs = 30000, invalidateLease, processIds = ["shared-chrome"] }) {
    const allowed = processList(processIds);
    if (!leaseId(deploymentId) || typeof bootForWorker !== "function" || typeof invalidateLease !== "function" || !allowed
      || !Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > 60000
      || legacyOwnerId !== null && !/^user_[a-f0-9]{32}$/.test(legacyOwnerId)) throw leaseFailure("CONFIGURATION_INVALID");
    Object.assign(this, { records, deploymentId, bootForWorker, legacyOwnerId, ttlMs, processIds: allowed, invalidateLease });
    this.claims = new Map();
  }
  #boot(selected) {
    try { const value = this.bootForWorker(selected); if (!hash(value)) throw leaseFailure(); return value; }
    catch { throw leaseFailure("BOOT_UNAVAILABLE"); }
  }
  #binding(binding, { allowStaleBoot = false } = {}) {
    let selected;
    try { selected = identity(binding?.identity); } catch { throw leaseFailure("IDENTITY_INVALID"); }
    if (selected.deploymentId !== this.deploymentId || !["codex", "claude"].includes(selected.provider)
      || binding?.schema !== 2 || !hash(binding.bootId) || !allowStaleBoot && binding.bootId !== this.#boot(selected)
      || !matches(binding.scope, { ownerId: selected.ownerId, chatId: selected.chatId, accountId: selected.accountId,
        companyId: binding.scope?.companyId, environmentId: binding.scope?.environmentId, legacy: selected.ownerId === this.legacyOwnerId })
      || !matches(binding.processIds, this.processIds)) throw leaseFailure("BINDING_INVALID");
    scopeRecords(binding.scope);
    return binding;
  }
  #process(binding, processId) {
    this.#binding(binding);
    const selected = processId ?? (binding.processIds.length === 1 ? binding.processIds[0] : null);
    if (!leaseId(selected) || !binding.processIds.includes(selected)) throw leaseFailure("PROCESS_NOT_ALLOWED");
    return selected;
  }
  #current(binding, records) {
    this.#binding(binding);
    const { identity: selected, scope } = binding, { chat, account, disconnection, company, environment } = records;
    if (!chat || chat.id !== selected.chatId || chat.ownerId !== selected.ownerId || chat.agent !== selected.provider || chat.agentAccountId !== selected.accountId
      || chat.environmentId !== scope.environmentId || chat.archived || chat.workflowState === "archived" || ["stopping", "deleting"].includes(chat.status)
      || !Array.isArray(chat.repositories) || !chat.repositories.length || chat.repositories.length > 100
      || chat.repositories.some(repo => companyForChat({ repositories: [repo] }) !== scope.companyId)
      || chat.runtimeMetadata?.instanceId && chat.runtimeMetadata.instanceId !== selected.workerId
      || !account || account.id !== selected.accountId || account.ownerId !== selected.ownerId || account.provider !== selected.provider
      || account.status !== "connected" || !account.auth || disconnection || !positive(account.revision)
      || !company || company.id !== scope.companyId || !positive(company.revision)
      || !environment || environment.id !== scope.environmentId || environment.archived || !positive(environment.revision) || !environmentAllows(environment, scope.companyId)) throw leaseFailure();
    const revisions = { account: account.revision, company: company.revision, environment: environment.revision };
    const admissionHash = digest(canonical({ ownerId: chat.ownerId, agent: chat.agent, agentAccountId: chat.agentAccountId,
      environmentId: chat.environmentId, repositories: chat.repositories, workerId: chat.runtimeMetadata?.instanceId || null,
      accountIdentity: account.accountIdentity || null, subject: account.subject || null,
      environmentCompany: scope.companyId, revisions }));
    return { revisions, admissionHash };
  }
  #admit(binding, records) {
    const current = this.#current(binding, records);
    if (!matches(current.revisions, binding.revisions) || current.admissionHash !== binding.admissionHash) throw leaseFailure("SCOPE_CHANGED");
  }
  async prepare(selected) {
    selected = identity(selected);
    const chat = await this.records.get("chat", selected.chatId);
    const scope = { ownerId: selected.ownerId, chatId: selected.chatId, accountId: selected.accountId,
      companyId: companyForChat(chat || {}), environmentId: chat?.environmentId, legacy: selected.ownerId === this.legacyOwnerId };
    const refs = scopeRecords(scope), values = await Promise.all(refs.map(([kind, id]) => this.records.get(kind, id)));
    const records = Object.fromEntries(["chat", "account", "disconnection", "company", "environment"].map((key, index) => [key, values[index]]));
    const binding = { schema: 2, identity: selected, bootId: this.#boot(selected), scope, processIds: this.processIds };
    return { ...binding, ...this.#current(binding, records) };
  }
  #transaction(binding, expectedRevision, transition, options) {
    this.#binding(binding, options);
    return this.records.workerAttemptTransaction({ attemptId: workerAttemptKey(binding.identity), expectedRevision, scope: binding.scope }, transition)
      .catch(error => { if (error?.message?.startsWith("Worker lease:")) throw error; throw leaseFailure("STORAGE_FAILURE"); });
  }
  async #row(binding, options) {
    this.#binding(binding, options);
    try {
      const row = await this.records.workerAttemptGet(workerAttemptKey(binding.identity));
      if (!row.value || !matches(row.value.binding, binding)) throw leaseFailure("BINDING_CHANGED");
      return row;
    } catch (error) { if (error?.message?.startsWith("Worker lease:")) throw error; throw leaseFailure("STORAGE_FAILURE"); }
  }
  #owned(row, controllerId) {
    const held = this.claims.get(workerAttemptKey(row.value.binding.identity));
    if (!held || held.controllerId !== controllerId || held.controllerEpoch !== row.value.controllerEpoch || row.value.controllerId !== controllerId
      || row.value.status !== "active") throw leaseFailure("CONTROLLER_FENCED");
  }
  #held(row, controllerId) {
    this.#owned(row, controllerId);
    if (pending(row.value).length) throw leaseFailure("CONTROLLER_FENCED");
  }
  async claim(binding, controllerId, { expectedRevision = 0 } = {}) {
    if (!leaseId(controllerId) || expectedRevision !== 0) throw leaseFailure("CLAIM_INVALID");
    const row = await this.#transaction(binding, expectedRevision, ({ value, records, now }) => {
      if (value) throw leaseFailure("CLAIM_EXISTS"); this.#admit(binding, records);
      return { schema: 2, binding, processIds: binding.processIds, controllerId, controllerEpoch: 1, generation: 0,
        status: "active", leases: {}, pendingInvalidations: [], createdAt: now };
    });
    const claim = publicClaim(row); this.claims.set(claim.attemptId, claim); return claim;
  }
  async takeover(binding, controllerId, { expectedRevision } = {}) {
    if (!leaseId(controllerId) || !positive(expectedRevision)) throw leaseFailure("CLAIM_INVALID");
    let row = await this.#transaction(binding, expectedRevision, ({ value, records }) => {
      if (!value || value.status !== "active" || !matches(value.binding, binding) || value.controllerId === controllerId || pending(value).length) throw leaseFailure("CONTROLLER_FENCED");
      this.#admit(binding, records);
      if (!positive(value.controllerEpoch + 1)) throw leaseFailure("GENERATION_EXHAUSTED");
      const invalidations = value.processIds.flatMap(processId => value.leases?.[processId]
        ? [{ processId, id: value.leases[processId].id }] : []);
      return { ...value, controllerId, controllerEpoch: value.controllerEpoch + 1, leases: {}, pendingInvalidations: invalidations };
    });
    row = await this.#notify(row);
    const claim = publicClaim(row); this.claims.set(claim.attemptId, claim); return claim;
  }
  async #notify(row) {
    while (pending(row.value).length) {
      const target = pending(row.value)[0];
      try { await this.invalidateLease(target.id, target.processId); } catch { throw leaseFailure("INVALIDATION_PENDING"); }
      row = await this.#transaction(row.value.binding, row.revision, ({ value }) => {
        const current = pending(value)[0];
        if (!current || !matches(current, target)) throw leaseFailure("CAS_CONFLICT");
        return { ...value, pendingInvalidations: pending(value).slice(1) };
      }, { allowStaleBoot: true });
    }
    return row;
  }
  async issue(binding, controllerId, processId) {
    processId = this.#process(binding, processId);
    const previous = await this.#row(binding); this.#held(previous, controllerId);
    const credential = randomBytes(32).toString("base64url"), id = randomUUID();
    let row = await this.#transaction(binding, previous.revision, ({ value, records, now }) => {
      this.#held({ value }, controllerId); this.#admit(binding, records);
      const generation = value.generation + 1;
      if (!positive(generation)) throw leaseFailure("GENERATION_EXHAUSTED");
      const old = value.leases?.[processId], pendingInvalidations = old ? [{ processId, id: old.id }] : [];
      return { ...value, generation, pendingInvalidations,
        leases: { ...(value.leases || {}), [processId]: { id, generation, expiresAt: now + this.ttlMs, credentialHash: digest(credential) } } };
    });
    row = await this.#notify(row);
    const lease = row.value.leases[processId];
    if (lease.expiresAt <= Date.now() || lease.expiresAt > Date.now() + 60000) throw leaseFailure("LEASE_EXPIRED");
    return { ...leaseView(lease), credential, processId, claim: publicClaim(row) };
  }
  async authorize(request) {
    try {
      const selected = identity(request?.identity);
      if (selected.deploymentId !== this.deploymentId || !actions.has(request.action) || !leaseId(request.processId)
        || typeof request.lease !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(request.lease)) throw leaseFailure();
      for (let attempt = 0; attempt < 3; attempt++) {
        const row = await this.records.workerAttemptGet(workerAttemptKey(selected)), binding = row.value?.binding;
        if (!binding || !matches(binding.identity, selected)) throw leaseFailure();
        try {
          const checked = await this.#transaction(binding, row.revision, ({ value, records, now }) => {
            const lease = value?.leases?.[request.processId];
            if (!value || value.status !== "active" || pending(value).length || !value.processIds.includes(request.processId)
              || !lease || lease.expiresAt <= now || lease.expiresAt > now + 60000
              || !hash(lease.credentialHash) || !timingSafeEqual(Buffer.from(lease.credentialHash, "hex"), Buffer.from(digest(request.lease), "hex"))) throw leaseFailure();
            this.#admit(binding, records);
          });
          const lease = checked.value.leases[request.processId];
          if (lease.expiresAt <= Date.now()) throw leaseFailure();
          return leaseView(lease);
        } catch (error) {
          if (error.code !== "CAS_CONFLICT" || attempt === 2) throw error;
        }
      }
    } catch { throw leaseFailure(); }
  }
  async renew(binding, controllerId, id, processId) {
    processId = this.#process(binding, processId);
    const previous = await this.#row(binding); this.#held(previous, controllerId);
    const row = await this.#transaction(binding, previous.revision, ({ value, records, now }) => {
      this.#held({ value }, controllerId); this.#admit(binding, records);
      const lease = value.leases?.[processId];
      if (!lease || lease.id !== id || lease.expiresAt <= now) throw leaseFailure("LEASE_EXPIRED");
      return { ...value, leases: { ...value.leases, [processId]: { ...lease, expiresAt: now + this.ttlMs } } };
    });
    const lease = row.value.leases[processId];
    if (lease.expiresAt <= Date.now() || lease.expiresAt > Date.now() + 60000) throw leaseFailure("LEASE_EXPIRED");
    return leaseView(lease);
  }
  async release(binding, controllerId, id, processId) {
    processId = this.#process(binding, processId);
    const previous = await this.#row(binding); this.#owned(previous, controllerId);
    const current = previous.value.leases?.[processId];
    if (!leaseId(id)) throw leaseFailure("LEASE_CHANGED");
    if (!current) {
      if (!pending(previous.value).some(item => item.processId === processId && item.id === id)) throw leaseFailure("LEASE_CHANGED");
      const row = await this.#notify(previous);
      return { released: true, claim: publicClaim(row) };
    }
    if (current.id !== id || pending(previous.value).length) throw leaseFailure("LEASE_CHANGED");
    let row = await this.#transaction(binding, previous.revision, ({ value }) => {
      this.#held({ value }, controllerId);
      const lease = value.leases?.[processId];
      if (!lease || lease.id !== id) throw leaseFailure("LEASE_CHANGED");
      const leases = { ...value.leases }; delete leases[processId];
      return { ...value, leases, pendingInvalidations: [{ processId, id }] };
    });
    row = await this.#notify(row);
    return { released: true, claim: publicClaim(row) };
  }
  async revoke(binding, id) {
    const previous = await this.#row(binding, { allowStaleBoot: true });
    const known = [...Object.values(previous.value.leases || {}), ...pending(previous.value).map(item => ({ id: item.id }))];
    if (id !== undefined && (!leaseId(id) || !known.some(lease => lease.id === id))) throw leaseFailure("LEASE_CHANGED");
    const row = previous.value.status === "revoked" ? previous : await this.#transaction(binding, previous.revision, ({ value, now }) => {
      const additions = value.processIds.flatMap(processId => value.leases?.[processId]
        ? [{ processId, id: value.leases[processId].id }] : []);
      const invalidations = [...pending(value), ...additions].filter((item, index, all) => all.findIndex(other => other.id === item.id) === index);
      return { ...value, status: "revoked", revokedAt: now, leases: {}, pendingInvalidations: invalidations };
    }, { allowStaleBoot: true });
    this.claims.delete(workerAttemptKey(binding.identity)); await this.#notify(row);
    return { revoked: true };
  }
  forAttempt(binding, controllerId, processId) {
    processId = this.#process(binding, processId);
    return { issue: () => this.issue(binding, controllerId, processId), renew: id => this.renew(binding, controllerId, id, processId),
      release: id => this.release(binding, controllerId, id, processId),
      authorize: request => matches(request?.identity, binding.identity) && request.processId === processId ? this.authorize(request) : Promise.reject(leaseFailure()),
      revoke: id => this.revoke(binding, id) };
  }
}
