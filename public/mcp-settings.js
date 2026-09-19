import { scopeLabel, companyForChat } from "./company-scope.js";
import { companyOptions } from "./companies.js";
import { isLinearMcp } from "./mcp-provider.js";
import { companyContext } from "./company-context.js";
const $ = s => document.querySelector(s);
const el = (tag, text, cls) => { const node = document.createElement(tag); node.textContent = text; if (cls) node.className = cls; return node; };
const statuses = { unverified: "Not tested", needs_auth: "Sign-in required", connected: "Connected", error: "Connection failed", worker_pending: "Verified when the worker starts" };
export class McpSettings {
  constructor({ api, toast, state }) {
    Object.assign(this, { api, toast, state });
    $("#mcps-button").onclick = () => this.open(); $("#mcp-close").onclick = () => $("#mcp-dialog").close();
    $("#mcp-new").onclick = () => this.edit();
    $("#mcp-back").onclick = () => this.overview();
    $("#mcp-manage-companies").onclick = () => { $("#mcp-dialog").close(); window.dispatchEvent(new Event("relay-open-companies")); };
    $("#mcp-company-filter").onchange = () => { this.companyId = $("#mcp-company-filter").value; this.renderCards(); };
    $("#mcp-connection-select").onchange = () => this.edit(this.connections.find(connection => connection.id === $("#mcp-connection-select").value), this.preset);
    $("#mcp-add-another").onclick = () => this.edit(this.preset ? this.presetDraft(this.preset) : null, this.preset);
    $("#mcp-type").onchange = () => this.transport(); $("#mcp-auth").onchange = () => this.transport();
    $("#mcp-form").oninput = $("#mcp-form").onchange = event => {
      this.dirty = true;
      if (event.target.id === "mcp-linear-access") $("#mcp-scopes").value = event.target.value;
      if (["mcp-url", "mcp-auth", "mcp-type", "mcp-scopes"].includes(event.target.id)) this.transport();
      this.actions();
    };
    $("#mcp-form").onsubmit = event => this.save(event);
    $("#mcp-form").addEventListener("invalid", event => { if ($("#mcp-advanced").contains(event.target)) $("#mcp-advanced").open = true; }, true);
    for (const action of ["delete", "test", "disconnect"]) $("#mcp-" + action).onclick = () => this.action(action);
    $("#mcp-connect").onclick = () => this.connect();
    $("#mcp-dialog").addEventListener("close", () => { $("#mcp-headers").value = ""; $("#mcp-client-secret").value = ""; this.current = null; clearTimeout(this.oauthTimer); this.pendingOAuth = null; });
    if (location.hash === "#mcp-connections") setTimeout(() => this.open(), 500);
  }
  async load({ validWhile = () => true } = {}) {
    const revision = this.loadRevision = (this.loadRevision || 0) + 1;
    const [saved, catalog, { companies }, github] = await Promise.all([this.api("/api/mcps"), this.api("/api/mcps/presets"), this.api("/api/companies"), this.api("/api/github")]);
    if (revision !== this.loadRevision || !validWhile()) return false;
    if ($("#mcp-dialog").dataset.companyScoped === "true" && !companies.some(company => company.id === this.companyId)) throw new Error("This company is no longer available. Return to Settings and choose a company.");
    this.github = github.connections;
    this.connections = saved.connections; this.presets = catalog.presets; this.companies = companies; this.state.companies = companies;
    if (!companies.some(company => company.id === this.companyId)) this.companyId = companies.find(company => company.id === companyForChat(this.state.active || {}))?.id || companies[0]?.id || "";
    companyOptions($("#mcp-company-filter"), companies, this.companyId);
    companyContext($("#mcp-dialog"), companies, this.companyId);
    this.renderCards();
    return true;
  }
  matchesPreset(connection, preset) { return connection.type === "http" && connection.url?.replace(/\/$/, "") === preset.url.replace(/\/$/, ""); }
  connectionsFor(preset) { return this.connections.filter(connection => this.matchesPreset(connection, preset) && (connection.companyId === this.companyId || !connection.companyId && (!connection.companies?.length || connection.companies.includes(this.companyId)))); }
  presetDraft(preset) {
    let name = preset.id, suffix = 1;
    while (this.connections.some(connection => connection.companyId === this.companyId && connection.name === name)) name = `${preset.id}-${++suffix}`;
    return { name, companyId: this.companyId, type: "http", url: preset.url, authMode: preset.authMode, oauthScopes: preset.oauthScopes };
  }
  status(connection) {
    if (!connection) return "Not connected";
    if (!connection.companyId) return "Choose a company";
    if (["pending", "connecting"].includes(connection.signIn?.status)) return "Sign-in in progress";
    if (connection.oauthConnected && connection.health?.status === "unverified") return "Signed in · not verified";
    return statuses[connection.health?.status] || "Not tested";
  }
  renderCards() {
    $("#mcp-overview-note").textContent = this.companyId ? "Choose a tool to manage this company's connections." : "Add a company first to connect your tools.";
    $("#mcp-new").disabled = !this.companyId;
    $("#mcp-presets").replaceChildren(...this.presets.map(preset => {
      if (preset.id === "github") {
        const connection = this.github.find(account => account.companyId === this.companyId);
        const button = el("button", "", "mcp-preset"); button.type = "button"; button.disabled = !this.companyId; button.dataset.preset = preset.id;
        button.append(el("strong", preset.name), el("span", "Repository tools · uses this company's GitHub account", "muted"), el("span", connection?.connected ? `Connected · ${connection.login}` : "Not connected", connection?.connected ? "connection-status connected" : "connection-status"));
        button.onclick = () => { $("#mcp-dialog").close(); window.dispatchEvent(new CustomEvent("relay-open-github", { detail: { companyId: this.companyId } })); }; return button;
      }
      const connections = this.connectionsFor(preset), connected = connections.find(connection => connection.companyId && connection.health?.status === "connected");
      const button = el("button", "", "mcp-preset"); button.type = "button"; button.disabled = !this.companyId;
      button.dataset.preset = preset.id;
      button.append(el("strong", preset.name), el("span", preset.description, "muted"), el("span", `${this.status(connected || connections[0])}${connections.length > 1 ? ` · ${connections.length} connections` : ""}`, connected ? "connection-status connected" : "connection-status"));
      button.onclick = () => this.edit(connections[0] || this.presetDraft(preset), preset); return button;
    }));
    const custom = this.connections.filter(connection => !this.presets.some(preset => this.matchesPreset(connection, preset)) && (connection.companyId === this.companyId || !connection.companyId));
    $("#mcp-list").replaceChildren(...custom.map(connection => {
      const button = el("button", "", "mcp-preset"); button.type = "button"; button.append(el("strong", connection.name), el("span", this.status(connection), "connection-status"));
      button.onclick = () => this.edit(connection); return button;
    }));
  }
  overview() {
    if (this.busy) return;
    this.current = null; this.dirty = false; this.preset = null;
    $("#mcp-headers").value = ""; $("#mcp-client-secret").value = "";
    $("#mcp-title").textContent = "MCP connections"; $("#mcp-overview").hidden = false; $("#mcp-detail").hidden = true;
    this.renderCards();
  }
  async open(companyId = null, { validWhile = () => true } = {}) { try { if (companyId) this.companyId = companyId; $("#mcp-dialog").dataset.companyScoped = String(Boolean(companyId)); if (!await this.load({ validWhile }) || !validWhile()) return; this.overview(); if (!$("#mcp-dialog").open) $("#mcp-dialog").showModal(); } catch (error) { if (validWhile()) this.toast(error.message); } }
  edit(connection = null, preset = null) {
    this.current = connection?.id ? connection : null; this.dirty = false;
    this.preset = preset || this.presets.find(candidate => connection && this.matchesPreset(connection, candidate)) || null;
    $("#mcp-title").textContent = this.preset?.name || connection?.name || "Custom MCP";
    $("#mcp-overview").hidden = true; $("#mcp-detail").hidden = false;
    $("#mcp-advanced").open = !this.preset;
    $("#mcp-oauth-fields").open = false;
    companyOptions($("#mcp-company"), this.companies, this.current ? connection.companyId : this.companyId);
    $("#mcp-company-review").hidden = !this.current || Boolean(connection.companyId);
    $("#mcp-detail-company").textContent = this.companies.find(company => company.id === this.companyId)?.name || "";
    const siblings = this.preset ? this.connectionsFor(this.preset) : [];
    $("#mcp-connection-switcher").hidden = !siblings.length;
    $("#mcp-connection-select").closest("label").hidden = siblings.length < 2;
    $("#mcp-connection-select").replaceChildren(...siblings.map(item => new Option(item.name, item.id)));
    $("#mcp-connection-select").value = connection?.id || "";
    $("#mcp-error").textContent = ""; $("#mcp-save-status").textContent = "";
    $("#mcp-name").value = connection?.name || ""; $("#mcp-type").value = connection?.type || "http";
    $("#mcp-url").value = connection?.url || ""; $("#mcp-headers").value = ""; $("#mcp-auth").value = connection?.authMode || "oauth";
    $("#mcp-headers").placeholder = connection?.hasCredentials ? `Saved: ${connection.headerNames.join(", ")} · leave blank to keep` : '{"Authorization":"Bearer …"}';
    $("#mcp-client-id").value = connection?.oauthClientId || ""; $("#mcp-scopes").value = connection?.oauthScopes || "";
    $("#mcp-client-secret").value = ""; $("#mcp-client-secret").placeholder = connection?.hasClientSecret ? "Saved · leave blank to keep" : "Usually not needed";
    $("#mcp-callback-url").textContent = `${location.origin}/oauth/mcp/callback`;
    $("#mcp-command").value = connection?.command || ""; $("#mcp-args").value = JSON.stringify(connection?.args || []);
    $("#mcp-delete").hidden = !this.current; this.transport(); this.renderStatus();
    this.renderSignIn();
    if (["pending", "connecting"].includes(connection?.signIn?.status)) {
      this.pendingOAuth = { id: connection.id, attemptId: connection.signIn.id, expires: connection.signIn.expiresAt };
      clearTimeout(this.oauthTimer); this.oauthTimer = setTimeout(() => this.pollOAuth(), 1000);
    }
  }
  renderStatus() {
    const section = $("#mcp-connection-status"); section.replaceChildren();
    const company = this.companies.find(company => company.id === this.current?.companyId)?.name || this.current?.companyId;
    const ready = this.current?.oauthConnected || this.current?.hasCredentials || this.current?.authMode === "none" || this.current?.type === "stdio";
    $("#mcp-availability").textContent = company ? ready ? `Available to ${company} chats. Changes load on the next agent start.` : `Sign in to enable tools for ${company} chats.` : "";
    if (!this.current) return;
    if (["pending", "connecting"].includes(this.current.signIn?.status)) return;
    const health = this.current.health || {};
    section.append(el("p", `${this.status(this.current)}${health.toolCount === undefined ? "" : ` · ${health.toolCount} tools`}`));
    if (health.message && ["error", "needs_auth"].includes(health.status)) section.append(el("p", health.message, "form-error"));
    if (health.tools?.length) {
      const details = document.createElement("details"); details.append(el("summary", "Connection details"));
      if (health.checkedAt) details.append(el("p", `Last verified ${new Date(health.checkedAt).toLocaleString()}`, "muted"));
      const list = el("ul", "", "mcp-tool-list");
      for (const tool of health.tools) { const item = el("li", ""); item.append(el("strong", tool.name), el("p", tool.description, "muted")); list.append(item); } details.append(list); section.append(details);
    }
  }
  actions() {
    const http = this.current?.type === "http", oauth = this.current?.authMode === "oauth";
    $("#mcp-connect").hidden = !http || !oauth; $("#mcp-test").hidden = !http; $("#mcp-disconnect").hidden = !http || !this.current?.oauthConnected;
    $("#mcp-connect").textContent = this.current?.oauthConnected ? "Reconnect" : "Connect with OAuth";
    $("#mcp-connect").className = this.current?.oauthConnected ? "secondary-button" : "primary-button";
    const pending = ["pending", "connecting"].includes(this.current?.signIn?.status);
    for (const id of ["mcp-connect", "mcp-test", "mcp-disconnect"]) { $("#" + id).disabled = Boolean(this.dirty || this.busy || pending || !this.current?.companyId); $("#" + id).title = this.dirty ? "Save your changes first" : ""; }
    for (const id of ["mcp-back", "mcp-save", "mcp-delete", "mcp-company", "mcp-connection-select", "mcp-add-another"]) $("#" + id).disabled = Boolean(this.busy);
    for (const input of $("#mcp-form").querySelectorAll("input, textarea, select")) input.disabled = Boolean(this.busy);
    $("#mcp-save").disabled = Boolean(this.busy || this.current && !this.dirty && this.current.companyId);
    $("#mcp-test").textContent = isLinearMcp(this.current?.url) ? "Verify Linear workspace" : "Test connection";
  }
  transport() {
    const http = $("#mcp-type").value === "http", auth = $("#mcp-auth").value;
    $("#mcp-http").hidden = !http; $("#mcp-stdio").hidden = http; $("#mcp-url").required = http; $("#mcp-command").required = !http;
    $("#mcp-header-fields").hidden = auth !== "headers"; $("#mcp-oauth-fields").hidden = auth !== "oauth"; this.actions();
    const linear = http && auth === "oauth" && isLinearMcp($("#mcp-url").value);
    $("#mcp-linear-fields").hidden = !linear;
    if (linear) {
      if (!$("#mcp-scopes").value.trim()) $("#mcp-scopes").value = "read";
      $("#mcp-linear-access").value = $("#mcp-scopes").value.trim();
    }
  }
  async save(event) {
    event.preventDefault(); if (this.busy) return; this.busy = true; this.actions(); $("#mcp-error").textContent = "";
    try {
      if (!this.state?.config?.features?.companyRegistry) throw new Error("Restart Relay to activate registered companies before saving.");
      const type = $("#mcp-type").value, headers = $("#mcp-headers").value.trim(), secret = $("#mcp-client-secret").value;
      const data = { name: $("#mcp-name").value, companyId: $("#mcp-company").value, type, revision: this.current?.revision,
        ...(type === "http" ? { url: $("#mcp-url").value, authMode: $("#mcp-auth").value, oauthClientId: $("#mcp-client-id").value, oauthScopes: $("#mcp-scopes").value, ...(secret ? { oauthClientSecret: secret } : {}), ...(headers ? { headers: JSON.parse(headers) } : {}) } : { command: $("#mcp-command").value, args: JSON.parse($("#mcp-args").value || "[]") }) };
      const { connection } = await this.api(this.current ? `/api/mcps/${this.current.id}` : "/api/mcps", { method: this.current ? "PATCH" : "POST", body: JSON.stringify(data) });
      this.companyId = connection.companyId;
      await this.load(); this.edit(connection); $("#mcp-save-status").textContent = connection.authMode === "oauth" && !connection.oauthConnected ? "Saved — not signed in yet. Connect below to authorize this company's tools." : "Saved. Available to this company's chats on the next agent start.";
    } catch (error) { $("#mcp-error").textContent = error.message; } finally { this.busy = false; this.actions(); }
  }
  async action(action) {
    if (!this.current || this.busy) return;
    if (action === "delete" && !confirm(`Delete MCP connection “${this.current.name}”?`)) return;
    if (action === "disconnect" && !confirm("Remove OAuth tokens and block existing workers from using this connection? You can also revoke Agent Relay in the provider’s account settings.")) return;
    this.busy = true; this.actions(); const id = this.current.id;
    $("#mcp-error").textContent = ""; $("#mcp-save-status").textContent = action === "test" ? "Connecting and discovering tools…" : "Updating connection…";
    try {
      const result = await this.api(`/api/mcps/${id}${action === "delete" ? "" : `/${action}`}`, { method: action === "delete" ? "DELETE" : "POST" });
      await this.load(); if (this.current?.id === id && !this.dirty) { if (action === "delete") { this.busy = false; this.overview(); } else this.edit(result.connection); }
    } catch (error) { $("#mcp-error").textContent = error.message; } finally { this.busy = false; this.actions(); }
  }
  async connect() {
    if (!this.current || this.dirty || this.busy) return;
    const connection = this.current;
    this.popup = window.open("about:blank", "relay-mcp-oauth", "popup,width=620,height=760");
    if (this.popup) this.popup.document.body.textContent = "Preparing secure MCP sign-in…";
    // The custom authorization site must not be able to navigate the app via
    // window.opener. Poll our authenticated API instead of trusting popup data.
    if (this.popup) this.popup.opener = null;
    this.oauthId = connection.id; this.busy = true; this.actions(); $("#mcp-error").textContent = "";
    $("#mcp-save-status").textContent = "Preparing secure sign-in…";
    try {
      const { authorizationUrl, attemptId } = await this.api(`/api/mcps/${connection.id}/oauth`, { method: "POST" });
      if (this.popup && !this.popup.closed) this.popup.location.replace(authorizationUrl);
      this.oauthLink = { id: connection.id, url: authorizationUrl };
      clearTimeout(this.oauthTimer); this.pendingOAuth = { id: connection.id, attemptId, expires: Date.now() + 600000 };
      await this.load();
      if (this.current?.id === connection.id) {
        this.current = this.connections.find(c => c.id === connection.id); this.renderSignIn(); this.renderStatus();
        $("#mcp-save-status").textContent = "Complete sign-in with the provider. No new permissions are granted until you approve.";
      }
      this.oauthTimer = setTimeout(() => this.pollOAuth(), 1000);
    } catch (error) {
      this.popup?.close(); this.popup = null; $("#mcp-save-status").textContent = ""; $("#mcp-error").textContent = error.message;
      if (error.message.includes("pre-registered")) { $("#mcp-advanced").open = true; $("#mcp-oauth-fields").open = true; $("#mcp-client-id").focus(); }
    }
    finally { this.busy = false; this.actions(); }
  }
  async pollOAuth() {
    const pending = this.pendingOAuth; if (!pending) return;
    try {
      const { connections } = await this.api("/api/mcps");
      if (this.pendingOAuth !== pending) return;
      const connection = connections.find(c => c.id === pending.id);
      if (connection?.oauthConnected && connection.signIn?.status === "complete" && connection.signIn.id === pending.attemptId) {
        this.pendingOAuth = null; await this.load();
        if (this.current?.id === pending.id && !this.dirty) { this.edit(connection); await this.action("test"); }
        else this.toast("MCP signed in. Open its connection to test tools.");
        return;
      }
      if (["failed", "cancelled", "expired"].includes(connection?.signIn?.status)) {
        this.pendingOAuth = null; this.oauthLink = null;
        if (this.current?.id === pending.id) { this.current = connection; this.renderSignIn(); this.renderStatus(); this.actions(); $("#mcp-save-status").textContent = ""; }
        return;
      }
    } catch { /* A transient network failure must not cancel browser consent. */ }
    if (this.pendingOAuth !== pending) return;
    if (Date.now() >= pending.expires) {
      this.pendingOAuth = null; this.oauthLink = null;
      if (this.current?.id === pending.id) { this.current.signIn = { status: "expired", message: "Sign-in expired. Connect again when you are ready." }; this.renderSignIn(); this.renderStatus(); this.actions(); }
      return;
    }
    this.oauthTimer = setTimeout(() => this.pollOAuth(), 2000);
  }
  renderSignIn() {
    const section = $("#mcp-sign-in-status"); section.replaceChildren();
    const attempt = this.current?.signIn;
    if (!attempt || attempt.status === "complete") return;
    section.append(el("strong", `${this.current.name} · ${scopeLabel(this.current)}`), el("p", attempt.message));
    if (!["connecting", "pending"].includes(attempt.status)) return;
    const actions = el("div", "", "mcp-connect-actions");
    if (this.oauthLink?.id === this.current.id) {
      const link = el("a", "Open sign-in window", "secondary-button"); link.href = this.oauthLink.url; link.target = "_blank"; link.rel = "noopener noreferrer"; actions.append(link);
    }
    const id = this.current.id, cancel = el("button", "Cancel sign-in", "secondary-button"); cancel.type = "button";
    cancel.onclick = async () => {
      cancel.disabled = true;
      try {
        await this.api(`/api/mcps/${id}/cancel-oauth`, { method: "POST" });
        if (this.pendingOAuth?.id === id) { this.pendingOAuth = null; clearTimeout(this.oauthTimer); }
        if (this.oauthLink?.id === id) this.oauthLink = null;
        if (this.oauthId === id) this.popup?.close();
        await this.load(); if (this.current?.id === id) this.edit(this.connections.find(c => c.id === id));
      } catch (error) { $("#mcp-error").textContent = error.message; cancel.disabled = false; }
    };
    actions.append(cancel); section.append(actions);
  }
}
