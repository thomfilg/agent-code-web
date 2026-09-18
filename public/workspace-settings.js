import { ModelPicker } from "./model-picker.js";
import { companyForChat, scopeAllows, scopeLabel, scopesOverlap } from "./company-scope.js";
import { CompanyPicker, knownCompanies } from "./company-picker.js";
import { GitHubAccounts } from "./github-accounts.js";
import { agentAccountLabel, agentProjectKey } from "./agent-account-options.js";
const $ = selector => document.querySelector(selector);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
const option = (value, text) => { const e = el("option", "", text); e.value = value; return e; };
const button = (text, action, cls = "secondary-button") => { const e = el("button", cls, text); e.type = "button"; e.addEventListener("click", action); return e; };

export class WorkspaceSettings {
  constructor({ api, state, toast }) {
    Object.assign(this, { api, state, toast }); this.selected = []; this.environments = []; this.repositories = []; this.branchCache = new Map(); this.repositoryRequest = 0;
    this.environmentCompanies = new CompanyPicker($("#environment-companies"), scope => { Object.assign(this.draft, scope); this.renderEnvironmentMcps(); }, { registeredOnly: true });
    this.githubAccounts = new GitHubAccounts(this);
    this.modelPicker = new ModelPicker({ root: $("#new-model-controls"), api, onChange: () => this.remember() });
    $("#github-button").addEventListener("click", () => this.openGitHub());
    $("#connect-github-button").addEventListener("click", () => this.openGitHub());
    $("#repo-search").addEventListener("input", () => this.renderRepositories());
    const repositoryMenu = $("#repository-picker details");
    repositoryMenu.addEventListener("toggle", () => {
      repositoryMenu.querySelector("summary").setAttribute("aria-expanded", String(repositoryMenu.open));
      if (repositoryMenu.open) $("#repo-search").focus();
    });
    $("#refresh-repositories").addEventListener("click", () => this.loadRepositories(true).catch(error => toast(error.message)));
    $("#environment-select").addEventListener("change", () => { this.updateCreateAvailability(); this.remember(); });
    $("#agent-select").addEventListener("change", async () => { this.renderAccounts(); await this.updateModels(); this.remember(); });
    $("#new-agent-account").addEventListener("change", async () => {
      this.syncAccountAgent();
      const id = $("#new-agent-account").value;
      void this.remember({ model: null, effort: null });
      await this.updateModels(); if ($("#new-agent-account").value === id) this.remember();
    });
    $("#environment-settings").addEventListener("click", () => this.openEnvironments($("#environment-select").value));
    $("#environments-button").addEventListener("click", () => this.openEnvironments());
    $("#add-environment").addEventListener("click", () => this.editEnvironment(null));
    $("#environment-form").addEventListener("submit", event => this.saveEnvironment(event));
    $("#delete-environment").addEventListener("click", () => this.deleteEnvironment());
    $("#variable-search").addEventListener("input", () => this.filterVariables());
    $("#add-variable").addEventListener("click", () => { this.draft.variables.push({ key: "", value: "", secret: true, enabled: true }); this.renderVariables(); $("#variables-table-body tr:last-child input").focus(); });
    $("#environments-dialog").addEventListener("close", () => { this.draft = null; $("#variables-table-body").replaceChildren(); });
  }
  load(options) { return this.loading = this.loadSnapshot(options); }
  async loadCurrent() {
    let pending = this.load();
    // Follow replacement requests already in flight, never poll/retry the API.
    // Repeated account changes fail visibly instead of starting an unbounded loop.
    for (let changes = 0; changes < 4; changes++) {
      const loaded = await pending;
      if (pending === this.loading) {
        if (!loaded) throw new Error("Settings changed while loading. Reopen this dialog to retry.");
        return;
      }
      pending = this.loading;
    }
    throw new Error("Settings changed while loading. Reopen this dialog to retry.");
  }
  async loadSnapshot({ validWhile = () => true } = {}) {
    if (!this.state.config) throw new Error("Relay is still loading. Try again in a moment.");
    const request = this.loadRequest = (this.loadRequest || 0) + 1;
    const [github, environments, saved, mcps, accounts, registry] = await Promise.all([this.api("/api/github"), this.api("/api/environments"), this.api("/api/preferences"), this.api("/api/mcps"), this.state.config.features?.agentAccounts ? this.api("/api/agent-accounts") : { accounts: [] }, this.state.config.features?.companyRegistry ? this.api("/api/companies") : {}]);
    if (request !== this.loadRequest || !validWhile()) return false;
    const repositoryScope = JSON.stringify(github.connections || []);
    if (this.repositoryScope !== repositoryScope) {
      this.repositoryScope = repositoryScope; this.repositoryRequest++;
      this.repositories = []; this.repositoryLoading = false; this.repositoryError = false;
    }
    this.mcps = mcps.connections;
    if (registry.companies) this.state.companies = registry.companies;
    this.github = github; this.environments = environments.environments; this.software = environments.software;
    this.preferences = saved.preferences;
    this.projectAgents = saved.projectAgents || {};
    this.accounts = accounts.accounts;
    if (!this.draftReady) this.selected = structuredClone(saved.preferences.repositories || []).map(repo => {
      const companyId = github.connections?.find(connection => connection.id === repo.githubConnectionId)?.companyId;
      return { ...repo, ...(companyId ? { companyId } : {}) };
    });
    $("#github-button").textContent = github.connected ? `GitHub · ${github.login}` : "Connect GitHub";
    $("#github-requirement").hidden = github.connected;
    $("#repository-picker").hidden = !github.connected && !this.selected.length;
    $("#repository-picker details").hidden = !github.connected;
    $("#create-chat-button").disabled = !github.connected;
    this.renderEnvironments();
    this.renderRepositories();
    if (this.draftReady) this.renderSelected();
    return true;
  }
  renderEnvironments() {
    const selected = $("#environment-select").value || this.preferences?.environmentId;
    const company = companyForChat({ repositories: this.selected });
    const available = this.environments.filter(env => !env.archived && scopeAllows(env, company));
    $("#environment-select").replaceChildren(...available.map(env => option(env.id, env.name)));
    if (available.some(env => env.id === selected)) $("#environment-select").value = selected;
    if (!available.length) $("#environment-select").append(option("", `No environment for ${company || "unassigned chats"} · configure companies`));
    this.renderAccounts();
  }
  renderAccounts() {
    const supported = this.state.config.features?.agentAccounts;
    $("#connect-codex-button").hidden = !supported;
    const select = $("#new-agent-account"), provider = $("#agent-select");
    provider.hidden = Boolean(supported); provider.required = !supported; provider.disabled = Boolean(supported) || !provider.value;
    provider.setAttribute("aria-label", supported ? "Agent type" : "Agent");
    select.hidden = !supported; select.required = Boolean(supported);
    const project = agentProjectKey({ repositories: this.selected });
    const sameProject = this.accountProject === project;
    const saved = this.projectAgents?.[project]?.agentAccountId || (project === agentProjectKey(this.preferences) ? this.preferences?.agentAccountId : null);
    const old = sameProject ? select.value || saved : saved || select.value;
    const available = (this.accounts || []).filter(account => ["codex", "claude"].includes(account.provider) && account.status === "connected");
    $("#agent-account-requirement").hidden = !supported || available.length > 0;
    select.replaceChildren(option("", "Select an agent account"), ...available.map(account => option(account.id, agentAccountLabel(account))));
    if (available.some(account => account.id === old)) select.value = old;
    else if (!old && available.length === 1) select.value = available[0].id;
    this.accountProject = project;
    select.disabled = !supported || !available.length;
    if (supported) this.syncAccountAgent();
    $("#agent-account-hint").textContent = !available.length
      ? "Connect Codex or Claude using the settings button beside Agent."
      : "Choose an account for this chat. Your choice is remembered for this project.";
    this.updateCreateAvailability();
    if (!provider.value || supported && !select.value) void this.modelPicker.setAgent(null);
    else if (this.draftReady && supported && (this.modelPicker.agent !== provider.value || this.modelPicker.agentAccountId !== select.value)) void this.updateModels();
  }
  syncAccountAgent() {
    const account = (this.accounts || []).find(account => account.id === $("#new-agent-account").value && account.status === "connected");
    $("#agent-select").value = account?.provider || "";
  }
  updateCreateAvailability() {
    const agent = $("#agent-select").value;
    const needed = this.state.config.features?.agentAccounts && ["codex", "claude"].includes(agent);
    $("#create-chat-button").disabled = Boolean(this.selected.length && !this.github?.connected) || !$("#environment-select").value || !agent || Boolean(needed && !$("#new-agent-account").value);
  }
  updateModels(selected = {}) {
    const agent = $("#agent-select").value;
    const needed = this.state.config.features?.agentAccounts && ["codex", "claude"].includes(agent);
    const agentAccountId = needed ? $("#new-agent-account").value : null;
    this.updateCreateAvailability();
    return this.modelPicker.setAgent(!agent || needed && !agentAccountId ? null : agent, { ...selected, agentAccountId }, { useDefaults: true });
  }
  async openNew() {
    $("#create-chat-error").textContent = "";
    await this.loadCurrent();
    if (!this.draftReady) {
      this.accountProject = undefined;
      if (this.preferences.agent && [...$("#agent-select").options].some(o => o.value === this.preferences.agent)) $("#agent-select").value = this.preferences.agent;
      this.modelPicker.key = null;
      this.renderAccounts(); await this.updateModels(this.preferences);
      this.draftReady = true;
    }
    $("#repo-search").value = "";
    this.renderSelected();
    $("#repository-picker .repository-picker-dropdown").open = false;
    if (this.github.connected) await this.loadRepositories();
  }
  async loadRepositories(refresh = false) {
    const request = ++this.repositoryRequest;
    this.repositoryLoading = true; this.repositoryError = false; this.renderRepositories();
    try {
      const { repositories } = await this.api(`/api/github/repositories${refresh ? "?refresh=1" : ""}`);
      if (request !== this.repositoryRequest) return;
      this.repositories = repositories;
    } catch {
      if (request !== this.repositoryRequest) return;
      this.repositories = []; this.repositoryError = true;
    } finally {
      if (request === this.repositoryRequest) { this.repositoryLoading = false; this.renderRepositories(); }
    }
  }
  renderRepositories() {
    const query = $("#repo-search").value.toLowerCase();
    const results = $("#repository-results"); results.replaceChildren();
    const status = (text, { error = false, manage = false, retry = false } = {}) => {
      const message = el("p", error ? "form-error" : "muted", text); message.id = "repository-status"; message.setAttribute("role", error ? "alert" : "status"); results.append(message);
      if (manage) { const action = button("Manage GitHub accounts", () => this.openGitHub()); action.id = "repository-manage-github"; results.append(action); }
      if (retry) { const action = button("Retry loading repositories", () => this.loadRepositories(true)); action.id = "repository-retry"; results.append(action); }
    };
    if (this.repositoryLoading) return status("Loading repositories…");
    if (this.repositoryError) return status("Could not load repositories. Check your GitHub connection and retry.", { error: true, manage: true, retry: true });
    const primaryCompany = companyForChat({ repositories: this.selected });
    for (const repo of this.repositories.filter(repo => repo.fullName.toLowerCase().includes(query) && (!primaryCompany || !repo.companyId || repo.companyId === primaryCompany))) {
      const label = el("label", "repository-option"); const input = el("input"); input.type = "checkbox"; input.checked = this.selected.some(item => item.fullName === repo.fullName && (!item.githubConnectionId || item.githubConnectionId === repo.githubConnectionId));
      input.addEventListener("change", () => {
        if (input.checked) { this.selected = this.selected.filter(item => item.fullName !== repo.fullName); this.selected.push({ fullName: repo.fullName, branch: repo.defaultBranch, githubConnectionId: repo.githubConnectionId, ...(repo.companyId ? { companyId: repo.companyId } : {}) }); }
        else this.selected = this.selected.filter(item => item.fullName !== repo.fullName);
        this.renderSelected(); this.renderRepositories(); this.remember();
      });
      label.append(input, el("span", "", repo.fullName), el("small", "", `${repo.private ? "Private" : "Public"}${repo.connectionName ? ` · ${repo.connectionName}` : ""}`)); results.append(label);
    }
    if (!results.childElementCount) status(this.repositories.length ? "No repositories match your search." : "No repositories are available from your connected GitHub accounts. Check GitHub permissions or refresh the list.", { manage: !this.repositories.length, retry: !this.repositories.length });
  }
  renderSelected() {
    this.renderEnvironments();
    const container = $("#selected-repositories"); container.replaceChildren();
    for (const [index, repo] of this.selected.entries()) {
      const chip = el("div", "repository-chip"); chip.title = `${repo.fullName}${index === 0 ? " · Primary repository" : ""}`;
      const name = el("span", "repository-name", `‹/› ${repo.fullName.split("/").at(-1)}`); chip.append(name);
      const branch = el("select"); branch.setAttribute("aria-label", `Branch for ${repo.fullName}`); branch.append(option(repo.branch, repo.branch));
      const loadBranches = async () => {
        try {
          const key = `${repo.githubConnectionId || "auto"}:${repo.fullName}`;
          const branches = this.branchCache.get(key) || (await this.api(`/api/github/branches?repository=${encodeURIComponent(repo.fullName)}${repo.githubConnectionId ? `&connection=${encodeURIComponent(repo.githubConnectionId)}` : ""}&company=${encodeURIComponent(companyForChat({ repositories: this.selected }) || "")}`)).branches;
          this.branchCache.set(key, branches);
          branch.replaceChildren(...[...new Set([repo.branch, ...branches])].map(name => option(name, name))); branch.value = repo.branch;
        } catch (error) { this.toast(error.message); }
      };
      branch.addEventListener("focus", loadBranches, { once: true });
      branch.addEventListener("change", () => { repo.branch = branch.value; this.remember(); }); chip.append(branch);
      if (index) { const primary = button("↑", () => { this.selected.splice(index, 1); this.selected.unshift(repo); this.renderSelected(); this.remember(); }, "small-icon"); primary.setAttribute("aria-label", `Make ${repo.fullName} primary`); chip.append(primary); }
      const remove = button("×", () => { this.selected = this.selected.filter(item => item !== repo); this.renderSelected(); this.renderRepositories(); this.remember(); }, "small-icon"); remove.setAttribute("aria-label", `Remove ${repo.fullName}`); chip.append(remove); container.append(chip);
    }
    const company = companyForChat({ repositories: this.selected });
    const label = this.state.companies?.find(entry => entry.id === company)?.name || company;
    $("#repository-group-hint").textContent = this.selected.length ? `Grouped under ${label} → ${this.selected[0].fullName.split("/").at(-1)}. Use ↑ to choose another primary repository.` : "Select repositories. The first repository's GitHub connection determines the company.";
  }
  payload() {
    if (this.selected.length && !this.github?.connected) throw new Error("Connect GitHub to use the selected repositories");
    const agent = $("#agent-select").value, agentAccountId = $("#new-agent-account").value;
    if (!agent || this.state.config.features?.agentAccounts && ["codex", "claude"].includes(agent) && !agentAccountId) throw new Error("Connect and select an agent account first");
    return { agent, ...(agentAccountId && ["codex", "claude"].includes(agent) ? { agentAccountId } : {}), ...this.modelPicker.value(), environmentId: $("#environment-select").value, repositories: this.selected };
  }
  async remember(modelSelection = {}) {
    if (!$("#environment-select").value) return;
    const selection = this.draftReady ? { agent: $("#agent-select").value, ...this.modelPicker.value() } : { agent: this.preferences.agent || $("#agent-select").value, model: this.preferences.model || null, effort: this.preferences.effort || null };
    const body = { ...selection, ...modelSelection, environmentId: $("#environment-select").value, repositories: structuredClone(this.selected) };
    if (!body.agent) return;
    if (this.state.config.features?.agentAccounts && ["codex", "claude"].includes(body.agent)) {
      body.agentAccountId = this.draftReady ? $("#new-agent-account").value : this.preferences.agentAccountId;
      if (!body.agentAccountId) return;
    }
    const project = agentProjectKey(body);
    const remembered = { agent: body.agent, agentAccountId: body.agentAccountId };
    const previous = this.projectAgents?.[project];
    if (project && body.agentAccountId) this.projectAgents = { ...this.projectAgents, [project]: remembered };
    this.preferenceQueue = (this.preferenceQueue || Promise.resolve()).catch(() => {}).then(() => this.api("/api/preferences", { method: "PATCH", body: JSON.stringify(body) }));
    try {
      await this.preferenceQueue; this.preferences = body;
    } catch (error) {
      if (this.projectAgents?.[project] === remembered) { if (previous) this.projectAgents[project] = previous; else delete this.projectAgents[project]; }
      this.toast(`Could not remember your selection: ${error.message}`);
    }
  }
  async openGitHub() {
    await this.githubAccounts.open();
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
    const companyState = { ...this.state, chats: [...(this.state.chats || []), ...this.selected.map(repository => ({ repositories: [repository] }))] };
    this.environmentCompanies.set(this.draft, knownCompanies(companyState, [...this.environments, ...this.mcps, ...(this.accounts || [])]));
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
    if (this.state.config?.features?.companyMcpConnections) {
      const allowed = this.mcps.filter(connection => connection.companyId && scopeAllows(this.draft, connection.companyId));
      $("#environment-mcp-options").replaceChildren(...allowed.map(connection => el("p", "muted", `${connection.name} · ${connection.companyId}`)));
      return;
    }
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
