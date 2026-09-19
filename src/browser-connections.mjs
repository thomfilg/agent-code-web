import { EventEmitter } from "node:events";
import { browserSelectionExpression } from "./browser-clipboard.mjs";
import { sendBrowserFrame } from "./browser-frames.mjs";
import { companyForChat } from "../public/company-scope.js";
import { validCompanyId } from "./companies.mjs";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

const digest = value => createHash("sha256").update(String(value)).digest("hex");
const failure = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const equal = (a, b) => typeof a === "string" && typeof b === "string" && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const allowedActions = new Set(["status", "navigate", "reload", "back", "forward", "mouse", "key", "text", "resize", "dialog", "screenshot", "snapshot", "click", "fill", "evaluate", "watch", "copy"]);

export class BrowserConnections extends EventEmitter {
  constructor({ records, store, ttlMs = 3600000, now = Date.now, validateCompany = null }) {
    super(); this.records = records; this.store = store; this.ttlMs = ttlMs; this.now = now; this.validateCompany = validateCompany;
    this.pairings = new Map(); this.bridges = new Map(); this.grants = new Map(); this.epochs = new Map(); this.sequence = 0; this.locks = new Map();
  }
  async locked(id, operation) {
    const previous = this.locks.get(id) || Promise.resolve();
    const result = previous.then(operation), tail = result.catch(() => {}); this.locks.set(id, tail);
    try { return await result; } finally { if (this.locks.get(id) === tail) this.locks.delete(id); }
  }
  async requireCompany(user, companyId) {
    if (!validCompanyId(companyId)) throw failure("Choose a registered company before pairing or sharing Chrome");
    if (!this.validateCompany) throw failure("Company registry is unavailable", 409);
    await this.validateCompany(user, companyId);
  }
  async list(user, { companyId, includeLegacy = false } = {}) {
    if (!user) return [];
    if (companyId !== undefined) await this.requireCompany(user, companyId);
    return (await this.records.list("browser-connection")).filter(c => c.ownerId === user.id && (companyId === undefined || c.companyId === companyId || includeLegacy && !c.companyId)).map(c => ({ id: c.id, name: c.name, companyId: c.companyId || null, createdAt: c.createdAt,
      paired: Boolean(c.tokenHash), online: Boolean(this.bridges.get(c.id)?.ready), tabSelected: Boolean(this.bridges.get(c.id)?.tabSelected),
      sharedChatId: this.bridges.get(c.id)?.active?.chatId || null }));
  }
  async owned(id, user) {
    const connection = await this.records.get("browser-connection", id);
    if (!user || !connection || connection.ownerId !== user.id) throw failure("Browser connection not found", 404);
    return connection;
  }
  async pair(user, input) {
    if (!user) throw failure("Sign in to your private browser account first", 401);
    await this.requireCompany(user, input.companyId);
    if (input.allowUnassigned === true || input.companies?.length > 1) throw failure("A Chrome connection belongs to exactly one company");
    const name = String(input.name || "My Chrome").trim();
    if (!name || name.length > 80) throw failure("Connection name must contain 1–80 characters");
    if ((await this.list(user)).length >= 20) throw failure("Keep at most 20 browser connections");
    for (const [key, pending] of this.pairings) if (pending.expiresAt <= this.now()) this.pairings.delete(key);
    const id = `browser_${randomUUID()}`, code = randomBytes(24).toString("base64url"), expiresAt = this.now() + 5 * 60000;
    await this.records.put("browser-connection", id, { id, ownerId: user.id, name, companyId: input.companyId || null, tokenHash: null, extensionId: null, createdAt: this.now() });
    this.pairings.set(digest(code), { id, ownerId: user.id, expiresAt });
    return { id, code, expiresAt };
  }
  async assign(id, user, companyId) {
    return this.locked(id, async () => {
      const connection = await this.owned(id, user);
      await this.requireCompany(user, companyId);
      if (connection.companyId && connection.companyId !== companyId) throw failure("Remove and pair this profile again to move it to another company", 409);
      if (this.bridges.get(id)?.active) throw failure("Turn off sharing before assigning this profile to a company", 409);
      await this.records.put("browser-connection", id, { ...connection, companyId });
      const bridge = this.bridges.get(id); if (bridge) bridge.connection = { ...connection, companyId };
      return { id, companyId };
    });
  }
  async remove(id, user) {
    return this.locked(id, async () => {
      await this.owned(id, user);
      for (const [key, pending] of this.pairings) if (pending.id === id) this.pairings.delete(key);
      const bridge = this.bridges.get(id);
      if (bridge?.active) await this.revokeChat(bridge.active.chatId);
      this.bridges.delete(id); bridge?.socket.close(1008, "Connection removed");
      await this.records.delete("browser-connection", id);
    });
  }
  changed(chatId) { this.epochs.set(chatId, (this.epochs.get(chatId) || 0) + 1); this.emit("changed", chatId); }
  bindingCurrent(grant) {
    const chat = this.store.get(grant.chatId);
    return Boolean(chat && !chat.archived && chat.ownerId === grant.ownerId && validCompanyId(grant.companyId) && companyForChat(chat) === grant.companyId && grant.bridge.connection.companyId === grant.companyId);
  }
  currentGrant(chatId) {
    const grant = this.grants.get(chatId);
    if (grant && !this.bindingCurrent(grant)) { void this.revokeChat(chatId); return null; }
    return grant;
  }
  info(chatId, user) {
    const grant = this.currentGrant(chatId);
    return { enabled: Boolean(grant?.active && grant.ownerId === user?.id), connectionId: grant && grant.ownerId === user?.id ? grant.connectionId : null,
      privateChat: Boolean(this.store.get(chatId)?.ownerId), user: user ? { id: user.id, username: user.username } : null };
  }
  async enable(chatId, user, connectionId) {
    const chat = this.store.get(chatId);
    if (!user || chat?.ownerId !== user.id) throw failure("Make this chat private to your account before sharing signed-in Chrome", 409);
    if (chat.archived) throw failure("Unarchive this chat before sharing Chrome", 409);
    const grant = await this.locked(connectionId, async () => {
      const connection = await this.owned(connectionId, user); const bridge = this.bridges.get(connectionId);
      if (!connection.companyId || connection.companyId !== companyForChat(chat)) throw failure("Choose a browser connection belonging to this chat's company", 403);
      await this.requireCompany(user, connection.companyId);
      const current = this.store.get(chatId);
      if (!current || current.archived || current.ownerId !== user.id || companyForChat(current) !== connection.companyId) throw failure("The chat changed before Chrome sharing could start", 409);
      if (user.expiresAt && user.expiresAt <= this.now()) throw failure("Sign in again before sharing Chrome", 401);
      if (!bridge?.ready || !bridge.tabSelected) throw failure("Open the Chrome extension and reconnect first", 409);
      if (bridge.active && bridge.active.chatId !== chatId) throw failure("This Chrome connection is shared with another chat. Turn that sharing off first.", 409);
      if (this.grants.has(chatId)) throw failure("Chrome is already shared or switching. Turn sharing off before choosing another connection.", 409);
      const grant = { id: randomBytes(24).toString("base64url"), connectionId, companyId: connection.companyId, ownerId: user.id, chatId, bridge, active: false, viewers: new Set(), state: { running: true, mode: "personal", tabs: [] } };
      this.grants.set(chatId, grant); bridge.active = grant; this.changed(chatId); return grant;
    });
    try {
      if (this.currentGrant(chatId) !== grant) throw failure("Chrome sharing was cancelled", 409);
      grant.state = { ...await this.request(grant.bridge, "authorize", { chatTitle: chat.title }, grant), mode: "personal" };
      if (this.currentGrant(chatId) !== grant) throw failure("Chrome sharing was cancelled", 409);
      grant.active = true;
      grant.timer = setTimeout(() => { void this.revokeChat(chatId); }, Math.min(this.ttlMs, user.expiresAt ? user.expiresAt - this.now() : this.ttlMs)); grant.timer.unref?.();
      this.changed(chatId);
      return this.info(chatId, user);
    } catch (error) { if (this.grants.get(chatId) === grant) await this.revokeChat(chatId); throw error; }
  }
  async revokeChat(chatId) {
    const grant = this.grants.get(chatId); if (!grant) return;
    this.grants.delete(chatId); grant.active = false; clearTimeout(grant.timer);
    if (grant.bridge.active === grant) grant.bridge.active = null;
    // Invalidate results and viewers before waiting for the extension to detach.
    for (const [id, pending] of grant.bridge.pending) if (pending.grantId === grant.id) { clearTimeout(pending.timer); pending.reject(failure("Signed-in browser access revoked")); grant.bridge.pending.delete(id); }
    for (const socket of grant.viewers) socket.close(4001, "Browser access changed");
    this.changed(chatId);
    try { await this.request(grant.bridge, "revoke", {}, grant, 3000); } catch { grant.bridge.socket.close(1000, "Access revoked"); }
  }
  async revokeOwner(ownerId) { await Promise.all([...this.grants.values()].filter(g => g.ownerId === ownerId).map(g => this.revokeChat(g.chatId))); }
  request(bridge, action, params, grant, timeoutMs = 20000) {
    if (bridge.socket.readyState !== 1) return Promise.reject(failure("Personal Chrome is disconnected"));
    if (bridge.pending.size >= 80) return Promise.reject(failure("Personal Chrome is busy; wait for pending actions"));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { bridge.pending.delete(id); reject(failure("Personal Chrome action timed out")); }, timeoutMs);
      bridge.pending.set(id, { resolve, reject, timer, grantId: grant.id });
      bridge.socket.send(JSON.stringify({ id, action, params, grantId: grant.id }));
    });
  }
  async command(chatId, action, params = {}) {
    const grant = this.currentGrant(chatId);
    if (!grant?.active) throw failure("Signed-in Chrome sharing is not enabled", 409);
    if (["newTab", "selectTab", "closeTab"].includes(action)) throw failure("Personal Chrome shares only its separate automation tab, never your existing tabs. Navigate this tab or switch to guest Chrome.");
    if (!allowedActions.has(action)) throw failure("Unsupported personal browser action");
    const result = await this.request(grant.bridge, action === "copy" ? "evaluate" : action, action === "copy" ? { expression: browserSelectionExpression } : params, grant);
    if (!grant.active || this.currentGrant(chatId) !== grant) throw failure("Signed-in browser access revoked");
    return result;
  }
  async attachViewer(chatId, socket) {
    const grant = this.currentGrant(chatId);
    if (!grant?.active) throw failure("Signed-in Chrome sharing is not enabled");
    grant.viewers.add(socket);
    this.emit("viewers", chatId);
    const send = value => { if (socket.readyState === 1) socket.send(JSON.stringify(value)); };
    send({ event: "status", value: { ...grant.state, clipboard: true } });
    let pending = 0;
    socket.on("message", data => {
      let input; try { input = JSON.parse(data); } catch { socket.close(1008, "Invalid input"); return; }
      if (!input || !Number.isInteger(input.id) || !allowedActions.has(input.action) || ["evaluate", "screenshot", "snapshot", "watch"].includes(input.action) || ++pending > 64) { socket.close(1008, "Invalid action"); return; }
      void this.command(chatId, input.action, input.params).then(value => send({ id: input.id, value }), error => send({ id: input.id, error: error.message })).finally(() => { pending--; });
    });
    socket.once("close", () => { grant.viewers.delete(socket); this.emit("viewers", chatId); if (grant.active && !grant.viewers.size) void this.command(chatId, "watch", { enabled: false }).catch(() => {}); });
    await this.command(chatId, "watch", { enabled: true });
  }
  accept(socket, extensionId) {
    let bridge = null, authenticating = false;
    const deadline = setTimeout(() => socket.close(1008, "Pairing required"), 5000);
    let alive = true;
    socket.on("pong", () => { alive = true; });
    const heartbeat = setInterval(() => { if (!alive) { socket.terminate(); return; } alive = false; if (socket.readyState === 1) socket.ping(); }, 15000); heartbeat.unref?.();
    const fail = () => { if (socket.readyState === 1) socket.send(JSON.stringify({ event: "error", message: "Invalid or expired pairing. Create a new code in Browser connections." })); socket.close(1008, "Authentication failed"); };
    socket.on("message", async data => {
      let message; try { message = JSON.parse(data); } catch { fail(); return; }
      if (!message || typeof message !== "object" || Array.isArray(message)) { fail(); return; }
      if (!bridge) {
        if (authenticating) { fail(); return; } authenticating = true;
        try {
          let connection, token, pairing, connectionId;
          if (message.type === "pair") {
            if (!/^[\w-]{32}$/.test(message.code || "")) { fail(); return; }
            const key = digest(message.code); pairing = this.pairings.get(key); this.pairings.delete(key);
            if (!pairing || pairing.expiresAt <= this.now()) { fail(); return; }
            connectionId = pairing.id;
          } else if (message.type === "connect" && /^browser_[a-f0-9-]{36}$/.test(message.id || "") && /^[\w-]{43}$/.test(message.token || "")) {
            connectionId = message.id;
          } else { fail(); return; }
          await this.locked(connectionId, async () => {
            connection = await this.records.get("browser-connection", connectionId);
            if (pairing) {
              if (!connection || connection.ownerId !== pairing.ownerId || connection.tokenHash) { fail(); return; }
              token = randomBytes(32).toString("base64url");
              connection = { ...connection, tokenHash: digest(token), extensionId };
              await this.records.put("browser-connection", connection.id, connection);
            } else if (!connection || connection.extensionId !== extensionId || !equal(connection.tokenHash, digest(message.token))) { fail(); return; }
            if (socket.readyState !== 1) return;
            const previous = this.bridges.get(connection.id);
            if (previous?.active) await this.revokeChat(previous.active.chatId);
            previous?.socket.close(1008, "Reconnected elsewhere");
            bridge = { socket, connection, ready: true, tabSelected: false, pending: new Map(), active: null };
            this.bridges.set(connection.id, bridge); clearTimeout(deadline);
            socket.send(JSON.stringify({ event: "connected", id: connection.id, name: connection.name, ...(token ? { token } : {}) }));
          });
        } catch { fail(); }
        return;
      }
      if (message.type === "ping") { socket.send(JSON.stringify({ event: "pong" })); return; }
      if (message.type === "availability") { bridge.tabSelected = message.tabSelected === true; if (!bridge.tabSelected && bridge.active) await this.revokeChat(bridge.active.chatId); return; }
      if (message.type === "revoked") { if (bridge.active && bridge.active.id === message.grantId) await this.revokeChat(bridge.active.chatId); return; }
      if (message.id) {
        const pending = bridge.pending.get(message.id);
        if (!pending || message.grantId !== pending.grantId) return;
        bridge.pending.delete(message.id); clearTimeout(pending.timer);
        message.error ? pending.reject(failure(String(message.error).slice(0, 1000))) : pending.resolve(message.value); return;
      }
      const grant = bridge.active;
      if (!grant?.active || message.grantId !== grant.id || !["status", "frame", "dialog"].includes(message.event)) return;
      if (this.currentGrant(grant.chatId) !== grant) return;
      if (message.event === "status") grant.state = { ...message.value, mode: "personal" };
      for (const viewer of grant.viewers) if (viewer.readyState === 1) {
        if (message.event === "frame") sendBrowserFrame(viewer, message.value);
        else viewer.send(JSON.stringify({ event: message.event, value: message.event === "status" ? { ...grant.state, clipboard: true } : message.value }));
      }
    });
    socket.once("close", () => {
      clearTimeout(deadline); clearInterval(heartbeat);
      if (!bridge) return;
      if (this.bridges.get(bridge.connection.id) === bridge) this.bridges.delete(bridge.connection.id);
      for (const item of bridge.pending.values()) { clearTimeout(item.timer); item.reject(failure("Personal Chrome disconnected")); } bridge.pending.clear();
      if (bridge.active) void this.revokeChat(bridge.active.chatId);
    });
    socket.on("error", () => {});
  }
  async shutdown() { await Promise.all([...this.grants.keys()].map(id => this.revokeChat(id))); for (const bridge of this.bridges.values()) bridge.socket.close(1000, "Server stopped"); this.bridges.clear(); this.pairings.clear(); }
}
