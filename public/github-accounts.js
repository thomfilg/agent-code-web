import { CompanyPicker, knownCompanies } from "./company-picker.js";
import { scopeLabel } from "./company-scope.js";
const $ = selector => document.querySelector(selector);
const element = (tag, text, cls) => { const node = document.createElement(tag); if (text) node.textContent = text; if (cls) node.className = cls; return node; };
const button = (text, action, cls = "secondary-button") => { const node = element("button", text, cls); node.type = "button"; node.onclick = action; return node; };

export class GitHubAccounts {
  constructor(settings) {
    this.settings = settings; this.api = settings.api; this.busy = new Set(); this.connections = [];
    this.companies = new CompanyPicker($("#github-companies"), () => {}, { compact: true });
    $("#github-new").onclick = () => this.start();
    $("#github-access-cancel").onclick = () => { this.editing = null; $("#github-access-form").hidden = true; };
    $("#github-access-form").onsubmit = event => { event.preventDefault(); void this.save(); };
    $("#github-dialog").addEventListener("close", () => clearTimeout(this.timer));
  }
  async open() {
    $("#github-error").textContent = "";
    if (!$("#github-dialog").open) $("#github-dialog").showModal();
    await this.refresh();
  }
  async refresh() {
    clearTimeout(this.timer);
    try {
      const data = await this.api("/api/github");
      const previous = this.connections;
      this.connections = data.connections; this.settings.github = data;
      this.render();
      for (const connection of this.connections) if (connection.connected && previous.find(old => old.id === connection.id)?.signIn && !this.editing) this.edit(connection);
      if (this.connections.some(connection => connection.signIn) && $("#github-dialog").open) this.timer = setTimeout(() => this.refresh(), 1500);
    } catch (error) { $("#github-error").textContent = error.message; if ($("#github-dialog").open) this.timer = setTimeout(() => this.refresh(), 3000); }
  }
  render() {
    const root = $("#github-account-list"); root.replaceChildren();
    for (const connection of this.connections) {
      const card = element("section", "", "agent-account-card"); card.dataset.connectionId = connection.id;
      card.append(element("h3", connection.name), element("p", connection.signIn ? (connection.signIn.state === "starting" ? "Connecting to GitHub…" : "Waiting for your GitHub authorization…") : connection.connected ? `Signed in as ${connection.login}` : "Not connected", "muted"));
      if (connection.connected) card.append(element("p", scopeLabel(connection), "muted"));
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
        if (!connection.connected) actions.append(button("Reconnect", () => this.start(connection)));
        if (connection.connected) actions.append(button("Company access", () => this.edit(connection)));
        actions.append(button("Disconnect", () => {
          if (confirm(`Disconnect “${connection.name}” from Relay? Its conversations will remain saved.`)) void this.action(connection.id, () => this.api(`/api/github/connections/${connection.id}`, { method: "DELETE" }));
        }));
      }
      for (const action of actions.children) action.disabled = this.busy.has(connection.id);
      card.append(actions); root.append(card);
    }
    if (!this.connections.length) root.append(element("p", "No GitHub accounts connected.", "muted"));
    $("#github-new").disabled = this.busy.has("new");
    $("#github-new").textContent = this.busy.has("new") ? "Connecting to GitHub…" : "＋ Add GitHub connection";
  }
  async action(id, callback) {
    if (this.busy.has(id)) return;
    this.busy.add(id); this.render(); $("#github-error").textContent = "";
    try { await callback(); this.settings.repositories = []; this.settings.branchCache.clear(); await this.settings.load(); }
    catch (error) { $("#github-error").textContent = error.message; }
    finally { this.busy.delete(id); await this.refresh(); }
  }
  async start(connection) {
    await this.action(connection?.id || "new", async () => {
      this.settings.requireCompanyScopes();
      const result = await this.api("/api/github/device", { method: "POST", body: JSON.stringify(connection ? { id: connection.id, revision: connection.revision } : {}) });
      this.connections = [...this.connections.filter(old => old.id !== result.connection.id), result.connection];
      this.render();
    });
  }
  edit(connection) {
    this.editing = connection;
    $("#github-access-title").textContent = `Access for ${connection.login || connection.name}`;
    $("#github-connection-name").value = connection.name;
    this.companies.set(connection, knownCompanies(this.settings.state, [...this.connections, ...this.settings.environments, ...(this.settings.mcps || [])]));
    $("#github-access-form").hidden = false;
    $("#github-connection-name").focus();
  }
  async save() {
    if (!this.editing) return;
    $("#github-save-scope").disabled = true; $("#github-error").textContent = "";
    try {
      this.settings.requireCompanyScopes();
      await this.api(`/api/github/connections/${this.editing.id}`, { method: "PATCH", body: JSON.stringify({ revision: this.editing.revision, name: $("#github-connection-name").value, ...this.companies.value() }) });
      this.editing = null; $("#github-access-form").hidden = true;
      this.settings.branchCache.clear(); await this.settings.load();
      if ($("#new-chat-dialog").open) await this.settings.loadRepositories();
      $("#github-dialog").close();
    } catch (error) { $("#github-error").textContent = error.message; }
    finally { $("#github-save-scope").disabled = false; }
  }
}
