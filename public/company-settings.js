import { companyForChat } from "./company-scope.js";
import { environmentAllows } from "./environment-scope.js";
const $ = selector => document.querySelector(selector);
const node = (tag, text, className) => { const result = document.createElement(tag); result.textContent = text; if (className) result.className = className; return result; };

// A single company context for all connection editors. Existing editors retain
// their secret handling, OAuth lifecycle and explicit browser-sharing consent.
export class CompanySettings {
  constructor({ api, state, workspace, mcps, browsers, plugins }) {
    Object.assign(this, { api, state, workspace, mcps, browsers, plugins });
    this.dialog = document.createElement("dialog"); this.dialog.id = "company-settings-dialog"; this.dialog.setAttribute("aria-labelledby", "company-settings-title");
    this.dialog.innerHTML = `<div class="dialog-card company-settings-card">
      <div class="dialog-heading"><h2 id="company-settings-title">Settings</h2><button type="button" class="icon-button" aria-label="Close settings">×</button></div>
      <div class="company-settings-tabs" role="tablist" aria-label="Companies"></div>
      <p class="form-error" role="alert"></p><button type="button" class="secondary-button" id="settings-retry" hidden>Retry loading settings</button>
      <section id="company-settings-panel" role="tabpanel"><div class="company-settings-grid"></div><button type="button" class="secondary-button" id="settings-edit-company">Edit company</button></section>
      <form id="settings-company-form" hidden><h3>Add company</h3><label><span>Company name</span><input name="name" required maxlength="80" autocomplete="organization"></label><label><span>Company identifier</span><input name="id" required maxlength="39" pattern="[a-z0-9][a-z0-9-]*" placeholder="e.g. g2i"></label><div class="dialog-actions"><button type="button" class="secondary-button" id="settings-company-cancel">Cancel</button><button class="primary-button" type="submit">Save company</button></div></form>
    </div>`;
    document.body.append(this.dialog);
    this.tabs = this.dialog.querySelector("[role=tablist]"); this.panel = $("#company-settings-panel"); this.form = $("#settings-company-form");
    this.dialog.querySelector("[aria-label='Close settings']").onclick = () => { if (this.discard()) this.dialog.close(); };
    this.dialog.addEventListener("cancel", event => { if (!this.discard()) event.preventDefault(); });
    this.dialog.addEventListener("close", () => { this.loadRevision++; this.navigationRevision = (this.navigationRevision || 0) + 1; this.form.hidden = true; });
    $("#settings-retry").onclick = () => this.load();
    $("#company-settings-button").onclick = () => this.open();
    $("#settings-edit-company").onclick = () => this.edit(this.companies.find(item => item.id === this.companyId));
    $("#settings-company-cancel").onclick = () => { if (this.discard()) { this.form.hidden = true; this.panel.hidden = !this.companyId; } };
    this.form.onsubmit = event => this.save(event);
    this.form.oninput = () => this.updateSave();
    this.tabs.onkeydown = event => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      const tabs = [...this.tabs.querySelectorAll("[role=tab]")], index = tabs.indexOf(document.activeElement);
      if (index < 0) return; event.preventDefault();
      const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
      const id = tabs[next].id; tabs[next].click(); this.tabs.querySelector(`[id="${id}"]`)?.focus();
    };
    for (const id of ["mcp-dialog", "github-dialog", "environments-dialog", "browser-connections-dialog", "company-plugins-dialog"]) $("#" + id).addEventListener("close", () => {
      if (this.dialog.open) void this.load();
    });
  }
  error(message = "") { this.dialog.querySelector("[role=alert]").textContent = message; }
  async open() { this.error(); if (this.dialog.open) return; this.dialog.showModal(); await this.load(); }
  async load() {
    const revision = this.loadRevision = (this.loadRevision || 0) + 1;
    this.loading = true; this.error(); $("#settings-retry").hidden = true; this.lock();
    try {
      const [{ companies }, github, { connections: mcps }, environments, { connections: browsers }, { marketplaces }] = await Promise.all([
        this.api("/api/companies"), this.api("/api/github"), this.api("/api/mcps"), this.api("/api/environments"), this.api("/api/browser-connections"), this.api("/api/company-plugins"),
      ]);
      if (revision !== this.loadRevision) return;
      Object.assign(this, { companies, github: github.connections, connections: mcps, environments: environments.environments, connectionsBrowser: browsers, marketplaces }); this.state.companies = companies;
      if (!companies.some(company => company.id === this.companyId)) this.companyId = companies.find(company => company.id === companyForChat(this.state.active || {}))?.id || companies[0]?.id || "";
      this.render();
    } catch (error) { if (revision === this.loadRevision) { this.error(error.message); $("#settings-retry").hidden = false; } }
    finally { if (revision === this.loadRevision) { this.loading = false; this.lock(!$("#settings-retry").hidden); } }
  }
  lock(failed = false) { for (const control of this.dialog.querySelectorAll("[role=tablist] button, #company-settings-panel button")) control.disabled = Boolean(this.loading || this.saving || failed); }
  dirty() { return !this.form.hidden && (this.form.elements.name.value !== (this.editing?.name || "") || this.form.elements.id.value !== (this.editing?.id || "")); }
  discard() { return !this.saving && (!this.dirty() || confirm("Discard the unsaved company details?")); }
  updateSave() { this.form.querySelector("[type=submit]").disabled = Boolean(this.saving) || !this.dirty(); }
  select(id) {
    if (!this.discard()) return;
    this.navigationRevision = (this.navigationRevision || 0) + 1;
    this.companyId = id; this.form.hidden = true; this.render();
  }
  render() {
    this.tabs.replaceChildren(...this.companies.map(company => {
      const button = node("button", company.name, "secondary-button"); button.type = "button";
      button.id = `settings-tab-${company.id}`; button.setAttribute("role", "tab"); button.setAttribute("aria-controls", this.panel.id); button.setAttribute("aria-selected", String(company.id === this.companyId)); button.tabIndex = company.id === this.companyId ? 0 : -1;
      button.onclick = () => this.select(company.id); return button;
    }));
    const add = node("button", "+ Add company", "secondary-button"); add.type = "button"; add.onclick = () => this.edit(); this.tabs.append(add);
    this.panel.hidden = !this.companyId || !this.form.hidden;
    this.panel.setAttribute("aria-labelledby", `settings-tab-${this.companyId}`);
    const github = this.github.find(item => item.companyId === this.companyId), mcps = this.connections.filter(item => item.companyId === this.companyId), environments = this.environments.filter(item => environmentAllows(item, this.companyId)), browsers = this.connectionsBrowser.filter(item => item.companyId === this.companyId);
    const plugins = this.marketplaces.filter(item => item.companyId === this.companyId), pluginCount = provider => plugins.reduce((total, item) => total + item.targets[provider].length, 0);
    const cards = [
      ["GitHub", github?.connected ? `Connected · ${github.login}` : "Connect one GitHub account", () => this.workspace.githubAccounts.open(this.companyId)],
      ["MCP connections", mcps.length ? mcps.map(item => item.name).join(" · ") : "Connect your company's tools", () => { const revision = this.navigationRevision = (this.navigationRevision || 0) + 1; return this.mcps.open(this.companyId, { validWhile: () => this.dialog.open && this.navigationRevision === revision }); }],
      ["Environments", environments.length ? environments.map(item => item.name).join(" · ") : "Add an environment", () => { const revision = this.navigationRevision = (this.navigationRevision || 0) + 1; return this.workspace.openEnvironments(undefined, this.companyId, { validWhile: () => this.dialog.open && this.navigationRevision === revision }); }],
      ["Browser connections", browsers.length ? browsers.map(item => item.name).join(" · ") : "Pair a Chrome profile", () => this.browsers.open(this.companyId)],
      ["Plugins", plugins.length ? `${pluginCount("claude")} for Claude · ${pluginCount("codex")} for Codex` : "Install Claude and Codex plugins", () => { const revision = this.navigationRevision = (this.navigationRevision || 0) + 1; return this.plugins.open(this.companies.find(item => item.id === this.companyId), { validWhile: () => this.dialog.open && this.navigationRevision === revision }); }],
    ];
    this.panel.querySelector(".company-settings-grid").replaceChildren(...cards.map(([title, summary, action]) => {
      const button = node("button", "", "company-settings-section"); button.type = "button"; button.setAttribute("aria-label", title); button.append(node("strong", title), node("span", summary, "muted")); button.onclick = () => { this.navigationRevision = (this.navigationRevision || 0) + 1; return action(); }; return button;
    }));
    if (!this.companyId && this.form.hidden) this.edit();
  }
  edit(company = null) {
    if (!this.discard()) return;
    this.navigationRevision = (this.navigationRevision || 0) + 1;
    this.editing = company; this.panel.hidden = true; this.form.hidden = false; this.error();
    this.form.querySelector("h3").textContent = company ? "Edit company" : "Add company";
    this.form.elements.name.value = company?.name || ""; this.form.elements.id.value = company?.id || ""; this.form.elements.id.readOnly = Boolean(company); this.form.elements.name.focus();
    this.updateSave();
  }
  async save(event) {
    event.preventDefault(); if (this.saving || !this.dirty()) return;
    this.saving = true; this.error();
    const controls = [...this.form.elements, ...this.tabs.querySelectorAll("button")]; controls.forEach(control => { control.disabled = true; });
    try {
      const input = { name: this.form.elements.name.value, id: this.form.elements.id.value, ...(this.editing ? { revision: this.editing.revision } : {}) };
      await this.api(this.editing ? `/api/companies/${this.editing.id}` : "/api/companies", { method: this.editing ? "PATCH" : "POST", body: JSON.stringify(input) });
      this.companyId = input.id.trim().toLowerCase(); this.form.hidden = true; await this.load(); window.dispatchEvent(new Event("relay-companies-changed"));
    } catch (error) { this.error(error.message); }
    finally { this.saving = false; controls.forEach(control => { control.disabled = false; }); this.updateSave(); this.lock(!$("#settings-retry").hidden); }
  }
}
