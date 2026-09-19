import { companyForChat } from "./company-scope.js";
import { companyOptions } from "./companies.js";
const $ = selector => document.querySelector(selector);
const node = (tag, text, cls) => { const element = document.createElement(tag); element.textContent = text; if (cls) element.className = cls; return element; };

export class BrowserConnectionSettings {
  constructor({ api, state, toast, browser, accountChanged, chatUpdated }) {
    Object.assign(this, { api, state, toast, browser, accountChanged, chatUpdated });
    this.identityVersion = 0; this.selectionVersion = 0; this.loadVersion = 0;
    this.toggle = $("#signed-chrome-toggle"); this.dialog = $("#browser-connections-dialog"); this.share = $("#browser-share-dialog");
    $("#browser-connections-button").onclick = () => this.open(); $("#browser-connections-close").onclick = () => this.dialog.close();
    $("#browser-share-close").onclick = () => this.share.close();
    $("#browser-share-manage").onclick = () => { this.share.close(); this.open(); };
    $("#browser-account-form").onsubmit = event => this.authenticate(event);
    $("#browser-account-logout").onclick = async () => {
      if (this.state.config?.features.googleLogin) { this.dialog.close(); document.querySelector("#relay-account-button").click(); return; }
      this.identityVersion++; this.clearPairing();
      try { await this.api("/api/browser-account", { method: "DELETE" }); this.user = null; this.toggle.checked = false; this.browser.disconnect(); await this.accountChanged(); await this.load(); }
      catch (error) { this.error(error); }
    };
    $("#browser-pair-form").onsubmit = async event => {
      event.preventDefault(); event.submitter.disabled = true; this.error("");
      const identity = this.identityVersion, selection = this.selectionVersion, companyId = this.companyId;
      if (!companyId) { event.submitter.disabled = true; this.error("Choose a company first."); return; }
      try {
        const result = await this.api("/api/browser-connections", { method: "POST", body: JSON.stringify({ name: $("#browser-connection-name").value, companyId }) });
        if (identity !== this.identityVersion || selection !== this.selectionVersion || !this.dialog.open) return;
        $("#browser-pair-origin").value = location.origin; $("#browser-pair-code").value = result.code; $("#browser-pair-result").hidden = false;
        this.pairingExpires = result.expiresAt; await this.load();
      } catch (error) { if (identity === this.identityVersion && selection === this.selectionVersion) this.error(error); } finally { event.submitter.disabled = !$("#browser-company").value; }
    };
    $("#browser-pair-copy").onclick = async () => { try { await navigator.clipboard.writeText($("#browser-pair-code").value); this.toast("Pairing code copied"); } catch { $("#browser-pair-code").select(); } };
    this.dialog.addEventListener("close", () => { this.selectionVersion++; this.loadVersion++; $("#browser-password").value = ""; this.clearPairing(); });
    $("#browser-company").onchange = () => { if (this.companyLocked) return; this.companyId = $("#browser-company").value; this.selectionVersion++; this.clearPairing(); this.clearConnections(); void this.load().catch(error => this.error(error)); };
    this.toggle.onchange = () => this.change();
    $("#browser-share-form").onsubmit = event => this.enable(event);
    this.share.addEventListener("close", () => { this.toggle.checked = Boolean(this.access?.enabled); });
    this.timer = setInterval(() => {
      if (document.hidden || !this.state.config) return;
      if (this.dialog.open) void this.load().catch(error => this.error(error));
      if (this.chatId && !this.busy) void this.refreshAccess().catch(() => {});
      if (this.pairingExpires && this.pairingExpires <= Date.now()) { $("#browser-pair-code").value = "Expired — generate another code"; this.pairingExpires = null; }
    }, 3000);
  }
  clearPairing() { $("#browser-pair-code").value = ""; $("#browser-pair-result").hidden = true; this.pairingExpires = null; }
  error(error) { $("#browser-settings-error").textContent = error?.message || error || ""; }
  setChat(id) { if (this.chatId === id) return; this.chatId = id; this.access = null; this.toggle.checked = false; this.share.close(); if (id) void this.refreshAccess().catch(() => {}); }
  async refreshAccess() {
    const id = this.chatId, identity = this.identityVersion; if (!id) return;
    const access = await this.api(`/api/chats/${id}/browser/access`);
    if (id !== this.chatId || this.busy || identity !== this.identityVersion) return;
    this.access = access; this.user = access.user;
    if (!this.share.open) this.toggle.checked = access.enabled;
  }
  clearConnections() { this.connections = []; $("#browser-connection-list").replaceChildren(); $("#browser-legacy-list").replaceChildren(); $("#browser-legacy-profiles").hidden = true; $("#browser-pair-form button").disabled = true; }
  async open(companyId = null) { this.companyLocked = Boolean(companyId); this.companyId = companyId || companyForChat(this.state.active || {}); this.selectionVersion++; this.clearPairing(); this.clearConnections(); this.error(""); if (!this.dialog.open) this.dialog.showModal(); try { await this.load(); } catch (error) { this.error(error); } }
  async load() {
    const identity = this.identityVersion, selection = this.selectionVersion, request = ++this.loadVersion;
    const current = () => identity === this.identityVersion && selection === this.selectionVersion && request === this.loadVersion;
    const account = await this.api("/api/browser-account");
    if (!current()) return;
    this.user = account.user;
    $("#browser-account-logout").textContent = account.method === "google" ? "Relay account" : "Sign out";
    $("#browser-account-form").hidden = Boolean(this.user); $("#browser-account-signed-in").hidden = !this.user;
    if (!this.user) { this.clearConnections(); this.clearPairing(); return; }
    $("#browser-account-name").textContent = `Signed in as ${this.user.username}`;
    const { companies } = await this.api("/api/companies");
    if (!current()) return;
    if (this.companyId == null) this.companyId = companies[0]?.id || "";
    const company = companies.find(company => company.id === this.companyId);
    companyOptions($("#browser-company"), companies, this.companyId);
    $("#browser-company-picker").hidden = this.companyLocked; $("#browser-company-name").hidden = !this.companyLocked;
    $("#browser-company-name").textContent = company ? `Company: ${company.name}` : "Company unavailable";
    if (!company) { this.clearConnections(); $("#browser-connection-list").append(node("p", "Choose a registered company before pairing Chrome.", "muted")); return; }
    const connections = (await this.api(`/api/browser-connections?companyId=${encodeURIComponent(company.id)}&includeLegacy=1`)).connections;
    if (!current()) return;
    this.connections = connections;
    $("#browser-pair-form button").disabled = false;
    const list = $("#browser-connection-list"); list.replaceChildren();
    const legacyList = $("#browser-legacy-list"); legacyList.replaceChildren();
    const visible = this.connections.filter(connection => connection.companyId === company.id || !connection.companyId);
    $("#browser-legacy-profiles").hidden = !visible.some(connection => !connection.companyId);
    if (!visible.some(connection => connection.companyId)) { list.append(node("p", "No Chrome profiles paired for this company.", "muted")); $("#browser-pair-instructions").open = true; }
    for (const connection of visible) {
      const row = node("div", "", "browser-connection-row"), info = node("div", ""), remove = node("button", "Remove", "secondary-button");
      info.append(node("strong", connection.name), node("small", connection.sharedChatId ? "Sharing with a private chat" : connection.online ? "Connected · agent access off" : connection.paired ? "Offline · open Chrome and reconnect" : "Waiting for pairing", "muted"));
      remove.type = "button"; remove.setAttribute("aria-label", `Remove browser connection ${connection.name}`);
      remove.onclick = async () => {
        if (!confirm(`Remove “${connection.name}” and revoke its agent access? Your Chrome logins will stay saved.`)) return;
        try { await this.api(`/api/browser-connections/${connection.id}`, { method: "DELETE" }); await this.load(); await this.refreshAccess(); } catch (error) { this.error(error); }
      };
      row.append(info);
      if (!connection.companyId) {
        info.append(node("small", "Choose a company before sharing. Saved Chrome logins are not changed.", "muted"));
        const assign = node("button", `Assign to ${company.name}`, "secondary-button"); assign.type = "button"; assign.disabled = Boolean(connection.sharedChatId);
        assign.onclick = async () => { if (!confirm(`Assign “${connection.name}” to ${company.name}? Its saved Chrome logins stay unchanged, and agent sharing stays off.`)) return; assign.disabled = true; try { await this.api(`/api/browser-connections/${connection.id}`, { method: "PATCH", body: JSON.stringify({ companyId: company.id }) }); await this.load(); } catch (error) { this.error(error); assign.disabled = false; } }; row.append(assign);
      }
      row.append(remove); (connection.companyId ? list : legacyList).append(row);
    }
  }
  async authenticate(event) {
    event.preventDefault(); const button = event.submitter; button.disabled = true; this.error("");
    this.identityVersion++; this.clearPairing();
    try {
      const result = await this.api(`/api/browser-account/${button.value}`, { method: "POST", body: JSON.stringify({ username: $("#browser-username").value, password: $("#browser-password").value }) });
      $("#browser-password").value = ""; this.user = result.user; this.toggle.checked = false; this.browser.disconnect();
      await this.accountChanged(); await this.load(); this.toast("Signed in. Agent access to your Chrome is still off.");
    } catch (error) { this.error(error); } finally { button.disabled = false; }
  }
  async change() {
    if (!this.chatId || this.busy) return;
    const enabled = this.toggle.checked, id = this.chatId; this.toggle.checked = Boolean(this.access?.enabled);
    if (!enabled) {
      this.busy = true; this.toggle.disabled = true;
      try { const access = await this.api(`/api/chats/${id}/browser/access`, { method: "PATCH", body: JSON.stringify({ enabled: false }) }); if (this.chatId === id) { this.access = access; this.toggle.checked = false; this.browser.accessChanged(); } }
      catch (error) { this.toast(error.message); } finally { this.busy = false; this.toggle.disabled = false; }
      return;
    }
    try {
      await this.refreshAccess(); if (!this.user) { this.open(); return; }
      const companyId = companyForChat(this.state.active || {});
      this.connections = companyId ? (await this.api(`/api/browser-connections?companyId=${encodeURIComponent(companyId)}`)).connections.filter(connection => connection.companyId === companyId) : [];
      if (this.chatId !== id) return;
      const select = $("#browser-share-connection"); select.replaceChildren();
      for (const connection of this.connections) { const option = node("option", `${connection.name}${connection.online ? "" : " · offline"}`); option.value = connection.id; option.disabled = !connection.online || Boolean(connection.sharedChatId && connection.sharedChatId !== id); select.append(option); }
      const available = this.connections.find(c => c.online && !c.sharedChatId); if (available) select.value = available.id;
      $("#browser-share-enable").disabled = !available; $("#browser-share-confirm").checked = false;
      $("#browser-share-error").textContent = available ? "" : "Pair and connect a Chrome profile first.";
      $("#browser-share-privacy").textContent = this.access.privateChat ? "This chat is private to your account." : "Enabling will make this chat private to your account, preserving its transcript and workspace. Stop a running agent first. Queued messages will stay paused.";
      this.share.showModal();
    } catch (error) { this.toast(error.message); }
  }
  async enable(event) {
    event.preventDefault(); if (!$("#browser-share-confirm").checked) return;
    const id = this.chatId; this.busy = true; this.toggle.disabled = true; event.submitter.disabled = true;
    try {
      if (!this.access.privateChat) { const { chat } = await this.api(`/api/chats/${id}/privacy`, { method: "POST", body: JSON.stringify({ confirm: true }) }); this.chatUpdated(chat); }
      const access = await this.api(`/api/chats/${id}/browser/access`, { method: "PATCH", body: JSON.stringify({ enabled: true, confirm: true, connectionId: $("#browser-share-connection").value }) });
      if (this.chatId === id) { this.access = access; this.toggle.checked = true; this.share.close(); this.browser.accessChanged(); }
    } catch (error) { $("#browser-share-error").textContent = error.message; }
    finally { this.busy = false; this.toggle.disabled = false; event.submitter.disabled = false; }
  }
}
