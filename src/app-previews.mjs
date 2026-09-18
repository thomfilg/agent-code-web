import { PreviewGrants } from "./preview-grants.mjs";
import { createWorkerPreviewProxy } from "./worker-preview-proxy.mjs";
import { randomUUID } from "node:crypto";
import { previewAppPath } from "./preview-bootstrap.mjs";

const fail = (message = "App preview is unavailable", statusCode = 409) => Object.assign(new Error(message), { statusCode });
const portNumber = value => {
  if (!Number.isSafeInteger(value) || value < 1024 || value > 65535) throw fail("Choose a port between 1024 and 65535", 400);
  return value;
};
const replies = { none: "Choose the port where your app is running.", pending: "Preparing a private app address. This can take several minutes.",
  ready: "App address ready. Open it to connect to this chat's worker.", revoking: "Access revoked. Removing the app address from AWS.",
  deleted: "App address removed.", error: "The app address could not be prepared. Try again or contact the operator." };

// Owns the integration between authenticated Relay users, persistent host
// assignments and revocable HTTP/WS leases. Browsing never becomes a prompt.
export class AppPreviews {
  constructor({ hosts, identity, store, manager, bootstrapFactory, relayOrigin, validateSession, proxy = createWorkerPreviewProxy(), warmTtlMs = 240000 }) {
    if (!Number.isSafeInteger(warmTtlMs) || warmTtlMs < 1 || warmTtlMs > 240000) throw fail("Invalid worker preparation deadline");
    Object.assign(this, { hosts, identity, store, manager, relayOrigin, proxy });
    this.sessions = new Map(); this.closed = false; this.operations = new Set(); this.reconciling = null; this.pendingRequests = 0;
    this.warming = new Map(); this.warmAcquisitions = new Set(); this.warmTtlMs = warmTtlMs;
    this.validateSession = validateSession || (async binding => {
      if (identity.revoked?.has(binding.sessionId)) return false;
      const session = await identity.records.get("relay-session", binding.sessionId);
      if (!session || session.ownerId !== binding.ownerId || session.expiresAt <= Date.now()) return false;
      const user = await identity.records.get("relay-user", binding.ownerId);
      return Boolean(user && identity.allowedEmail(user.email) && !identity.revoked?.has(binding.sessionId));
    });
    this.grants = new PreviewGrants({ isCurrent: binding => this.isCurrent(binding) });
    this.bootstrap = bootstrapFactory({ relayOrigin, grants: this.grants, lookupHost: hostname => hosts.lookup(hostname),
      isCurrent: binding => this.isCurrent(binding), authenticate: async request => this.remember(await identity.session(request)) });
    this.onRevoke = ({ chatId, reason }) => {
      this.revokeChat(chatId);
      if (reason === "deleted") this.track(this.removeChatHosts(chatId));
    };
    manager.on("preview-revoke", this.onRevoke);
  }
  remember(user) {
    if (!user || typeof user.id !== "string" || typeof user.sessionId !== "string" || this.identity.revoked?.has(user.sessionId) || !Number.isFinite(user.expiresAt) || user.expiresAt <= Date.now()) return null;
    for (const [key, saved] of this.sessions) if (saved.expiresAt <= Date.now()) this.sessions.delete(key);
    const key = JSON.stringify([user.id, user.sessionId]);
    if (!this.sessions.has(key) && this.sessions.size >= 1024) throw fail("Too many preview sessions", 429);
    const saved = Object.freeze({ ...user }); this.sessions.set(key, saved); return saved;
  }
  isCurrent(binding) {
    if (this.closed || this.identity.revoked?.has(binding.sessionId)) return false;
    const selected = this.hosts.lookup(binding.hostname), chat = this.store.get(binding.chatId);
    const user = this.sessions.get(JSON.stringify([binding.ownerId, binding.sessionId]));
    return Boolean(selected && selected.ownerId === binding.ownerId && selected.chatId === binding.chatId && selected.port === binding.port &&
      user && user.expiresAt > Date.now() && this.identity.canRead(chat, user) && !chat.archived &&
      Number.isSafeInteger(binding.runtimeGeneration) && this.manager.previewGeneration(binding.chatId) === binding.runtimeGeneration);
  }
  guard(user, chatId) {
    const current = this.remember(user), chat = this.store.get(chatId);
    if (this.closed) throw fail("App previews are stopping", 503);
    if (!current) throw fail("Sign in to Relay first", 401);
    if (!chat || !this.identity.canRead(chat, current)) throw fail("Chat not found", 404);
    if (chat.archived || chat.status === "stopping") throw fail("Unarchive the chat and wait for its worker to stop before opening an app");
    return current;
  }
  async selected(user, chatId, port) {
    this.guard(user, chatId); portNumber(port);
    const entries = await this.hosts.list({ ownerId: user.id, chatId });
    this.guard(user, chatId);
    return entries.filter(entry => entry.port === port && entry.status !== "deleted").at(-1) || entries.filter(entry => entry.port === port).at(-1) || null;
  }
  public(entry, port) {
    const status = entry?.status || "none";
    return { preview: { id: entry?.id || null, port, status, hostname: status === "ready" ? entry.hostname : null,
      message: replies[status] || replies.error, retryable: ["none", "deleted"].includes(status) || status === "error" && entry.retryable === true, canRevoke: Boolean(entry && !["deleted", "revoking"].includes(status)) } };
  }
  async status(user, chatId, port) { return this.public(await this.selected(user, chatId, port), port); }
  async ensure(user, chatId, port) {
    this.guard(user, chatId); portNumber(port);
    const entry = await this.hosts.ensure({ ownerId: user.id, chatId, port });
    this.guard(user, chatId); this.reconcile(); return this.public(entry, port);
  }
  async remove(user, chatId, port) {
    const entry = await this.selected(user, chatId, port);
    if (!entry || entry.status === "deleted") return this.public(entry, port);
    if (entry.hostname) { this.cancelWarming(job => job.binding.hostname === entry.hostname); this.bootstrap.revokeHostname(entry.hostname); }
    await this.hosts.revoke(entry.id, { ownerId: user.id, chatId });
    this.grants.prune(); this.reconcile(); return this.status(user, chatId, port);
  }
  finishWarming(job) {
    if (this.warming.get(job.id) === job) this.warming.delete(job.id);
    clearTimeout(job.timer); job.controller.abort(); job.held?.release();
  }
  cancelWarming(predicate) { for (const job of [...this.warming.values()]) if (predicate(job)) this.finishWarming(job); }
  async open(user, chatId, port, path = "/", warmingId) {
    const entry = await this.selected(user, chatId, port);
    if (entry?.status !== "ready") throw fail("Wait until the app address is ready");
    // Validate before any worker acquisition. This is the same parser used by
    // the trusted launch document; an invalid app path must never start a VM.
    path = previewAppPath(path, entry.hostname);
    const binding = Object.freeze({ ownerId: user.id, sessionId: user.sessionId, chatId, hostname: entry.hostname, port, runtimeGeneration: this.manager.previewGeneration(chatId) });
    if (!await this.validateSession(binding) || !this.isCurrent(binding)) {
      this.cancelWarming(job => job.binding.ownerId === binding.ownerId && job.binding.sessionId === binding.sessionId);
      throw fail("Sign in again before opening this app", 401);
    }
    const key = JSON.stringify(binding);
    let job;
    if (warmingId !== undefined) {
      job = typeof warmingId === "string" && this.warming.get(warmingId);
      if (!job || job.key !== key || job.path !== path) throw fail("Worker preparation expired or was cancelled. Choose Open app again.");
    } else job = [...this.warming.values()].find(value => value.key === key && value.path === path);
    if (job && (job.expiresAt <= Date.now() || job.controller.signal.aborted || !this.isCurrent(job.binding))) { this.finishWarming(job); throw fail("Worker preparation expired or was cancelled. Choose Open app again."); }
    if (job?.status === "error") { this.finishWarming(job); throw fail("The worker could not be prepared. Choose Open app again.", 503); }
    if (job?.status === "ready") {
      // validateSession above runs on every poll, including this last one.
      // start() mints a fresh bootstrap only now, never while warming/polling.
      try { return this.bootstrap.start({ binding, user, path }); }
      finally { this.finishWarming(job); }
    }
    if (!job) {
      // A cancelled lease cannot cancel an already-issued backend operation.
      // Keep its capacity/drain reservation until the acquisition actually ends.
      const reserved = [...new Set([...this.warming.values(), ...this.warmAcquisitions])];
      if (reserved.length >= 16 || reserved.filter(value => value.binding.ownerId === user.id).length >= 4) throw fail("Too many workers are being prepared. Wait before opening another app.", 429);
      job = { id: "warm_" + randomUUID(), key, binding, path, status: "pending", controller: new AbortController(), held: null,
        expiresAt: Math.min(Date.now() + this.warmTtlMs, user.expiresAt) };
      this.warming.set(job.id, job); // Count before the first acquisition await.
      this.warmAcquisitions.add(job);
      job.timer = setTimeout(() => this.finishWarming(job), Math.max(1, job.expiresAt - Date.now())); job.timer.unref?.();
      const current = job;
      void (async () => {
        try {
          const held = await this.manager.previewActivity.hold(chatId, binding.runtimeGeneration, current.controller.signal);
          current.held = held;
          if (this.warming.get(current.id) !== current || current.controller.signal.aborted || held.signal.aborted ||
              !await this.validateSession(binding) || this.warming.get(current.id) !== current || current.expiresAt <= Date.now() || current.controller.signal.aborted ||
              !this.isCurrent(binding)) { this.finishWarming(current); return; }
          current.status = "ready";
        } catch { if (this.warming.get(current.id) === current) { current.status = "error"; current.held?.release(); } }
        finally { this.warmAcquisitions.delete(current); }
      })();
    }
    return { warming: { id: job.id, status: "pending", retryAfterMs: 1000, message: "Preparing this chat’s worker. No agent prompt is sent." } };
  }
  revokeOwner(ownerId) {
    this.cancelWarming(job => job.binding.ownerId === ownerId);
    this.bootstrap.revokeOwner(ownerId);
    for (const [key, user] of this.sessions) if (user.id === ownerId) this.sessions.delete(key);
  }
  revokeChat(chatId) {
    this.cancelWarming(job => job.binding.chatId === chatId);
    for (const user of this.sessions.values()) this.bootstrap.revokeChat(user.id, chatId);
  }
  async removeChatHosts(chatId) {
    // Called before store deletion. The persistent host registry owns cleanup
    // even if the chat disappears before CloudFront finishes disabling it.
    const chat = this.store.get(chatId);
    const ownerId = chat?.ownerId || this.identity.legacyOwnerId;
    if (!ownerId) return;
    for (const entry of await this.hosts.list({ ownerId, chatId })) if (entry.status !== "deleted") await this.hosts.revoke(entry.id, { ownerId, chatId });
    this.reconcile();
  }
  track(promise) {
    this.operations.add(promise);
    void promise.catch(() => {}).finally(() => this.operations.delete(promise)); return promise;
  }
  reconcile() {
    if (this.closed || this.reconciling) return this.reconciling;
    this.reconciling = this.track(Promise.resolve().then(() => this.hosts.reconcile()).finally(() => { this.reconciling = null; this.grants.prune(); this.cancelWarming(job => !this.isCurrent(job.binding)); }));
    return this.reconciling;
  }
  start() {
    this.reconcile(); this.timer = setInterval(() => this.reconcile(), 5000); this.timer.unref?.();
  }
  async handleRelay(request, response, url) {
    this.pendingRequests++;
    try { return await this.bootstrap.handleRelay(request, response, url); }
    finally { this.pendingRequests--; }
  }
  async lease(request, signal) {
    let lease = this.bootstrap.authorize(request, request.headers.host);
    if (request.headers.origin !== undefined && request.headers.origin !== `https://${lease.binding.hostname}` ||
        request.headers.upgrade && request.headers.origin === undefined) throw fail("Cross-origin app access denied", 403);
    if (!await this.validateSession(lease.binding)) { this.bootstrap.revokeSession(lease.binding.ownerId, lease.binding.sessionId); throw fail("App access expired", 401); }
    lease = this.bootstrap.authorize(request, request.headers.host);
    const activity = await this.manager.previewActivity.hold(lease.binding.chatId, lease.binding.runtimeGeneration, AbortSignal.any([lease.signal, signal]));
    if (!this.isCurrent(lease.binding) || activity.signal.aborted) { activity.release(); throw fail(); }
    return { executor: activity.executor, lease: Object.freeze({ ...lease, signal: activity.signal }), release: activity.release };
  }
  async handleHttp(request, response, url) {
    this.pendingRequests++;
    try { await this.http(request, response, url); }
    finally { this.pendingRequests--; }
  }
  async http(request, response, url) {
    if (await this.bootstrap.handlePreview(request, response, url)) return;
    const abort = new AbortController();
    const disconnected = () => abort.abort();
    request.once("aborted", disconnected); response.once("close", disconnected);
    let held;
    try { held = await this.lease(request, abort.signal); await this.proxy.http(request, response, held); }
    catch { if (!response.headersSent) response.writeHead(403, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer" }); response.end("App access is unavailable. Reopen this app from its Relay chat."); }
    finally { abort.abort(); held?.release(); request.removeListener("aborted", disconnected); response.removeListener("close", disconnected); }
  }
  async handleUpgrade(request, socket, head) {
    this.pendingRequests++;
    const abort = new AbortController(), disconnected = () => abort.abort(); socket.once("close", disconnected);
    let held;
    try {
      if (request.url.startsWith("/__relay_preview/")) throw fail();
      held = await this.lease(request, abort.signal); await this.proxy.upgrade(request, socket, head, held);
    } catch { if (!socket.destroyed) socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n", () => socket.destroySoon()); }
    finally { abort.abort(); held?.release(); socket.removeListener("close", disconnected); this.pendingRequests--; }
  }
  get active() { return this.pendingRequests + this.manager.previewActivity.chats.size + this.operations.size + this.warming.size + this.warmAcquisitions.size; }
  async close() {
    this.closed = true; clearInterval(this.timer); this.bootstrap.close(); this.grants.close();
    this.cancelWarming(() => true);
    this.manager.removeListener("preview-revoke", this.onRevoke);
    await Promise.allSettled([...this.operations]); await this.hosts.close(); this.sessions.clear();
  }
}
