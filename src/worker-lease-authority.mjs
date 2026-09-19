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

// Internal coordinator service only. No HTTP route, global account, deployment
// switch or provider credentials are created or exposed by this partition.
export class WorkerLeaseAuthority {
  constructor({ records, deploymentId, bootForWorker, legacyOwnerId = null, ttlMs = 30000, invalidateLease }) {
    if (!leaseId(deploymentId) || typeof bootForWorker !== "function" || typeof invalidateLease !== "function" || !Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > 60000
      || legacyOwnerId !== null && !/^user_[a-f0-9]{32}$/.test(legacyOwnerId)) throw leaseFailure("CONFIGURATION_INVALID");
    Object.assign(this, { records, deploymentId, bootForWorker, legacyOwnerId, ttlMs, invalidateLease });
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
      || binding?.schema !== 1 || !hash(binding.bootId) || !allowStaleBoot && binding.bootId !== this.#boot(selected)
      || !matches(binding.scope, { ownerId: selected.ownerId, chatId: selected.chatId, accountId: selected.accountId,
        companyId: binding.scope?.companyId, environmentId: binding.scope?.environmentId, legacy: selected.ownerId === this.legacyOwnerId })
      || !Array.isArray(binding.processIds) || binding.processIds.length !== 1 || binding.processIds[0] !== "shared-chrome") throw leaseFailure("BINDING_INVALID");
    scopeRecords(binding.scope);
    return binding;
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
    const binding = { schema: 1, identity: selected, bootId: this.#boot(selected), scope, processIds: ["shared-chrome"] };
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
  #held(row, controllerId) {
    const held = this.claims.get(workerAttemptKey(row.value.binding.identity));
    if (!held || held.controllerId !== controllerId || held.controllerEpoch !== row.value.controllerEpoch || row.value.controllerId !== controllerId
      || row.value.status !== "active" || row.value.pendingInvalidation) throw leaseFailure("CONTROLLER_FENCED");
  }
  async claim(binding, controllerId, { expectedRevision = 0 } = {}) {
    if (!leaseId(controllerId) || expectedRevision !== 0) throw leaseFailure("CLAIM_INVALID");
    const row = await this.#transaction(binding, expectedRevision, ({ value, records, now }) => {
      if (value) throw leaseFailure("CLAIM_EXISTS"); this.#admit(binding, records);
      return { schema: 1, binding, processIds: binding.processIds, controllerId, controllerEpoch: 1, generation: 0, status: "active", lease: null, pendingInvalidation: null, createdAt: now };
    });
    const claim = publicClaim(row); this.claims.set(claim.attemptId, claim); return claim;
  }
  async takeover(binding, controllerId, { expectedRevision } = {}) {
    if (!leaseId(controllerId) || !positive(expectedRevision)) throw leaseFailure("CLAIM_INVALID");
    let row = await this.#transaction(binding, expectedRevision, ({ value, records }) => {
      if (!value || value.status !== "active" || !matches(value.binding, binding) || value.controllerId === controllerId || value.pendingInvalidation) throw leaseFailure("CONTROLLER_FENCED");
      this.#admit(binding, records);
      if (!positive(value.controllerEpoch + 1)) throw leaseFailure("GENERATION_EXHAUSTED");
      return { ...value, controllerId, controllerEpoch: value.controllerEpoch + 1, lease: null, pendingInvalidation: value.lease?.id || null };
    });
    row = await this.#notify(row);
    const claim = publicClaim(row); this.claims.set(claim.attemptId, claim); return claim;
  }
  async #notify(row) {
    const id = row.value.pendingInvalidation;
    if (!id) return row;
    try { await this.invalidateLease(id); } catch { throw leaseFailure("INVALIDATION_PENDING"); }
    return this.#transaction(row.value.binding, row.revision, ({ value }) => {
      if (!value || value.pendingInvalidation !== id) throw leaseFailure("CAS_CONFLICT");
      return { ...value, pendingInvalidation: null };
    }, { allowStaleBoot: true });
  }
  async issue(binding, controllerId) {
    const previous = await this.#row(binding); this.#held(previous, controllerId);
    const credential = randomBytes(32).toString("base64url"), id = randomUUID();
    let row = await this.#transaction(binding, previous.revision, ({ value, records, now }) => {
      this.#held({ value }, controllerId); this.#admit(binding, records);
      const generation = value.generation + 1;
      if (!positive(generation)) throw leaseFailure("GENERATION_EXHAUSTED");
      return { ...value, generation, pendingInvalidation: value.lease?.id || null,
        lease: { id, generation, expiresAt: now + this.ttlMs, credentialHash: digest(credential) } };
    });
    row = await this.#notify(row);
    // A delayed COMMIT/notification is not an extension of the stored deadline.
    if (row.value.lease.expiresAt <= Date.now() || row.value.lease.expiresAt > Date.now() + 60000) throw leaseFailure("LEASE_EXPIRED");
    return { ...leaseView(row.value.lease), credential, claim: publicClaim(row) };
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
            if (!value || value.status !== "active" || value.pendingInvalidation || !value.processIds.includes(request.processId)
              || !value.lease || value.lease.expiresAt <= now || value.lease.expiresAt > now + 60000
              || !hash(value.lease.credentialHash) || !timingSafeEqual(Buffer.from(value.lease.credentialHash, "hex"), Buffer.from(digest(request.lease), "hex"))) throw leaseFailure();
            this.#admit(binding, records);
          });
          if (checked.value.lease.expiresAt <= Date.now()) throw leaseFailure();
          return leaseView(checked.value.lease);
        } catch (error) {
          // Only this read-only operation may retry a raced renewal. Re-read
          // every binding/credential/scope; never retry input or lease issuance.
          if (error.code !== "CAS_CONFLICT" || attempt === 2) throw error;
        }
      }
    } catch { throw leaseFailure(); }
  }
  async renew(binding, controllerId, id) {
    const previous = await this.#row(binding); this.#held(previous, controllerId);
    const row = await this.#transaction(binding, previous.revision, ({ value, records, now }) => {
      this.#held({ value }, controllerId); this.#admit(binding, records);
      if (!value.lease || value.lease.id !== id || value.lease.expiresAt <= now) throw leaseFailure("LEASE_EXPIRED");
      return { ...value, lease: { ...value.lease, expiresAt: now + this.ttlMs } };
    });
    if (row.value.lease.expiresAt <= Date.now() || row.value.lease.expiresAt > Date.now() + 60000) throw leaseFailure("LEASE_EXPIRED");
    return leaseView(row.value.lease);
  }
  async revoke(binding, id) {
    const previous = await this.#row(binding, { allowStaleBoot: true });
    if (id !== undefined && (!leaseId(id) || previous.value.lease?.id !== id && previous.value.pendingInvalidation !== id)) throw leaseFailure("LEASE_CHANGED");
    const row = previous.value.status === "revoked" ? previous : await this.#transaction(binding, previous.revision, ({ value, now }) => ({
      ...value, status: "revoked", revokedAt: now, pendingInvalidation: value.pendingInvalidation || value.lease?.id || null,
    }), { allowStaleBoot: true });
    this.claims.delete(workerAttemptKey(binding.identity)); await this.#notify(row);
    return { revoked: true };
  }
  // The browser slice receives the expected facade; claim/takeover remains a
  // separate explicit coordinator operation, never an implicit issue fallback.
  forAttempt(binding, controllerId) {
    this.#binding(binding);
    return { issue: () => this.issue(binding, controllerId), renew: id => this.renew(binding, controllerId, id),
      authorize: request => matches(request?.identity, binding.identity) ? this.authorize(request) : Promise.reject(leaseFailure()), revoke: id => this.revoke(binding, id) };
  }
}
