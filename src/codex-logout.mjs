import { createHash, randomUUID } from "node:crypto";
import { companyForChat } from "../public/company-scope.js";

const conflict = message => Object.assign(new Error(message), { statusCode: 409 });
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
export const logoutHash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export async function codexLogoutPolicy(request, workspace, check = () => {}) {
  let config, requirements;
  try { check(); config = await request("config/read", { cwd: workspace, includeLayers: false }); check(); requirements = await request("configRequirements/read", {}); check(); }
  catch { check(); throw new Error("Cannot verify native credential storage. Refresh /logout and check the worker's Codex version."); }
  const managed = requirements?.requirements, configured = config?.config?.cli_auth_credentials_store ?? "file";
  const modes = ["file", "keyring", "auto", "ephemeral"];
  if (!object(config?.config) || !modes.includes(configured) || managed !== null && (!object(managed) || managed.cliAuthCredentialsStore != null && !modes.includes(managed.cliAuthCredentialsStore))) throw new Error("Unsupported native credential-storage policy");
  const storage = managed?.cliAuthCredentialsStore || configured;
  return { storage, revision: logoutHash([configured, managed?.cliAuthCredentialsStore ?? null]) };
}

export class CodexLogout {
  constructor(store, config) { this.store = store; this.config = config; this.locks = new Map(); this.active = new Set(); }
  binding(chat) {
    return logoutHash([chat.id, chat.ownerId || null, chat.agent, chat.agentSessionId || null, companyForChat(chat),
      (chat.repositories || []).map(repo => repo.fullName || `${repo.owner}/${repo.name}`), chat.environmentId || null, chat.workspace, this.config.codex.authMode, this.config.workerBackend,
      ...(chat.agentAccountId ? ["account", chat.agentAccountId] : [])]);
  }
  #chat(chatId, binding) {
    const chat = this.store.get(chatId);
    if (!chat || chat.agent !== "codex" || binding && binding !== this.binding(chat)) throw conflict("The sign-out owner, company or native session changed. Reopen /logout.");
    if (!this.store.records) throw conflict("Encrypted storage is required to track native sign-out");
    return chat;
  }
  async #locked(chatId, task) {
    const previous = this.locks.get(chatId) || Promise.resolve(), running = previous.catch(() => {}).then(task); this.locks.set(chatId, running);
    try { return await running; } finally { if (this.locks.get(chatId) === running) this.locks.delete(chatId); }
  }
  async #state(chatId) {
    const binding = this.binding(this.#chat(chatId)), saved = await this.store.records.get("native-logout", chatId); this.#chat(chatId, binding);
    return saved?.version === 1 && saved.binding === binding ? saved : { version: 1, binding, reviews: [] };
  }
  async #save(chatId, state) { this.#chat(chatId, state.binding); await this.store.records.put("native-logout", chatId, state); this.#chat(chatId, state.binding); }
  #public(item) {
    return { id: item.id, revision: item.revision, threadId: item.threadId, account: item.account, storage: item.storage, gateway: item.gateway, createdAt: item.createdAt,
      expiresAt: item.expiresAt, completedAt: item.completedAt || null, state: item.state === "signing_out" && !this.active.has(item.id) ? "uncertain" : item.state };
  }
  async status(chatId) { const state = await this.#state(chatId); return { reviews: state.reviews.map(item => this.#public(item)) }; }
  async existing(chatId, input) {
    if (input?.confirm !== true || typeof input.id !== "string" || typeof input.revision !== "string") throw conflict("Review and explicitly confirm native sign-out first");
    const state = await this.#state(chatId), item = state.reviews.find(item => item.id === input.id);
    if (!item || item.revision !== input.revision || item.threadId !== input.threadId) throw conflict("This sign-out review is no longer available. Inspect the account again.");
    return item.state === "reviewed" ? null : this.#public(item);
  }
  async inspect(chatId, adapter, check = () => {}) {
    return this.#locked(chatId, async () => {
      check(); const binding = this.binding(this.#chat(chatId)), snapshot = await adapter.logoutSnapshot(check); check(); const chat = this.#chat(chatId, binding);
      if (chat.agentSessionId !== snapshot.threadId || snapshot.workerId !== adapter.importWorkerId) throw conflict("The native sign-out session changed");
      const view = { threadId: snapshot.threadId, account: snapshot.account, storage: snapshot.storage, gateway: snapshot.gateway, privateProfile: snapshot.privateProfile,
        canLogout: snapshot.canLogout, reason: snapshot.reason, busy: snapshot.busy, credentialPresent: snapshot.credentialPresent };
      if (!snapshot.canLogout) return { ...view, review: null };
      const state = await this.#state(chatId); check(); this.#chat(chatId, binding);
      const item = { id: randomUUID(), snapshotRevision: snapshot.revision, threadId: snapshot.threadId, workerId: snapshot.workerId, account: snapshot.account,
        storage: snapshot.storage, gateway: snapshot.gateway, createdAt: Date.now(), expiresAt: Date.now() + 300000, state: "reviewed" };
      item.revision = logoutHash([binding, item]); state.reviews.unshift(item); state.reviews = state.reviews.slice(0, 20);
      await this.#save(chatId, state); check(); return { ...view, review: this.#public(item) };
    });
  }
  async confirm(chatId, input, adapter, check = () => {}, onIntent = async () => {}) {
    return this.#locked(chatId, async () => {
      check(); const prior = await this.existing(chatId, input); check(); if (prior) return prior;
      const state = await this.#state(chatId), item = state.reviews.find(item => item.id === input.id);
      if (!item || item.revision !== input.revision) throw conflict("The sign-out review changed");
      const guard = () => {
        check(); const chat = this.#chat(chatId, state.binding);
        if (chat.archived || !adapter || adapter.threadId !== item.threadId || adapter.importWorkerId !== item.workerId) throw conflict("The reviewed worker changed or stopped. Inspect the native account again.");
      };
      let dispatched = false;
      try {
        guard(); if (item.expiresAt < Date.now()) throw conflict("The sign-out review expired. Inspect the account again.");
        const fresh = await adapter.logoutSnapshot(guard); guard();
        if (!fresh.canLogout || fresh.revision !== item.snapshotRevision) throw conflict("The reviewed native credentials or storage policy changed. Inspect the account again.");
        if (fresh.busy) throw conflict("Wait for this chat and its agents to be idle before signing out");
        this.active.add(item.id); item.state = "signing_out"; await this.#save(chatId, state); guard();
        await onIntent(); guard();
        await adapter.performLogout(item.snapshotRevision, guard, () => {
          guard(); if (item.expiresAt < Date.now()) throw conflict("The sign-out review expired"); dispatched = true;
        });
        guard(); item.state = "completed"; item.completedAt = Date.now(); await this.#save(chatId, state); return this.#public(item);
      } catch (error) {
        item.state = dispatched ? "uncertain" : "cancelled"; await this.#save(chatId, state).catch(() => {});
        if (dispatched) return this.#public(item); // Never leak native credential/error bodies.
        throw error;
      } finally { this.active.delete(item.id); }
    });
  }
}
