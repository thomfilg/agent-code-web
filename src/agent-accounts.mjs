import { createHash, randomUUID } from "node:crypto";
import { CodexAccountClient, CodexAccountError } from "./codex-account-client.mjs";
import { ClaudeAccountClient, ClaudeAccountError } from "./claude-account-client.mjs";
import { agentProjectKey } from "../public/agent-account-options.js";
import { claudeCommandMetadata } from "./command-catalog.mjs";

const fail = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const owner = value => { if (typeof value !== "string" || !/^user_[a-f0-9]{32}$/.test(value)) throw fail("Sign in with Google to connect agent accounts", 401); return value; };
const publicAccount = record => ({ id: record.id, provider: record.provider, name: record.name,
  status: record.status, email: record.email || null, plan: record.plan || null,
  error: record.error || null });
const reconnectMessage = "Codex access expired or could not be verified. Reconnect this account; no other credentials were used.";
const providerLabel = provider => provider === "claude" ? "Claude" : "Codex";
const identity = snapshot => snapshot.accountIdentity || snapshot.auth?.tokens?.account_id;
const reconnectError = provider => provider === "claude" ? new ClaudeAccountError("expired").message : reconnectMessage;

export class AgentAccounts {
  constructor({ records, config, clientFactory = provider => provider === "claude" ? new ClaudeAccountClient(config) : new CodexAccountClient(config), now = Date.now, loginTimeoutMs = 600000, onChange = () => {}, onRevoke = async () => {} }) {
    Object.assign(this, { records, config, clientFactory, now, loginTimeoutMs, onChange, onRevoke });
    this.metadata = new Map(); this.flows = new Map(); this.locks = new Map(); this.removing = new Map(); this.disconnecting = new Map(); this.closed = false;
    this.commandCatalogs = new Map(); this.commandGeneration = 0;
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
    for (const intent of await this.records.list("agent-account-disconnection")) {
      if (this.metadata.get(intent.id)?.ownerId === intent.ownerId) this.disconnecting.set(intent.id, {});
    }
  }
  visible(record) {
    if (this.removing.has(record.id)) return { ...record, status: "disconnected", error: "Account deletion is in progress. Retry deletion if it did not finish." };
    if (this.disconnecting.has(record.id)) return { ...record, status: "disconnecting", error: "Account disconnection is in progress. Retry disconnection if it did not finish." };
    return record;
  }
  list(ownerId) { return [...this.metadata.values()].filter(item => item.ownerId === ownerId).map(item => publicAccount(this.visible(item))); }
  checkDisconnect(id, provider) { if (this.disconnecting.has(id)) throw fail(reconnectError(provider), 409); }
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
    if (!record || record.ownerId !== ownerId || this.removing.has(id)) throw fail("Agent account not found", 404);
    return record;
  }
  async save(record, { guard = null, rollback = null } = {}) {
    if (this.removing.has(record.id)) throw fail("Agent account not found", 404);
    if (record.auth) this.checkDisconnect(record.id, record.provider);
    guard?.();
    await this.records.put("agent-account", record.id, record);
    // Deletion invalidates in-flight refresh/verification before it can
    // publish credentials. Its ID lock removes this provisional write next.
    if (this.removing.has(record.id)) throw fail("Agent account not found", 404);
    if (record.auth) this.checkDisconnect(record.id, record.provider);
    try { guard?.(); } catch (error) {
      // The native ceremony may be cancelled while an asynchronous encrypted
      // write is committing. Undo that provisional write before publishing it.
      if (rollback) await this.records.put("agent-account", record.id, rollback);
      throw error;
    }
    const visible = { ownerId: record.ownerId, ...publicAccount(record) };
    const changed = JSON.stringify(this.metadata.get(record.id)) !== JSON.stringify(visible);
    this.metadata.set(record.id, visible);
    const commands = this.commandCatalogs.get(record.id);
    if (record.status !== "connected" || commands && !this.commandRecordMatches(commands, record)) this.commandCatalogs.delete(record.id);
    if (changed) this.onChange(record.ownerId);
    return publicAccount(record);
  }
  async select(ownerId, id, chat = {}, { connected = true } = {}) {
    const record = await this.get(ownerId, id);
    if (this.removing.has(id)) throw fail("Agent account not found", 404);
    if (record.provider !== chat.agent) throw fail("Choose an account for the selected agent");
    if (connected && (this.disconnecting.has(id) || this.flows.has(id) || record.status !== "connected" || !record.auth)) throw fail(reconnectError(record.provider), 409);
    return record;
  }
  async projectPreferences(ownerId) {
    owner(ownerId);
    const accounts = new Map(this.list(ownerId).filter(account => account.status === "connected").map(account => [account.id, account]));
    const values = await this.records.list("agent-project-preference");
    return Object.fromEntries(values.filter(value => value.ownerId === ownerId && agentProjectKey({ repositories: [{ fullName: value.project }] }) === value.project
      && accounts.get(value.agentAccountId)?.provider === value.agent).map(value => [value.project, { agent: value.agent, agentAccountId: value.agentAccountId }]));
  }
  async rememberProject(ownerId, chat) {
    const project = agentProjectKey(chat);
    if (!project || !chat.agentAccountId) return;
    owner(ownerId);
    const id = createHash("sha256").update(JSON.stringify([ownerId, project])).digest("hex");
    await this.locked(`project:${id}`, async () => {
      await this.select(ownerId, chat.agentAccountId, chat);
      await this.records.put("agent-project-preference", id, { ownerId, project, agent: chat.agent, agentAccountId: chat.agentAccountId });
    });
  }
  commandRecordMatches(cached, record) {
    return cached.ownerId === record.ownerId && cached.revision === record.revision
      && cached.accountIdentity === record.accountIdentity && cached.subject === record.subject && record.provider === "claude";
  }
  async cachedCommands(ownerId, id, chat) {
    const record = await this.select(ownerId, id, chat);
    if (this.closed) throw fail("Agent accounts are shutting down", 503);
    const cached = this.commandCatalogs.get(id);
    const current = cached && this.commandRecordMatches(cached, record) ? cached : null;
    return { commands: structuredClone(current?.commands || []), revision: `${record.revision}:${current?.generation || 0}` };
  }
  async cacheCommands(record, initialized) {
    const commands = claudeCommandMetadata(initialized?.commands);
    if (!commands || this.closed || this.removing.has(record.id) || this.disconnecting.has(record.id) || this.flows.has(record.id)) return;
    const current = await this.records.get("agent-account", record.id);
    // Verification and persistence are asynchronous. Do not attach late native
    // metadata to a replacement/revoked account, even if a storage write races.
    if (this.closed || this.removing.has(record.id) || this.disconnecting.has(record.id) || this.flows.has(record.id) || !current || !this.commandRecordMatches(record, current)
      || current.status !== "connected" || !current.auth) return;
    this.commandCatalogs.set(record.id, { ownerId: record.ownerId, revision: record.revision, accountIdentity: record.accountIdentity,
      subject: record.subject, commands, generation: ++this.commandGeneration });
  }
  async begin(ownerId, input = {}) {
    owner(ownerId);
    if (this.closed) throw fail("Agent accounts are shutting down", 503);
    if (!["codex", "claude"].includes(input.provider)) throw fail("Choose Codex or Claude");
    const id = input.id || `account_${randomUUID()}`;
    return this.locked(`owner:${ownerId}`, () => this.locked(id, async () => {
      if (this.closed) throw fail("Agent accounts are shutting down", 503);
      const previous = input.id ? await this.get(ownerId, id) : null;
      this.checkDisconnect(id, input.provider);
      if (previous && previous.provider !== input.provider) throw fail("An existing account cannot change providers");
      if (this.flows.has(id)) throw fail("This account already has a pending sign-in", 409);
      if (previous?.status === "connected") throw fail("Disconnect this account before replacing its identity", 409);
      if (!previous && this.list(ownerId).length >= 30) throw fail("This user has reached the limit of 30 saved agent accounts");
      if (this.flows.size >= 16 || [...this.flows.values()].filter(flow => flow.ownerId === ownerId).length >= 2) throw fail("Finish or cancel a pending sign-in first", 429);
      const name = typeof input.name === "string" ? input.name.trim() : previous?.name;
      if (!name || name.length > 80 || /[\x00-\x1f\x7f]/.test(name)) throw fail("Name this account (up to 80 characters)");
      const record = { id, ownerId, provider: input.provider, name, status: "pending", auth: null, email: null, plan: null, error: null,
        revision: (previous?.revision || 0) + 1, accountIdentity: previous?.accountIdentity || null, subject: previous?.subject || null };
      await this.save(record);
      const flow = { ownerId, id, revision: record.revision, client: this.clientFactory(record.provider), expiresAt: this.now() + this.loginTimeoutMs };
      this.flows.set(id, flow);
      try {
        await flow.client.start();
        if (flow.cancelled) throw fail(flow.cancelMessage);
        const login = await flow.client.login();
        if (flow.cancelled) throw fail(flow.cancelMessage);
        flow.verificationUrl = login.verificationUrl; flow.userCode = login.userCode;
        flow.inputRequired = login.inputRequired === true;
        flow.timer = setTimeout(() => { void this.cancel(ownerId, id, "Sign-in expired. Connect again.").catch(() => {}); }, this.loginTimeoutMs);
        flow.timer.unref?.();
        login.completed.then(() => this.finish(flow, record), () => {
          if (this.flows.get(id) === flow) return this.cancel(ownerId, id, `${providerLabel(record.provider)} sign-in was not completed. Try signing in again.`);
        }).catch(() => {});
        return this.status(ownerId, id);
      } catch (error) {
        this.flows.delete(id); await flow.client.close().catch(() => {});
        // Only our fixed, credential-free messages can reach the UI. Native
        // errors may contain tokens, codes or URLs and must never be forwarded.
        const message = flow.cancelled ? flow.cancelMessage : error instanceof ClaudeAccountError ? new ClaudeAccountError(error.code).message : error instanceof CodexAccountError ? new CodexAccountError(error.code).message : `${providerLabel(record.provider)} sign-in could not start on the server. Try again.`;
        await this.save({ ...record, status: "disconnected", error: message });
        throw fail(message, 502);
      }
    }));
  }
  async status(ownerId, id) {
    const record = await this.get(ownerId, id), flow = this.flows.get(id);
    if (this.removing.has(id)) throw fail("Agent account not found", 404);
    // Never publish provisional database state from an unfinished guarded
    // commit. Admission is separately blocked while the flow owns this ID.
    const visible = flow ? this.metadata.get(id) || record : record;
    return { account: publicAccount(this.visible(visible)), ...(flow?.ownerId === ownerId && !flow.cancelled && flow.verificationUrl ? {
      login: { verificationUrl: flow.verificationUrl, ...(flow.inputRequired ? { inputRequired: true, codeSubmitted: flow.codeSubmitted === true } : { userCode: flow.userCode }), expiresAt: flow.expiresAt } } : {}) };
  }
  async submitCode(ownerId, id, input = {}) {
    return this.locked(id, async () => {
      const record = await this.get(ownerId, id), flow = this.flows.get(id);
      if (record.provider !== "claude" || flow?.ownerId !== ownerId || flow.cancelled || !flow.inputRequired || this.now() >= flow.expiresAt) throw fail("Sign-in is not pending. Reconnect this account.", 409);
      try { await flow.client.submitCode(input.code); flow.codeSubmitted = true; }
      catch (error) { throw fail(error instanceof ClaudeAccountError ? new ClaudeAccountError(error.code).message : new ClaudeAccountError().message); }
      return this.status(ownerId, id);
    });
  }
  async finish(flow, initial) {
    return this.locked(flow.id, async () => {
      if (this.flows.get(flow.id) !== flow) return;
      const guard = () => {
        if (flow.cancelled) throw fail(flow.cancelMessage);
        if (this.closed || this.flows.get(flow.id) !== flow) throw fail("Sign-in was cancelled. Connect again.");
        if (this.now() >= flow.expiresAt) throw fail("Sign-in expired. Connect again.");
      };
      try {
        guard();
        const snapshot = await flow.client.snapshot();
        guard();
        // Reconnect cannot switch an existing chat from a company account to a
        // personal account (or vice versa) under the same saved account ID.
        if (initial.accountIdentity && (initial.accountIdentity !== identity(snapshot) || initial.subject !== snapshot.subject)) throw fail(`You signed in to a different ${providerLabel(initial.provider)} workspace or user. Reconnect the original account, or add a separate named account.`);
        await this.save({ ...initial, ...snapshot, accountIdentity: identity(snapshot), status: "connected", error: null }, { guard, rollback: initial });
      } catch (error) {
        await this.save({ ...initial, status: "disconnected", auth: null, error: flow.cancelled ? flow.cancelMessage : error instanceof ClaudeAccountError ? new ClaudeAccountError(error.code).message : error instanceof CodexAccountError ? new CodexAccountError(error.code).message : error.statusCode ? error.message : `${providerLabel(initial.provider)} sign-in could not be verified. Reconnect this account.` });
      } finally {
        this.flows.delete(flow.id); clearTimeout(flow.timer); await flow.client.close().catch(() => {});
      }
    });
  }
  async cancel(ownerId, id, message = "Sign-in cancelled. Connect again when ready.") {
    owner(ownerId);
    const pending = this.flows.get(id);
    if (pending?.ownerId === ownerId && !pending.cancelled) {
      // Invalidate synchronously, before waiting behind verification/storage.
      // A different user's request cannot invalidate this account's ceremony.
      pending.cancelled = true; pending.cancelMessage = message; clearTimeout(pending.timer);
      void pending.client.cancel().catch(() => {});
    }
    return this.locked(id, async () => {
      const record = await this.get(ownerId, id), flow = this.flows.get(id);
      // A begin already queued behind verification can acquire this lock
      // before cancel does. This request only cancelled its captured attempt.
      if (pending?.ownerId === ownerId && (record.revision !== pending.revision || flow && flow !== pending)) return this.status(ownerId, id);
      if (flow || pending?.ownerId === ownerId) {
        if (flow) {
          this.flows.delete(id); clearTimeout(flow.timer);
          await flow.client.cancel().catch(() => {}); await flow.client.close().catch(() => {});
        }
        await this.save({ ...record, status: "disconnected", auth: null, error: pending?.cancelMessage || message });
      }
      return this.status(ownerId, id);
    });
  }
  async disconnect(ownerId, id) {
    owner(ownerId);
    if (this.metadata.get(id)?.ownerId !== ownerId || this.removing.has(id)) throw fail("Agent account not found", 404);
    const existing = this.disconnecting.get(id);
    if (existing?.promise) return existing.promise;
    // Admission and in-flight credential publication must stop before waiting
    // behind native refresh, model discovery or encrypted storage writes.
    const disconnection = {}; this.disconnecting.set(id, disconnection);
    this.commandCatalogs.delete(id); this.onChange(ownerId);
    // Independent durable intent survives a failed credential-row erase or
    // worker stop. Initialization restores the admission barrier before use.
    const intent = Promise.resolve().then(() => this.records.put("agent-account-disconnection", id, { id, ownerId }));
    const cancelled = this.cancel(ownerId, id);
    const erase = cancelled.then(() => this.locked(id, async () => {
      const record = await this.get(ownerId, id);
      // Disconnect targets the whole saved account, unlike attempt-scoped
      // cancellation. Invalidate a replacement queued before this lock too.
      const flow = this.flows.get(id);
      if (flow) {
        flow.cancelled = true; flow.cancelMessage = "Account disconnected.";
        this.flows.delete(id); clearTimeout(flow.timer);
        await flow.client.cancel().catch(() => {}); await flow.client.close().catch(() => {});
      }
      await this.save({ ...record, status: "disconnected", auth: null, revision: record.revision + 1, error: null });
    }));
    const revoked = Promise.resolve().then(() => this.onRevoke(ownerId, id));
    disconnection.promise = Promise.allSettled([intent, erase, revoked]).then(async results => {
      if (results.some(result => result.status === "rejected")) {
        disconnection.promise = null; this.onChange(ownerId);
        throw fail("Account disconnection could not finish. Access is blocked; retry disconnecting this account.", 503);
      }
      try { await this.records.delete("agent-account-disconnection", id); }
      catch {
        disconnection.promise = null; this.onChange(ownerId);
        throw fail("Account disconnection could not finish. Access is blocked; retry disconnecting this account.", 503);
      }
      this.disconnecting.delete(id); this.onChange(ownerId);
      return this.status(ownerId, id);
    });
    return disconnection.promise;
  }
  async remove(ownerId, id) {
    owner(ownerId);
    if (this.metadata.get(id)?.ownerId !== ownerId) throw fail("Agent account not found", 404);
    const existing = this.removing.get(id);
    if (existing?.promise) return existing.promise;
    // Owner-checked invalidation must happen before any asynchronous lock or
    // database operation, including a currently gated credential refresh.
    const removal = { ownerId }; this.removing.set(id, removal);
    this.commandCatalogs.delete(id);
    const flow = this.flows.get(id);
    if (flow) {
      flow.cancelled = true; flow.cancelMessage = "Account deleted."; clearTimeout(flow.timer);
      void flow.client.cancel().catch(() => {});
    }
    const erase = this.locked(id, async () => {
      const record = await this.records.get("agent-account", id);
      if (!record) {
        // Retry after credential erasure succeeded but intent cleanup failed.
        await this.records.delete("agent-account-disconnection", id); return;
      }
      if (record.ownerId !== ownerId) throw fail("Agent account not found", 404);
      const pending = this.flows.get(id);
      if (pending) {
        this.flows.delete(id); clearTimeout(pending.timer);
        await pending.client.cancel().catch(() => {}); await pending.client.close().catch(() => {});
      }
      // If deletion fails, durable credentials are still revoked and the
      // account can safely be retried. Do not modify any chat/account binding.
      const disconnected = { ...record, status: "disconnected", auth: null, revision: record.revision + 1, error: null };
      await this.records.put("agent-account", id, disconnected);
      this.metadata.set(id, { ownerId, ...publicAccount(disconnected) });
      await this.records.delete("agent-account", id);
      await this.records.delete("agent-account-disconnection", id);
    });
    // Stop workers in parallel with lock drainage. Admission and refresh are
    // already unavailable, so no worker can obtain replacement credentials.
    const revoked = Promise.resolve().then(() => this.onRevoke(ownerId, id));
    removal.promise = Promise.allSettled([erase, revoked]).then(results => {
      if (results.some(result => result.status === "rejected")) {
        removal.promise = null; this.onChange(ownerId);
        throw fail("Account deletion could not finish. Access is blocked; retry deleting this account.", 503);
      }
      this.metadata.delete(id); this.removing.delete(id); this.disconnecting.delete(id); this.onChange(ownerId);
      return { deleted: true, id };
    });
    return removal.promise;
  }
  async credentials(ownerId, id, chat, { refresh = false, previousAccountId = null } = {}) {
    return this.locked(id, async () => {
      let record = await this.select(ownerId, id, chat);
      if (previousAccountId && previousAccountId !== record.accountIdentity) throw fail("The agent requested credentials for a different account", 403);
      const client = this.clientFactory(record.provider);
      try {
        await client.start(record.auth);
        const snapshot = await client.snapshot({ refresh, ...(record.provider === "claude" ? { onCredentials: async auth => {
          const next = { ...record, auth }; await this.save(next); record = next;
        } } : {}) });
        if (identity(snapshot) !== record.accountIdentity || snapshot.subject !== record.subject) throw fail("Agent account identity changed");
        await this.save({ ...record, ...snapshot, error: null });
        if (this.removing.has(id)) throw fail("Agent account not found", 404);
        if (record.provider === "claude") return { accessToken: snapshot.auth.claudeAiOauth.accessToken, accountId: record.subject, organizationId: record.accountIdentity, email: snapshot.email, expiresAt: snapshot.auth.claudeAiOauth.expiresAt };
        return { accessToken: snapshot.auth.tokens.access_token, chatgptAccountId: record.accountIdentity, chatgptPlanType: snapshot.plan };
      } catch (error) {
        this.checkDisconnect(id, record.provider);
        const temporary = record.provider === "claude" && error instanceof ClaudeAccountError && error.code === "temporary";
        const message = temporary ? new ClaudeAccountError("temporary").message : reconnectError(record.provider);
        await this.save({ ...record, status: temporary ? "connected" : "reconnect", error: message });
        throw fail(message, temporary ? 503 : 409);
      } finally {
        await client.close().catch(() => {});
        if (this.removing.has(id)) throw fail("Agent account not found", 404);
        this.checkDisconnect(id, record.provider);
      }
    });
  }
  async models(ownerId, id, provider = null) {
    return this.locked(id, async () => {
      let record = await this.get(ownerId, id);
      this.checkDisconnect(id, record.provider);
      if (provider && record.provider !== provider) throw fail("Choose an account for the selected agent");
      if (record.status !== "connected" || !record.auth) throw fail(reconnectError(record.provider), 409);
      const client = this.clientFactory(record.provider);
      try {
        await client.start(record.auth);
        if (record.provider === "claude") {
          const models = await client.models(), snapshot = await client.snapshot({ onCredentials: async auth => {
            const next = { ...record, auth }; await this.save(next); record = next;
          } });
          if (identity(snapshot) !== record.accountIdentity || snapshot.subject !== record.subject) throw fail("Agent account identity changed");
          await this.save({ ...record, ...snapshot, error: null });
          if (this.removing.has(id)) throw fail("Agent account not found", 404);
          await this.cacheCommands(record, client.initialized);
          return models;
        }
        const models = []; let cursor;
        do {
          const page = await client.rpc.request("model/list", { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) });
          if (!Array.isArray(page.data) || models.length > 1000) throw fail("Invalid Codex model catalog");
          models.push(...page.data); cursor = page.nextCursor;
        } while (cursor);
        const snapshot = await client.snapshot();
        if (snapshot.auth.tokens.account_id !== record.accountIdentity || snapshot.subject !== record.subject) throw fail("Codex account identity changed");
        await this.save({ ...record, ...snapshot });
        if (this.removing.has(id)) throw fail("Agent account not found", 404);
        return models;
      } catch (error) {
        if (this.removing.has(id)) throw fail("Agent account not found", 404);
        this.checkDisconnect(id, record.provider);
        if (record.provider === "claude") {
          const temporary = error instanceof ClaudeAccountError && error.code === "temporary";
          const message = temporary ? new ClaudeAccountError("temporary").message : reconnectError(record.provider);
          await this.save({ ...record, status: temporary ? "connected" : "reconnect", error: message });
          throw fail(message, temporary ? 503 : 409);
        }
        throw fail(`Could not load models for this ${providerLabel(record.provider)} account. Reconnect and retry.`, 502);
      }
      finally {
        await client.close().catch(() => {});
        if (this.removing.has(id)) throw fail("Agent account not found", 404);
        this.checkDisconnect(id, record.provider);
      }
    });
  }
  async close() {
    this.closed = true;
    this.commandCatalogs.clear();
    // A begin() may still be saving its record before registering the flow.
    // Drain starts first so shutdown cannot leave an untracked login process.
    await Promise.allSettled([...this.locks.values()]);
    await Promise.allSettled([...this.removing.values()].map(removal => removal.promise).filter(Boolean));
    await Promise.allSettled([...this.disconnecting.values()].map(disconnection => disconnection.promise).filter(Boolean));
    await Promise.all([...this.flows.values()].map(flow => this.cancel(flow.ownerId, flow.id).catch(() => {})));
    await Promise.allSettled([...this.locks.values()]);
  }
}
