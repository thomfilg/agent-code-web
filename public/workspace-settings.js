import { ModelPicker } from "./model-picker.js";
import { companyForChat, scopeAllows, scopeLabel, scopesOverlap } from "./company-scope.js";
import { CompanyPicker, knownCompanies } from "./company-picker.js";
const $ = selector => document.querySelector(selector);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
const option = (value, text) => { const e = el("option", "", text); e.value = value; return e; };
const button = (text, action, cls = "secondary-button") => { const e = el("button", cls, text); e.type = "button"; e.addEventListener("click", action); return e; };

export class WorkspaceSettings {
  constructor({ api, state, toast }) {
    Object.assign(this, { api, state, toast }); this.selected = []; this.environments = []; this.repositories = []; this.branchCache = new Map();
    this.environmentCompanies = new CompanyPicker($("#environment-companies"), scope => { Object.assign(this.draft, scope); this.renderEnvironmentMcps(); });
    this.githubCompanies = new CompanyPicker($("#github-companies"));
    $("#github-connections").onchange = event => this.editGitHub(this.github.connections.find(connection => connection.id === event.target.value));
    $("#github-new").onclick = () => this.editGitHub(null);
    $("#github-save-scope").onclick = event => this.connectGitHub({}, event.target);
    this.modelPicker = new ModelPicker({ root: $("#new-model-controls"), api, onChange: () => this.remember() });
    $("#github-button").addEventListener("click", () => this.openGitHub());
    $("#connect-github-button").addEventListener("click", () => this.openGitHub());
    $("#github-local").addEventListener("click", event => this.connectGitHub({ method: "local" }, event.target));
    $("#github-token-form").addEventListener("submit", event => { event.preventDefault(); this.connectGitHub({ token: $("#github-token").value, expiresAt: $("#github-expiry").value || null }, event.submitter); });
    $("#github-disconnect").addEventListener("click", async () => { try { this.requireCompanyScopes(); if (!this.editingGitHub?.id || !confirm(`Disconnect only “${this.editingGitHub.name}”? Its other company connections will remain saved.`)) return; await api(`/api/github/connections/${this.editingGitHub.id}`, { method: "DELETE" }); this.repositories = []; this.branchCache.clear(); await this.load(); await this.openGitHub(); } catch (error) { toast(error.message); } });
    $("#github-oauth").addEventListener("click", () => this.startDevice());
    $("#github-dialog").addEventListener("close", () => { clearTimeout(this.deviceTimer); $("#github-token").value = ""; });
    $("#repo-search").addEventListener("input", () => this.renderRepositories());
    $("#refresh-repositories").addEventListener("click", () => this.loadRepositories(true).catch(error => toast(error.message)));
    $("#environment-select").addEventListener("change", () => this.remember());
    $("#agent-select").addEventListener("change", async () => { await this.modelPicker.setAgent($("#agent-select").value, {}, { useDefaults: true }); this.remember(); });
    $("#environment-settings").addEventListener("click", () => this.openEnvironments($("#environment-select").value));
    $("#environments-button").addEventListener("click", () => this.openEnvironments());
    $("#add-environment").addEventListener("click", () => this.editEnvironment(null));
    $("#environment-form").addEventListener("submit", event => this.saveEnvironment(event));
    $("#delete-environment").addEventListener("click", () => this.deleteEnvironment());
    $("#variable-search").addEventListener("input", () => this.filterVariables());
    $("#add-variable").addEventListener("click", () => { this.draft.variables.push({ key: "", value: "", secret: true, enabled: true }); this.renderVariables(); $("#variables-table-body tr:last-child input").focus(); });
    $("#environments-dialog").addEventListener("close", () => { this.draft = null; $("#variables-table-body").replaceChildren(); });
  }
  async load() {
    const [github, environments, saved, mcps] = await Promise.all([this.api("/api/github"), this.api("/api/environments"), this.api("/api/preferences"), this.api("/api/mcps")]);
    this.mcps = mcps.connections;
    this.github = github; this.environments = environments.environments; this.software = environments.software;
    this.preferences = saved.preferences;
    if (!$("#new-chat-dialog").open) this.selected = structuredClone(saved.preferences.repositories || []);
    $("#github-button").textContent = github.connected ? `GitHub · ${github.login}` : "Connect GitHub";
    $("#github-requirement").hidden = github.connected;
    $("#repository-picker").hidden = !github.connected;
    $("#create-chat-button").disabled = !github.connected;
    this.renderEnvironments();
  }
  renderEnvironments() {
    const selected = $("#environment-select").value || this.preferences?.environmentId;
    const company = companyForChat({ repositories: this.selected });
    const available = this.environments.filter(env => !env.archived && scopeAllows(env, company));
    $("#environment-select").replaceChildren(...available.map(env => option(env.id, env.name)));
    if (available.some(env => env.id === selected)) $("#environment-select").value = selected;
    if (!available.length) $("#environment-select").append(option("", `No environment for ${company || "unassigned chats"} · configure companies`));
  }
  async openNew() {
    $("#create-chat-error").textContent = "";
    await this.load();
    this.selected = structuredClone(this.preferences.repositories || []);
    if (this.preferences.agent && [...$("#agent-select").options].some(o => o.value === this.preferences.agent)) $("#agent-select").value = this.preferences.agent;
    this.modelPicker.key = null;
    await this.modelPicker.setAgent($("#agent-select").value, this.preferences, { useDefaults: true });
    $("#repo-search").value = "";
    this.renderSelected();
    if (this.github.connected) await this.loadRepositories();
  }
  async loadRepositories(refresh = false) {
    $("#repository-results").replaceChildren(el("p", "muted", "Loading repositories…"));
    this.repositories = (await this.api(`/api/github/repositories${refresh ? "?refresh=1" : ""}`)).repositories;
    this.renderRepositories();
  }
  renderRepositories() {
    const query = $("#repo-search").value.toLowerCase();
    const results = $("#repository-results"); results.replaceChildren();
    for (const repo of this.repositories.filter(repo => repo.fullName.toLowerCase().includes(query))) {
      const label = el("label", "repository-option"); const input = el("input"); input.type = "checkbox"; input.checked = this.selected.some(item => item.fullName === repo.fullName && (!item.githubConnectionId || item.githubConnectionId === repo.githubConnectionId));
      input.addEventListener("change", () => {
        if (input.checked) { this.selected = this.selected.filter(item => item.fullName !== repo.fullName); this.selected.push({ fullName: repo.fullName, branch: repo.defaultBranch, githubConnectionId: repo.githubConnectionId }); }
        else this.selected = this.selected.filter(item => item.fullName !== repo.fullName);
        this.renderSelected(); this.renderRepositories(); this.remember();
      });
      label.append(input, el("span", "", repo.fullName), el("small", "", `${repo.private ? "Private" : "Public"}${repo.connectionName ? ` · ${repo.connectionName}` : ""}`)); results.append(label);
    }
    if (!results.childElementCount) results.append(el("p", "muted", "No matching repositories. Check account permissions or refresh the list."));
  }
  renderSelected() {
    this.renderEnvironments();
    const container = $("#selected-repositories"); container.replaceChildren();
    for (const [index, repo] of this.selected.entries()) {
      const chip = el("div", "repository-chip"); chip.append(el("span", "", `${index === 0 ? "① " : ""}${repo.fullName}`));
      const branch = el("select"); branch.setAttribute("aria-label", `Branch for ${repo.fullName}`); branch.append(option(repo.branch, repo.branch));
      const loadBranches = async () => {
        try {
          const key = `${repo.githubConnectionId || "auto"}:${repo.fullName}`;
          const branches = this.branchCache.get(key) || (await this.api(`/api/github/branches?repository=${encodeURIComponent(repo.fullName)}${repo.githubConnectionId ? `&connection=${encodeURIComponent(repo.githubConnectionId)}` : ""}`)).branches;
          this.branchCache.set(key, branches);
          branch.replaceChildren(...[...new Set([repo.branch, ...branches])].map(name => option(name, name))); branch.value = repo.branch;
        } catch (error) { this.toast(error.message); }
      };
      branch.addEventListener("focus", loadBranches, { once: true });
      branch.addEventListener("change", () => { repo.branch = branch.value; this.remember(); }); chip.append(branch);
      if (index) { const primary = button("↑", () => { this.selected.splice(index, 1); this.selected.unshift(repo); this.renderSelected(); this.remember(); }, "small-icon"); primary.setAttribute("aria-label", `Make ${repo.fullName} primary`); chip.append(primary); }
      const remove = button("×", () => { this.selected = this.selected.filter(item => item !== repo); this.renderSelected(); this.renderRepositories(); this.remember(); }, "small-icon"); remove.setAttribute("aria-label", `Remove ${repo.fullName}`); chip.append(remove); container.append(chip);
    }
    $("#repository-group-hint").textContent = this.selected.length ? `Grouped under ${this.selected[0].fullName.replace("/", " → ")}. Use ↑ to choose another primary repository.` : "Select repositories. The first one determines the company and repository group.";
  }
  payload() { if (!this.github?.connected) throw new Error("Connect GitHub first"); if (!this.selected.length) throw new Error("Select at least one repository"); return { agent: $("#agent-select").value, ...this.modelPicker.value(), environmentId: $("#environment-select").value, repositories: this.selected }; }
  async remember() {
    if (!$("#environment-select").value) return;
    const selection = $("#new-chat-dialog").open ? { agent: $("#agent-select").value, ...this.modelPicker.value() } : { agent: this.preferences.agent || $("#agent-select").value, model: this.preferences.model || null, effort: this.preferences.effort || null };
    const body = { ...selection, environmentId: $("#environment-select").value, repositories: structuredClone(this.selected) };
    this.preferenceQueue = (this.preferenceQueue || Promise.resolve()).catch(() => {}).then(() => this.api("/api/preferences", { method: "PATCH", body: JSON.stringify(body) }));
    try { await this.preferenceQueue; this.preferences = body; } catch (error) { this.toast(`Could not remember your selection: ${error.message}`); }
  }
  async openGitHub() {
    try {
      this.github = await this.api("/api/github");
      $("#github-connections").replaceChildren(option("", "New connection"), ...(this.github.connections || []).map(connection => option(connection.id, `${connection.name} · ${scopeLabel(connection)}`)));
      this.editGitHub(this.github.connections?.find(connection => connection.id === this.editingGitHub?.id) || this.github.connections?.[0]);
      $("#github-local").hidden = !this.github.localAvailable; $("#github-oauth").hidden = !this.github.oauthAvailable;
      $("#github-error").textContent = ""; $("#github-device-code").textContent = "";
      if (!$("#github-dialog").open) $("#github-dialog").showModal();
    } catch (error) { this.toast(error.message); }
  }
  editGitHub(connection) {
    this.editingGitHub = connection || null; $("#github-connections").value = connection?.id || "";
    $("#github-connection-name").value = connection?.name || "";
    this.githubCompanies.set(connection || {}, knownCompanies(this.state, [...(this.github.connections || []), ...this.environments, ...(this.mcps || [])]));
    $("#github-status").textContent = connection ? `${connection.connected ? `Signed in as ${connection.login}` : "Sign-in expired or disconnected"} · ${scopeLabel(connection)}${connection.scopeNeedsReview ? ". This legacy connection is blocked until you select and save its companies." : ""}` : "Add a separate saved connection for each company account. Credentials stay encrypted outside agent environments.";
    $("#github-disconnect").hidden = !connection;
    $("#github-save-scope").hidden = !connection;
    $("#github-token").value = ""; $("#github-error").textContent = "";
  }
  githubPayload() { return { id: this.editingGitHub?.id, revision: this.editingGitHub?.revision, name: $("#github-connection-name").value || "GitHub", ...this.githubCompanies.value() }; }
  async connectGitHub(body, submitter) {
    submitter.disabled = true; $("#github-error").textContent = "";
    try { this.requireCompanyScopes(); const settings = this.githubPayload(); await this.api(settings.id ? `/api/github/connections/${settings.id}` : "/api/github", { method: settings.id ? "PATCH" : "POST", body: JSON.stringify({ ...settings, ...body }) }); $("#github-token").value = ""; this.branchCache.clear(); await this.load(); if ($("#new-chat-dialog").open) await this.loadRepositories(); $("#github-dialog").close(); }
    catch (error) { $("#github-error").textContent = error.message; }
    finally { submitter.disabled = false; }
  }
  async startDevice() {
    try {
      this.requireCompanyScopes();
      clearTimeout(this.deviceTimer);
      const flow = await this.api("/api/github/device", { method: "POST", body: JSON.stringify(this.githubPayload()) });
      const link = el("a", "", "Open GitHub to authorize"); link.href = "https://github.com/login/device"; link.target = "_blank"; link.rel = "noopener noreferrer";
      $("#github-device-code").replaceChildren(el("strong", "", flow.userCode), link);
      const poll = async () => {
        if (!$("#github-dialog").open) return;
        try { const result = await this.api("/api/github/device/poll", { method: "POST", body: JSON.stringify({ id: flow.id }) });
          if (result.pending) this.deviceTimer = setTimeout(poll, result.interval * 1000);
          else { await this.load(); if ($("#new-chat-dialog").open) await this.loadRepositories(); $("#github-dialog").close(); }
        } catch (error) { $("#github-error").textContent = error.message; }
      };
      this.deviceTimer = setTimeout(poll, flow.interval * 1000);
    } catch (error) { $("#github-error").textContent = error.message; }
  }
  async openEnvironments(id) {
    try { await this.load(); this.editEnvironment(this.environments.find(env => env.id === id) || this.environments[0]); $("#environments-dialog").showModal(); }
    catch (error) { this.toast(error.message); }
  }
  editEnvironment(environment) {
    this.draft = structuredClone(environment || { name: "", backend: this.state.config.workerBackend, variablesEnabled: true, variables: [], software: [] });
    $("#environment-error").textContent = "";
    $("#environment-tabs").replaceChildren(...this.environments.map(env => button(env.name, () => { if (confirm("Switch environments? Unsaved edits will be discarded.")) this.editEnvironment(env); }, `environment-tab${environment?.id === env.id ? " selected" : ""}`)));
    $("#environment-name").value = this.draft.name;
    this.environmentCompanies.set(this.draft, knownCompanies(this.state, [...this.environments, ...this.mcps, ...(this.github.connections || [])]));
    this.renderEnvironmentMcps();
    $("#environment-setup-script").value = this.draft.setupScript || "";
    $("#environment-archived").checked = Boolean(this.draft.archived);
    $("#environment-backend").textContent = `Worker: ${this.draft.backend} · changes apply on the next worker start${this.draft.scopeNeedsReview ? " · select companies to replace the old global scope" : ""}`;
    $("#variables-enabled").checked = this.draft.variablesEnabled;
    $("#delete-environment").hidden = !this.draft.id;
    $("#software-options").replaceChildren();
    for (const pkg of this.software) {
      const label = el("label", "software-option checkbox-label"); const input = el("input"); input.type = "checkbox"; input.checked = this.draft.software.includes(pkg.id);
      input.disabled = Boolean(pkg.backends && !pkg.backends.includes(this.draft.backend));
      input.addEventListener("change", () => { this.draft.software = input.checked ? [...this.draft.software, pkg.id] : this.draft.software.filter(id => id !== pkg.id); });
      label.append(input, el("span", "", `${pkg.name} ${pkg.version}`), el("small", "", pkg.description)); $("#software-options").append(label);
    }
    $("#variable-search").value = ""; this.renderVariables();
  }
  renderEnvironmentMcps() {
    this.draft.mcpIds ||= [];
    $("#environment-mcp-options").replaceChildren(...this.mcps.map(connection => {
      const label = el("label", "checkbox-label"), input = el("input"); input.type = "checkbox"; input.checked = this.draft.mcpIds.includes(connection.id);
      const eligible = scopesOverlap(this.draft, connection); input.disabled = !eligible && !input.checked;
      input.onchange = () => { this.draft.mcpIds = input.checked ? [...this.draft.mcpIds, connection.id] : this.draft.mcpIds.filter(id => id !== connection.id); };
      label.append(input, el("span", "", `${connection.name} · ${connection.type} · ${scopeLabel(connection)}${eligible ? "" : " · excluded by company scope"}`)); return label;
    }));
    if (!this.mcps.length) $("#environment-mcp-options").append(el("p", "muted", "No saved connections. Add an MCP from the sidebar first."));
  }
  renderVariables() {
    const body = $("#variables-table-body"); body.replaceChildren();
    this.draft.variables.forEach((variable, index) => {
      const row = el("tr"); const keyCell = el("td"); const key = el("input"); key.value = variable.key; key.placeholder = "VARIABLE_NAME"; key.setAttribute("aria-label", `Variable ${index + 1} name`);
      key.addEventListener("input", () => { variable.key = key.value; }); keyCell.append(key);
      const typeCell = el("td"); const type = el("select"); type.setAttribute("aria-label", `Variable ${index + 1} visibility`); type.append(option("secret", "Protected"), option("public", "Agent-readable")); type.value = variable.secret ? "secret" : "public";
      type.addEventListener("change", () => { variable.secret = type.value === "secret"; value.type = variable.secret ? "password" : "text"; }); typeCell.append(type);
      const valueCell = el("td", "variable-value"); const value = el("input"); value.type = variable.secret ? "password" : "text"; value.autocomplete = "off"; value.value = variable.value ?? ""; value.placeholder = variable.hasValue ? "•••••••• · unchanged" : "Value"; value.setAttribute("aria-label", `Variable ${index + 1} value`);
      value.addEventListener("input", () => { variable.value = value.value; });
      const reveal = button("Show", async () => {
        try {
          if (value.type === "text") { value.type = "password"; reveal.textContent = "Show"; return; }
          if (variable.value === undefined && variable.hasValue) value.value = (await this.api(`/api/environments/${this.draft.id}/reveal`, { method: "POST", body: JSON.stringify({ key: variable.key }) })).value;
          value.type = "text"; reveal.textContent = "Hide";
        } catch (error) { $("#environment-error").textContent = error.message; }
      }); valueCell.append(value, reveal);
      const actions = el("td", "variable-actions"); const enabled = el("input"); enabled.type = "checkbox"; enabled.checked = variable.enabled; enabled.setAttribute("aria-label", `Variable ${index + 1} enabled`); enabled.addEventListener("change", () => { variable.enabled = enabled.checked; });
      const remove = button("×", () => { this.draft.variables.splice(index, 1); this.renderVariables(); }, "small-icon"); remove.setAttribute("aria-label", `Delete variable ${index + 1}`); actions.append(enabled, remove);
      row.append(keyCell, typeCell, valueCell, actions); body.append(row);
    });
    this.filterVariables();
  }
  filterVariables() { const query = $("#variable-search").value.toLowerCase(); [...$("#variables-table-body").children].forEach((row, i) => { row.hidden = !this.draft.variables[i].key.toLowerCase().includes(query); }); }
  async saveEnvironment(event) {
    event.preventDefault(); event.submitter.disabled = true;
    this.draft.name = $("#environment-name").value; this.draft.variablesEnabled = $("#variables-enabled").checked;
    Object.assign(this.draft, this.environmentCompanies.value());
    this.draft.setupScript = $("#environment-setup-script").value; this.draft.archived = $("#environment-archived").checked;
    try {
      this.requireCompanyScopes();
      const { environment } = await this.api(this.draft.id ? `/api/environments/${this.draft.id}` : "/api/environments", { method: this.draft.id ? "PATCH" : "POST", body: JSON.stringify(this.draft) });
      await this.load(); $("#environment-select").value = environment.id; await this.remember(); this.editEnvironment(environment); $("#environment-save-status").textContent = "Saved securely";
    } catch (error) { $("#environment-error").textContent = error.message; }
    finally { event.submitter.disabled = false; }
  }
  async deleteEnvironment() {
    if (!confirm(`Delete environment “${this.draft.name}”?`)) return;
    try { await this.api(`/api/environments/${this.draft.id}`, { method: "DELETE" }); await this.load(); this.editEnvironment(this.environments[0]); }
    catch (error) { $("#environment-error").textContent = error.message; }
  }
  requireCompanyScopes() { if (!this.state.config?.features?.companyScopes) throw new Error("Restart Relay to activate company-scoped settings before saving. This server still uses the old global settings."); }
}
