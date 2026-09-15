import { repositoryGroup } from "./chat-organization.js";
const $ = s => document.querySelector(s);
const el = (tag, text, cls) => { const node = document.createElement(tag); node.textContent = text; if (cls) node.className = cls; return node; };
const statuses = { unverified: "Not tested", needs_auth: "Sign-in required", connected: "Connected", error: "Connection failed", worker_pending: "Verified when the worker starts" };
export class McpSettings {
  constructor({ api, toast, state }) {
    Object.assign(this, { api, toast, state });
    $("#mcps-button").onclick = () => this.open(); $("#mcp-close").onclick = () => $("#mcp-dialog").close();
    $("#mcp-new").onclick = () => { this.edit(); $("#mcp-name").focus(); };
    $("#mcp-type").onchange = () => this.transport(); $("#mcp-auth").onchange = () => this.transport();
    $("#mcp-form").oninput = $("#mcp-form").onchange = () => { this.dirty = true; this.actions(); };
    $("#mcp-form").onsubmit = event => this.save(event);
    for (const action of ["delete", "test", "disconnect"]) $("#mcp-" + action).onclick = () => this.action(action);
    $("#mcp-connect").onclick = () => this.connect();
    $("#mcp-dialog").addEventListener("close", () => { $("#mcp-headers").value = ""; $("#mcp-client-secret").value = ""; this.current = null; clearTimeout(this.oauthTimer); this.pendingOAuth = null; });
    if (location.hash === "#mcp-connections") setTimeout(() => this.open(), 500);
  }
  async load() {
    const [saved, catalog] = await Promise.all([this.api("/api/mcps"), this.api("/api/mcps/presets")]); this.connections = saved.connections;
    $("#mcp-list").replaceChildren(...this.connections.map(connection => {
      const b = el("button", `${connection.organization || "Shared"} · ${connection.name} · ${statuses[connection.health?.status] || "Not tested"}`, "secondary-button"); b.type = "button"; b.onclick = () => this.edit(connection); return b;
    }));
    if (!this.connections.length) $("#mcp-list").append(el("p", "No connections yet. Choose a preset or add a custom MCP.", "muted"));
    const organizations = [...this.connections.map(c => c.organization), ...(this.state?.chats || []).map(chat => { const group = repositoryGroup(chat); return group.fullName ? group.company.toLowerCase() : null; })];
    $("#mcp-organizations").replaceChildren(...[...new Set(organizations.filter(Boolean))].sort().map(org => { const option = el("option", org); option.value = org; return option; }));
    $("#mcp-presets").replaceChildren(...catalog.presets.map(preset => {
      const button = el("button", "", "mcp-preset"); button.type = "button"; button.append(el("strong", preset.name), el("span", preset.description, "muted"));
      button.onclick = () => { this.edit({ name: preset.id, type: "http", url: preset.url, authMode: preset.authMode }); $("#mcp-catalog").open = false; $("#mcp-name").focus(); }; return button;
    }));
  }
  async open() { try { await this.load(); this.edit(this.connections[0]); $("#mcp-dialog").showModal(); } catch (error) { this.toast(error.message); } }
  edit(connection = null) {
    this.current = connection?.id ? connection : null; this.dirty = false;
    $("#mcp-error").textContent = ""; $("#mcp-save-status").textContent = "";
    $("#mcp-name").value = connection?.name || ""; $("#mcp-type").value = connection?.type || "http";
    $("#mcp-organization").value = connection?.organization || "";
    $("#mcp-url").value = connection?.url || ""; $("#mcp-headers").value = ""; $("#mcp-auth").value = connection?.authMode || "oauth";
    $("#mcp-headers").placeholder = connection?.hasCredentials ? `Saved: ${connection.headerNames.join(", ")} · leave blank to keep` : '{"Authorization":"Bearer …"}';
    $("#mcp-client-id").value = connection?.oauthClientId || ""; $("#mcp-scopes").value = connection?.oauthScopes || "";
    $("#mcp-client-secret").value = ""; $("#mcp-client-secret").placeholder = connection?.hasClientSecret ? "Saved · leave blank to keep" : "Usually not needed";
    $("#mcp-callback-url").textContent = `${location.origin}/oauth/mcp/callback`;
    $("#mcp-command").value = connection?.command || ""; $("#mcp-args").value = JSON.stringify(connection?.args || []);
    $("#mcp-delete").hidden = !this.current; this.transport(); this.renderStatus();
  }
  renderStatus() {
    const section = $("#mcp-connection-status"); section.replaceChildren(); if (!this.current) return;
    const health = this.current.health || {};
    section.append(el("p", `${statuses[health.status] || "Not tested"}${health.toolCount === undefined ? "" : ` · ${health.toolCount} tools`}${this.current.oauthConnected ? " · OAuth signed in" : ""}`));
    if (health.message) section.append(el("p", health.message, "muted"));
    if (health.checkedAt) section.append(el("p", `Last checked ${new Date(health.checkedAt).toLocaleString()}`, "muted"));
    if (health.tools?.length) {
      const details = document.createElement("details"); details.append(el("summary", "Available tools")); const list = el("ul", "", "mcp-tool-list");
      for (const tool of health.tools) { const item = el("li", ""); item.append(el("strong", tool.name), el("p", tool.description, "muted")); list.append(item); } details.append(list); section.append(details);
    }
  }
  actions() {
    const http = this.current?.type === "http", oauth = this.current?.authMode === "oauth";
    $("#mcp-connect").hidden = !http || !oauth; $("#mcp-test").hidden = !http; $("#mcp-disconnect").hidden = !http || !this.current?.oauthConnected;
    for (const id of ["mcp-connect", "mcp-test", "mcp-disconnect"]) { $("#" + id).disabled = Boolean(this.dirty || this.busy); $("#" + id).title = this.dirty ? "Save your changes first" : ""; }
  }
  transport() {
    const http = $("#mcp-type").value === "http", auth = $("#mcp-auth").value;
    $("#mcp-http").hidden = !http; $("#mcp-stdio").hidden = http; $("#mcp-url").required = http; $("#mcp-command").required = !http;
    $("#mcp-header-fields").hidden = auth !== "headers"; $("#mcp-oauth-fields").hidden = auth !== "oauth"; this.actions();
  }
  async save(event) {
    event.preventDefault(); event.submitter.disabled = true; $("#mcp-error").textContent = "";
    try {
      const type = $("#mcp-type").value, headers = $("#mcp-headers").value.trim(), secret = $("#mcp-client-secret").value;
      const data = { name: $("#mcp-name").value, organization: $("#mcp-organization").value, type, revision: this.current?.revision,
        ...(type === "http" ? { url: $("#mcp-url").value, authMode: $("#mcp-auth").value, oauthClientId: $("#mcp-client-id").value, oauthScopes: $("#mcp-scopes").value, ...(secret ? { oauthClientSecret: secret } : {}), ...(headers ? { headers: JSON.parse(headers) } : {}) } : { command: $("#mcp-command").value, args: JSON.parse($("#mcp-args").value || "[]") }) };
      const { connection } = await this.api(this.current ? `/api/mcps/${this.current.id}` : "/api/mcps", { method: this.current ? "PATCH" : "POST", body: JSON.stringify(data) });
      await this.load(); this.edit(connection); $("#mcp-save-status").textContent = "Saved. Connect or test, then select this MCP in an environment. It applies on the next worker start.";
    } catch (error) { $("#mcp-error").textContent = error.message; } finally { event.submitter.disabled = false; }
  }
  async action(action) {
    if (!this.current || this.busy) return;
    if (action === "delete" && !confirm(`Delete MCP connection “${this.current.name}”?`)) return;
    if (action === "disconnect" && !confirm("Remove OAuth tokens and block existing workers from using this connection? You can also revoke Agent Relay in the provider’s account settings.")) return;
    this.busy = true; this.actions(); const id = this.current.id;
    $("#mcp-error").textContent = ""; $("#mcp-save-status").textContent = action === "test" ? "Connecting and discovering tools…" : "Updating connection…";
    try {
      const result = await this.api(`/api/mcps/${id}${action === "delete" ? "" : `/${action}`}`, { method: action === "delete" ? "DELETE" : "POST" });
      await this.load(); if (this.current?.id === id && !this.dirty) this.edit(result.connection);
    } catch (error) { $("#mcp-error").textContent = error.message; } finally { this.busy = false; this.actions(); }
  }
  async connect() {
    if (!this.current || this.dirty || this.busy) return;
    this.popup = window.open("about:blank", "relay-mcp-oauth", "popup,width=620,height=760");
    if (!this.popup) { $("#mcp-error").textContent = "Allow pop-ups for this app to sign in with OAuth, then try again."; return; }
    this.popup.document.body.textContent = "Preparing secure MCP sign-in…";
    // The custom authorization site must not be able to navigate the app via
    // window.opener. Poll our authenticated API instead of trusting popup data.
    this.popup.opener = null;
    this.oauthId = this.current.id; this.busy = true; this.actions(); $("#mcp-error").textContent = "";
    try {
      const { authorizationUrl } = await this.api(`/api/mcps/${this.oauthId}/oauth`, { method: "POST" });
      this.popup.location.replace(authorizationUrl); $("#mcp-save-status").textContent = "Complete sign-in in the opened window. No permissions are granted until you approve.";
      clearTimeout(this.oauthTimer); this.pendingOAuth = { id: this.oauthId, revision: this.current.revision, expires: Date.now() + 600000 }; this.oauthTimer = setTimeout(() => this.pollOAuth(), 1000);
    } catch (error) { this.popup?.close(); this.popup = null; $("#mcp-error").textContent = error.message; }
    finally { this.busy = false; this.actions(); }
  }
  async pollOAuth() {
    const pending = this.pendingOAuth; if (!pending) return;
    try {
      const { connections } = await this.api("/api/mcps");
      if (this.pendingOAuth !== pending) return;
      const connection = connections.find(c => c.id === pending.id);
      if (connection?.oauthConnected && connection.revision > pending.revision) {
        this.pendingOAuth = null; await this.load();
        if (this.current?.id === pending.id && !this.dirty) { this.edit(connection); await this.action("test"); }
        else this.toast("MCP signed in. Open its connection to test tools.");
        return;
      }
    } catch { /* A transient network failure must not cancel browser consent. */ }
    if (this.pendingOAuth !== pending) return;
    if (Date.now() >= pending.expires) { this.pendingOAuth = null; $("#mcp-error").textContent = "Sign-in timed out. Start again from Connect with OAuth."; return; }
    this.oauthTimer = setTimeout(() => this.pollOAuth(), 2000);
  }
}
