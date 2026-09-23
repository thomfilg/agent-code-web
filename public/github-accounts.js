import { companyOptions } from "./companies.js";
import { companyForChat } from "./company-scope.js";
import { companyContext } from "./company-context.js";
const $ = selector => document.querySelector(selector);
const element = (tag, text, cls) => { const node = document.createElement(tag); if (text) node.textContent = text; if (cls) node.className = cls; return node; };
const button = (text, action, cls = "secondary-button") => { const node = element("button", text, cls); node.type = "button"; node.onclick = action; return node; };
const connectedRevision = connections => JSON.stringify(connections.filter(connection => connection.connected).map(connection => [connection.id, connection.revision, connection.login]));

export class GitHubAccounts {
  constructor(settings) {
    this.settings = settings; this.api = settings.api; this.busy = new Set(); this.connections = []; this.refreshRequest = 0;
    $("#github-new").onclick = () => this.openPermissions();
    $("#github-permission-cancel").onclick = () => this.closePermissions();
    $("#github-permission-form").onsubmit = event => { event.preventDefault(); void this.start(this.permissionTarget, ["repositories", ...($("#github-permission-workflows").checked ? ["workflows"] : [])]); };
    window.addEventListener("relay-open-github", event => { void this.open(event.detail?.companyId); });
    $("#github-company-filter").onchange = () => { this.companyId = $("#github-company-filter").value; $("#github-rename-form").hidden = true; this.render(); };
    $("#github-manage-companies").onclick = () => { $("#github-dialog").close(); window.dispatchEvent(new Event("relay-open-companies")); };
    $("#github-rename-cancel").onclick = () => { this.editing = null; $("#github-rename-form").hidden = true; };
    $("#github-rename-form").onsubmit = event => { event.preventDefault(); void this.save(); };
    $("#github-dialog").addEventListener("close", () => { clearTimeout(this.timer); this.refreshRequest++; this.editing = null; $("#github-rename-form").hidden = true; this.closePermissions(); });
    const discard = event => { if (this.editing && ($("#github-connection-name").value !== this.editing.name || $("#github-connection-company").value !== (this.editing.companyId || "")) && !confirm("Discard unsaved GitHub connection changes?")) { event.preventDefault(); event.stopImmediatePropagation(); } };
    $("#github-dialog").addEventListener("cancel", discard);
    $("#github-dialog [data-close-dialog]").addEventListener("click", discard, true);
  }
  async open(companyId = null) {
    this.editing = null; $("#github-rename-form").hidden = true; this.closePermissions();
    if (companyId) this.companyId = companyId;
    $("#github-dialog").dataset.companyScoped = String(Boolean(companyId));
    $("#github-error").textContent = "";
    $("#github-account-list").replaceChildren(element("p", "Loading GitHub connection…", "muted")); $("#github-new").disabled = true;
    if (!$("#github-dialog").open) $("#github-dialog").showModal();
    await this.refresh();
  }
  async refresh({ updateWorkspace = false } = {}) {
    clearTimeout(this.timer); const request = ++this.refreshRequest;
    try {
      const [data, { companies }] = await Promise.all([this.api("/api/github"), this.api("/api/companies")]);
      if (request !== this.refreshRequest) return;
      this.companies = companies; this.settings.state.companies = companies;
      if ($("#github-dialog").dataset.companyScoped === "true" && !companies.some(company => company.id === this.companyId)) throw new Error("This company is no longer available. Return to Settings and choose a company.");
      if (!companies.some(company => company.id === this.companyId)) this.companyId = companies.find(company => company.id === companyForChat(this.settings.state.active || {}))?.id || companies[0]?.id || "";
      companyOptions($("#github-company-filter"), companies, this.companyId);
      companyContext($("#github-dialog"), companies, this.companyId);
      const previous = this.connections;
      this.connections = data.connections; this.settings.github = data;
      this.render();
      if (this.permissionTarget && !this.connections.some(connection => connection.id === this.permissionTarget.id)) this.closePermissions();
      if (this.editing && !this.connections.some(connection => connection.id === this.editing.id)) {
        this.editing = null; $("#github-rename-form").hidden = true;
      }
      if (updateWorkspace || connectedRevision(previous) !== connectedRevision(this.connections)) {
        this.settings.branchCache.clear(); const loaded = await this.settings.load({ validWhile: () => request === this.refreshRequest });
        if (loaded && request === this.refreshRequest && !$("#new-chat-page").hidden) await this.settings.loadRepositories();
      }
      if (request === this.refreshRequest && this.connections.some(connection => connection.signIn) && $("#github-dialog").open) this.timer = setTimeout(() => this.refresh(), 1500);
    } catch (error) { if (request === this.refreshRequest) { $("#github-error").textContent = error.message; if ($("#github-dialog").open) this.timer = setTimeout(() => this.refresh(), 3000); } }
  }
  render() {
    const root = $("#github-account-list"); root.replaceChildren();
    for (const connection of this.connections) {
      if (connection.companyId && connection.companyId !== this.companyId) continue;
      const card = element("section", "", "agent-account-card"); card.dataset.connectionId = connection.id;
      card.append(element("h3", connection.name), element("p", connection.signIn ? (connection.signIn.state === "starting" ? "Connecting to GitHub…" : "Waiting for your GitHub authorization…") : connection.connected ? `Signed in as ${connection.login}` : "Not connected", "muted"));
      const permissions = connection.signIn?.permissions || (connection.permissionsVerified ? connection.grantedPermissions : connection.requestedPermissions) || ["repositories"];
      card.append(element("p", `${connection.permissionsVerified ? "Granted" : "Requested"}: repositories${permissions.includes("workflows") ? " · workflows" : ""}`, "github-permission-summary"));
      if (!connection.companyId) card.append(element("p", "Assign this connection to one company before using it in chats. No new GitHub sign-in is needed.", "form-error"));
      else card.append(element("p", `Company: ${this.companies.find(company => company.id === connection.companyId)?.name || connection.companyId}`, "muted"));
      if (connection.error && !connection.signIn) card.append(element("p", connection.error, "form-error"));
      if (connection.signIn?.userCode) {
        const code = element("code", connection.signIn.userCode), link = element("a", "Open GitHub sign-in", "primary-button");
        link.href = "https://github.com/login/device"; link.target = "_blank"; link.rel = "noopener noreferrer";
        const copy = button("Copy code", async () => { try { await navigator.clipboard.writeText(connection.signIn.userCode); copy.textContent = "Copied"; } catch { $("#github-error").textContent = "Copy the code shown above and paste it on GitHub."; } });
        const device = element("div", "", "device-code"); device.append(code, link, copy);
        card.append(element("p", "Enter this one-time code on GitHub. Keep it private.", "muted"), device);
      }
      const actions = element("div", "", "dialog-actions");
      if (connection.signIn) actions.append(button("Cancel sign-in", () => this.action(connection.id, () => this.api("/api/github/device/cancel", { method: "POST", body: JSON.stringify({ id: connection.signIn.id }) }))));
      else {
        actions.append(button(connection.connected ? "Change permissions" : "Reconnect", () => this.openPermissions(connection)));
        actions.append(button(connection.companyId ? "Edit" : "Assign company", () => this.edit(connection)));
        actions.append(button("Disconnect", () => {
          if (confirm(`Disconnect “${connection.name}” from Relay? Its conversations will remain saved.`)) void this.action(connection.id, () => this.api(`/api/github/connections/${connection.id}`, { method: "DELETE" }));
        }));
      }
      for (const action of actions.children) action.disabled = this.busy.has(connection.id);
      card.append(actions); root.append(card);
    }
    const assigned = this.connections.some(connection => connection.companyId === this.companyId);
    if (!root.children.length) root.append(element("p", this.companyId ? "No GitHub account connected for this company." : "Add a company first.", "muted"));
    $("#github-new").disabled = this.busy.has("new") || !this.companyId || assigned;
    $("#github-new").textContent = this.busy.has("new") ? "Connecting to GitHub…" : assigned ? "One GitHub connection per company" : "Connect GitHub";
  }
  async action(id, callback) {
    if (this.busy.has(id)) return;
    this.busy.add(id); this.render(); $("#github-error").textContent = "";
    try { await callback(); }
    catch (error) { $("#github-error").textContent = error.message; }
    finally { this.busy.delete(id); await this.refresh({ updateWorkspace: true }); }
  }
  openPermissions(connection = null) {
    if (connection && !connection.companyId) { this.edit(connection); return; }
    this.editing = null; $("#github-rename-form").hidden = true; this.permissionTarget = connection;
    const permissions = connection?.requestedPermissions || connection?.grantedPermissions || ["repositories"];
    $("#github-permission-title").textContent = connection ? `Permissions for ${connection.login || connection.name}` : "Choose GitHub permissions";
    $("#github-permission-workflows").checked = permissions.includes("workflows");
    $("#github-permission-form").hidden = false;
    $("#github-permission-workflows").focus();
  }
  closePermissions() { this.permissionTarget = null; $("#github-permission-form").hidden = true; }
  async start(connection, permissions) {
    if (connection && !connection.companyId) { this.edit(connection); return; }
    await this.action(connection?.id || "new", async () => {
      const result = await this.api("/api/github/device", { method: "POST", body: JSON.stringify(connection ? { id: connection.id, revision: connection.revision, companyId: connection.companyId, permissions } : { companyId: this.companyId, permissions }) });
      this.connections = [...this.connections.filter(old => old.id !== result.connection.id), result.connection];
      this.closePermissions(); this.render();
    });
  }
  edit(connection) {
    this.closePermissions(); this.editing = connection;
    $("#github-rename-title").textContent = `${connection.companyId ? "Edit" : "Assign"} ${connection.login || connection.name}`;
    companyOptions($("#github-connection-company"), this.companies.filter(company => !this.connections.some(other => other.id !== connection.id && other.companyId === company.id)), connection.companyId || "");
    $("#github-connection-name").value = connection.name;
    $("#github-rename-form").hidden = false;
    $("#github-connection-name").focus();
  }
  async save() {
    if (!this.editing) return;
    $("#github-save-name").disabled = true; $("#github-error").textContent = "";
    try {
      const companyId = $("#github-connection-company").value;
      if (this.editing.companyId && companyId !== this.editing.companyId && !confirm("Move this GitHub connection to another company? The previous company's chats will lose its GitHub access.")) return;
      await this.api(`/api/github/connections/${this.editing.id}`, { method: "PATCH", body: JSON.stringify({ revision: this.editing.revision, name: $("#github-connection-name").value, companyId }) });
      this.companyId = companyId;
      this.editing = null; $("#github-rename-form").hidden = true;
      await this.refresh({ updateWorkspace: true });
      $("#github-dialog").close();
    } catch (error) { $("#github-error").textContent = error.message; }
    finally { $("#github-save-name").disabled = false; }
  }
}
