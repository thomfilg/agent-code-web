import { randomUUID } from "node:crypto";
import { CodexAccountClient, CodexAccountError } from "./codex-account-client.mjs";
import { companyForChat, normalizeCompanyScope, scopeAllows } from "../public/company-scope.js";

const fail = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const owner = value => { if (typeof value !== "string" || !/^user_[a-f0-9]{32}$/.test(value)) throw fail("Sign in with Google to connect agent accounts", 401); return value; };
const publicAccount = record => ({ id: record.id, provider: record.provider, name: record.name, companies: record.companies,
  allowUnassigned: record.allowUnassigned, status: record.status, email: record.email || null, plan: record.plan || null,
  error: record.error || null });
const reconnectMessage = "Codex access expired or could not be verified. Reconnect this account; no other credentials were used.";

export class AgentAccounts {
  constructor({ records, config, clientFactory = () => new CodexAccountClient(config), now = Date.now, loginTimeoutMs = 600000, onChange = () => {}, onRevoke = async () => {} }) {
    Object.assign(this, { records, config, clientFactory, now, loginTimeoutMs, onChange, onRevoke });
    this.metadata = new Map(); this.flows = new Map(); this.locks = new Map(); this.closed = false;
  }
  async initialize() {
    for (const record of await this.records.list("agent-account")) {
      if (record.status === "pending") {
        record.status = record.auth ? "connected" : "disconnected";
        record.error = "Sign-in was interrupted by a server restart. Connect again.";
        await this.records.put("agent-account", record.id, record);
      }
      this.metadata.set(record.id, { ownerId: record.ownerId, ...publicAccount(record) });
    }
  }
  list(ownerId) { return [...this.metadata.values()].filter(item => item.ownerId === ownerId).map(publicAccount); }
  hasConnected(ownerId, provider) { return this.list(ownerId).some(item => item.provider === provider && item.status === "connected"); }
  async locked(id, action) {
    const prior = this.locks.get(id) || Promise.resolve();
    const task = prior.catch(() => {}).then(action); this.locks.set(id, task);
    try { return await task; } finally { if (this.locks.get(id) === task) this.locks.delete(id); }
  }
  async get(ownerId, id) {
    owner(ownerId);
    if (!/^account_[a-f0-9-]{36}$/.test(id || "")) throw fail("Agent account not found", 404);
    const record = await this.records.get("agent-account", id);
    if (!record || record.ownerId !== ownerId) throw fail("Agent account not found", 404);
    return record;
  }
  async save(record) {
    await this.records.put("agent-account", record.id, record);
    const visible = { ownerId: record.ownerId, ...publicAccount(record) };
    const changed = JSON.stringify(this.metadata.get(record.id)) !== JSON.stringify(visible);
    this.metadata.set(record.id, visible);
    if (changed) this.onChange(record.ownerId);
    return publicAccount(record);
  }
  async select(ownerId, id, chat = {}, { connected = true } = {}) {
    const record = await this.get(ownerId, id);
    if (record.provider !== chat.agent) throw fail("Choose an account for the selected agent");
    if (!scopeAllows(record, companyForChat(chat))) throw fail("This agent account is not available for this chat's company", 403);
    if (connected && (record.status !== "connected" || !record.auth)) throw fail(reconnectMessage, 409);
    return record;
  }
  async begin(ownerId, input = {}) {
    owner(ownerId);
    if (this.closed) throw fail("Agent accounts are shutting down", 503);
    if (input.provider !== "codex") throw fail("This provider's account login is not available yet");
    const id = input.id || `account_${randomUUID()}`;
    return this.locked(`owner:${ownerId}`, () => this.locked(id, async () => {
      if (this.closed) throw fail("Agent accounts are shutting down", 503);
      const previous = input.id ? await this.get(ownerId, id) : null;
      if (this.flows.has(id)) throw fail("This account already has a pending sign-in", 409);
      if (previous?.status === "connected") throw fail("Disconnect this account before replacing its identity", 409);
      if (!previous && this.list(ownerId).length >= 30) throw fail("This user has reached the limit of 30 saved agent accounts");
      if (this.flows.size >= 16 || [...this.flows.values()].filter(flow => flow.ownerId === ownerId).length >= 2) throw fail("Finish or cancel a pending sign-in first", 429);
      const name = typeof input.name === "string" ? input.name.trim() : previous?.name;
      if (!name || name.length > 80 || /[\x00-\x1f\x7f]/.test(name)) throw fail("Name this account (up to 80 characters)");
      const scope = normalizeCompanyScope(input, previous || {});
      if (!scope.companies.length && !scope.allowUnassigned) throw fail("Select the companies allowed to use this account");
      const record = { id, ownerId, provider: "codex", name, ...scope, status: "pending", auth: null, email: null, plan: null, error: null,
        revision: (previous?.revision || 0) + 1, accountIdentity: previous?.accountIdentity || null, subject: previous?.subject || null };
      await this.save(record);
      const flow = { ownerId, id, client: this.clientFactory(), expiresAt: this.now() + this.loginTimeoutMs };
      this.flows.set(id, flow);
      try {
        await flow.client.start();
        const login = await flow.client.login();
        flow.verificationUrl = login.verificationUrl; flow.userCode = login.userCode;
        flow.timer = setTimeout(() => { void this.cancel(ownerId, id, "Sign-in expired. Connect again.").catch(() => {}); }, this.loginTimeoutMs);
        flow.timer.unref?.();
        login.completed.then(() => this.finish(flow, record), () => this.cancel(ownerId, id, "Codex sign-in was not completed. Try signing in again.")).catch(() => {});
        return this.status(ownerId, id);
      } catch (error) {
        this.flows.delete(id); await flow.client.close().catch(() => {});
        // Only our fixed, credential-free messages can reach the UI. Native
        // errors may contain tokens, codes or URLs and must never be forwarded.
        const message = error instanceof CodexAccountError ? new CodexAccountError(error.code).message : "Codex sign-in could not start on the server. Try again.";
        await this.save({ ...record, status: "disconnected", error: message });
        throw fail(message, 502);
      }
    }));
  }
  async status(ownerId, id) {
    const record = await this.get(ownerId, id), flow = this.flows.get(id);
    return { account: publicAccount(record), ...(flow?.ownerId === ownerId && flow.verificationUrl ? {
      login: { verificationUrl: flow.verificationUrl, userCode: flow.userCode, expiresAt: flow.expiresAt } } : {}) };
  }
  async finish(flow, initial) {
    return this.locked(flow.id, async () => {
      if (this.flows.get(flow.id) !== flow) return;
      try {
        if (this.now() >= flow.expiresAt) throw fail("Sign-in expired. Connect again.");
        const snapshot = await flow.client.snapshot();
        // Reconnect cannot switch an existing chat from a company account to a
        // personal account (or vice versa) under the same saved account ID.
        if (initial.accountIdentity && (initial.accountIdentity !== snapshot.auth.tokens.account_id || initial.subject !== snapshot.subject)) throw fail("You signed in to a different Codex workspace or user. Reconnect the original account, or add a separate named account.");
        await this.save({ ...initial, ...snapshot, accountIdentity: snapshot.auth.tokens.account_id, status: "connected", error: null });
      } catch (error) {
        const message = error instanceof CodexAccountError ? new CodexAccountError(error.code).message
          : error.statusCode ? error.message : "Codex sign-in could not be verified. Reconnect this account.";
        await this.save({ ...initial, status: "disconnected", auth: null, error: message });
      } finally {
        this.flows.delete(flow.id); clearTimeout(flow.timer); await flow.client.close().catch(() => {});
      }
    });
  }
  async cancel(ownerId, id, message = "Sign-in cancelled. Connect again when ready.") {
    return this.locked(id, async () => {
      const record = await this.get(ownerId, id), flow = this.flows.get(id);
      if (flow) {
        this.flows.delete(id); clearTimeout(flow.timer);
        await flow.client.cancel().catch(() => {}); await flow.client.close().catch(() => {});
        await this.save({ ...record, status: "disconnected", auth: null, error: message });
      }
      return this.status(ownerId, id);
    });
  }
  async disconnect(ownerId, id) {
    await this.cancel(ownerId, id);
    await this.locked(id, async () => {
      const record = await this.get(ownerId, id);
      await this.save({ ...record, status: "disconnected", auth: null, revision: record.revision + 1, error: null });
    });
    // Invalidate admission before stopping workers; refresh callbacks can no
    // longer obtain credentials while those processes shut down.
    await this.onRevoke(ownerId, id);
    return this.status(ownerId, id);
  }
  async credentials(ownerId, id, chat, { refresh = false, previousAccountId = null } = {}) {
    return this.locked(id, async () => {
      const record = await this.select(ownerId, id, chat);
      if (previousAccountId && previousAccountId !== record.accountIdentity) throw fail("Codex requested credentials for a different account", 403);
      const client = this.clientFactory();
      try {
        await client.start(record.auth);
        const snapshot = await client.snapshot({ refresh });
        if (snapshot.auth.tokens.account_id !== record.accountIdentity || snapshot.subject !== record.subject) throw fail("Codex account identity changed");
        await this.save({ ...record, ...snapshot });
        return { accessToken: snapshot.auth.tokens.access_token, chatgptAccountId: record.accountIdentity, chatgptPlanType: snapshot.plan };
      } catch {
        await this.save({ ...record, status: "reconnect", error: reconnectMessage });
        throw fail(reconnectMessage, 409);
      } finally { await client.close().catch(() => {}); }
    });
  }
  async models(ownerId, id) {
    return this.locked(id, async () => {
      const record = await this.get(ownerId, id);
      if (record.status !== "connected" || !record.auth) throw fail(reconnectMessage, 409);
      const client = this.clientFactory();
      try {
        await client.start(record.auth);
        const models = []; let cursor;
        do {
          const page = await client.rpc.request("model/list", { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) });
          if (!Array.isArray(page.data) || models.length > 1000) throw fail("Invalid Codex model catalog");
          models.push(...page.data); cursor = page.nextCursor;
        } while (cursor);
        const snapshot = await client.snapshot();
        if (snapshot.auth.tokens.account_id !== record.accountIdentity || snapshot.subject !== record.subject) throw fail("Codex account identity changed");
        await this.save({ ...record, ...snapshot });
        return models;
      } catch { throw fail("Could not load models for this Codex account. Reconnect and retry.", 502); }
      finally { await client.close().catch(() => {}); }
    });
  }
  async close() {
    this.closed = true;
    // A begin() may still be saving its record before registering the flow.
    // Drain starts first so shutdown cannot leave an untracked login process.
    await Promise.allSettled([...this.locks.values()]);
    await Promise.all([...this.flows.values()].map(flow => this.cancel(flow.ownerId, flow.id).catch(() => {})));
    await Promise.allSettled([...this.locks.values()]);
  }
}
