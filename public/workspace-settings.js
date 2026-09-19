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
    this.environmentCompanies = new CompanyPicker($("#environment-companies"), scope => { Object.assign(this.draft, scope); this.renderEnvironmentMcps(); this.updateEnvironmentDirty(); }, { registeredOnly: true });
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
    $("#environment-select").addEventListener("change", () => this.changeEnvironment());
    $("#agent-select").addEventListener("change", async () => { this.renderAccounts(); await this.updateModels(); this.remember(); });
    $("#new-agent-account").addEventListener("change", async () => {
      this.syncAccountAgent();
      const id = $("#new-agent-account").value;
      void this.remember({ model: null, effort: null });
      await this.updateModels(); if ($("#new-agent-account").value === id) this.remember();
    });
    $("#environment-settings").addEventListener("click", () => this.openEnvironments($("#environment-select").value));
    $("#environments-button").addEventListener("click", () => this.openEnvironments());
    $("#add-environment").addEventListener("click", () => { if (this.discardEnvironmentEdits()) this.editEnvironment(null); });
    $("#environment-company-filter").addEventListener("change", event => {
      if (!this.discardEnvironmentEdits()) { event.target.value = this.settingsCompanyId; return; }
      this.settingsCompanyId = event.target.value; this.editEnvironment(this.companyEnvironments()[0]);
    });
    $("#environment-editor-select").addEventListener("change", event => {
      if (!this.discardEnvironmentEdits()) { event.target.value = this.draft.id || ""; return; }
      this.editEnvironment(this.companyEnvironments().find(env => env.id === event.target.value));
    });
    document.querySelectorAll("[data-environment-section]").forEach(node => node.addEventListener("click", () => this.showEnvironmentSection(node.dataset.environmentSection)));
    $("#environment-editor-back").addEventListener("click", () => this.showEnvironmentSection());
    for (const type of ["input", "change"]) $("#environment-form").addEventListener(type, () => this.updateEnvironmentDirty());
    $("#environment-form").addEventListener("submit", event => this.saveEnvironment(event));
    $("#delete-environment").addEventListener("click", () => this.deleteEnvironment());
    $("#variable-search").addEventListener("input", () => this.filterVariables());
    $("#add-variable").addEventListener("click", () => { this.draft.variables.push({ key: "", value: "", secret: true, enabled: true }); this.renderVariables(); this.updateEnvironmentDirty(); $("#variables-table-body tr:last-child input").focus(); });
    const environmentDialog = $("#environments-dialog");
    environmentDialog.addEventListener("cancel", event => { if (!this.discardEnvironmentEdits()) event.preventDefault(); });
    environmentDialog.querySelector("[data-close-dialog]").addEventListener("click", event => { if (!this.discardEnvironmentEdits()) { event.preventDefault(); event.stopImmediatePropagation(); } }, true);
    environmentDialog.addEventListener("close", () => { this.draft = null; this.environmentBaseline = null; $("#variables-table-body").replaceChildren(); });
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
    // Repository defaults must not hide the environment needed to switch companies.
    // Availability is checked when sending; an explicit switch scopes the draft.
    const available = this.environments.filter(env => !env.archived);
    const chosen = available.find(env => env.id === selected) || available.find(env => scopeAllows(env, company)) || available[0];
    $("#environment-select").replaceChildren(...available.map(env => option(env.id, env.name)));
    if (chosen) $("#environment-select").value = chosen.id;
    else $("#environment-select").append(option("", "No active environments · manage environments"));
    this.renderAccounts();
  }
  selectedEnvironment() { return this.environments.find(env => env.id === $("#environment-select").value && !env.archived); }
  changeEnvironment() {
    const environment = this.selectedEnvironment();
    if (!environment) { this.updateCreateAvailability(); return; }
    const previous = this.selected.length;
    this.selected = this.selected.filter(repo => scopeAllows(environment, companyForChat({ repositories: [repo] })));
    $("#repo-search").value = ""; $("#create-chat-error").textContent = "";
    this.renderSelected(); this.renderRepositories();
    if (this.selected.length !== previous) this.toast(`Switched to ${environment.name}. Repositories from other companies were removed from this draft; your message is kept.`);
    return this.remember();
  }
  environmentSelectionError() {
    const environment = this.selectedEnvironment();
    if (!environment) return "Choose an active environment before sending.";
    if (!this.selected.length && !scopeAllows(environment, null)) return `Choose a repository for “${environment.name}” before sending.`;
    if (this.selected.some(repo => !scopeAllows(environment, companyForChat({ repositories: [repo] })))) return `The selected repositories are not available in “${environment.name}”. Choose another environment or remove them.`;
    return "";
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
    const environmentError = this.environmentSelectionError();
    $("#environment-selection-hint").textContent = environmentError;
    $("#environment-selection-hint").hidden = !environmentError;
    $("#create-chat-button").disabled = Boolean(this.selected.length && !this.github?.connected) || Boolean(environmentError) || !agent || Boolean(needed && !$("#new-agent-account").value);
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
    const primaryCompany = companyForChat({ repositories: this.selected }), environment = this.selectedEnvironment();
    // Legacy repository responses have no companyId; retain their old display
    // behavior, with environment admission still checked in payload and server.
    const scoped = this.repositories.filter(repo => (!primaryCompany || !repo.companyId || repo.companyId === primaryCompany) && (!environment || !repo.companyId || scopeAllows(environment, repo.companyId)));
    for (const repo of scoped.filter(repo => repo.fullName.toLowerCase().includes(query))) {
      const label = el("label", "repository-option"); const input = el("input"); input.type = "checkbox"; input.checked = this.selected.some(item => item.fullName === repo.fullName && (!item.githubConnectionId || item.githubConnectionId === repo.githubConnectionId));
      input.addEventListener("change", () => {
        if (input.checked) { this.selected = this.selected.filter(item => item.fullName !== repo.fullName); this.selected.push({ fullName: repo.fullName, branch: repo.defaultBranch, githubConnectionId: repo.githubConnectionId, ...(repo.companyId ? { companyId: repo.companyId } : {}) }); }
        else this.selected = this.selected.filter(item => item.fullName !== repo.fullName);
        this.renderSelected(); this.renderRepositories(); this.remember();
      });
      label.append(input, el("span", "", repo.fullName), el("small", "", `${repo.private ? "Private" : "Public"}${repo.connectionName ? ` · ${repo.connectionName}` : ""}`)); results.append(label);
    }
    if (!results.childElementCount) {
      const unavailable = this.repositories.length && !scoped.length && environment;
      status(unavailable ? `No repositories are available for “${environment.name}”. Check its GitHub connection or choose another environment.` : this.repositories.length ? "No repositories match your search." : "No repositories are available from your connected GitHub accounts. Check GitHub permissions or refresh the list.", { manage: Boolean(unavailable) || !this.repositories.length, retry: !this.repositories.length });
    }
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
    const environmentError = this.environmentSelectionError();
    if (environmentError) throw new Error(environmentError);
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
  companyEnvironments() { return this.environments.filter(env => this.settingsCompanyId === "__review__" ? !env.companies?.length && !env.allowUnassigned : scopeAllows(env, this.settingsCompanyId || null)); }
  async openEnvironments(id, companyId = null) {
    try {
      await this.loadCurrent();
      const requested = this.environments.find(env => env.id === id);
      this.settingsCompanyId = companyId ?? requested?.companies?.[0] ?? this.state.companies?.[0]?.id ?? this.environments[0]?.companies?.[0] ?? "";
      if (requested && !companyId && !requested.companies?.length) this.settingsCompanyId = requested.allowUnassigned ? "" : "__review__";
      this.editEnvironment(this.companyEnvironments().find(env => env.id === id) || this.companyEnvironments()[0]);
      $("#environments-dialog").showModal();
    }
    catch (error) { this.toast(error.message); }
  }
  discardEnvironmentEdits() { return !this.environmentSaving && (!this.environmentDirty() || confirm("Discard unsaved environment changes?")); }
  captureEnvironmentFields() {
    if (!this.draft) return;
    Object.assign(this.draft, { name: $("#environment-name").value, variablesEnabled: $("#variables-enabled").checked,
      setupScript: $("#environment-setup-script").value, archived: $("#environment-archived").checked });
  }
  environmentDirty() { this.captureEnvironmentFields(); return Boolean(this.draft && this.environmentBaseline !== JSON.stringify(this.draft)); }
  updateEnvironmentDirty() {
    $("#save-environment").disabled = Boolean(this.environmentSaving) || !this.environmentDirty();
    if (!this.draft) return;
    $("#environment-software-summary").textContent = `${this.draft.software.length} selected`;
    $("#environment-variables-summary").textContent = this.draft.variablesEnabled ? `${this.draft.variables.length} variables` : "Disabled";
    $("#environment-setup-summary").textContent = this.draft.setupScript.trim() ? "Startup script configured" : "No startup script";
  }
  showEnvironmentSection(section = null) {
    $("#environment-overview").hidden = Boolean(section); $("#environment-editor-heading").hidden = !section;
    const titles = { software: "Software", variables: "Environment variables", setup: "Setup script" };
    for (const id of Object.keys(titles)) $("#environment-" + id + "-editor").hidden = id !== section;
    $("#environment-editor-title").textContent = titles[section] || "";
    this.updateEnvironmentDirty();
  }
  editEnvironment(environment) {
    this.draft = structuredClone(environment || { name: "", backend: this.state.config.workerBackend, variablesEnabled: true, variables: [], software: [], ...(this.settingsCompanyId && this.settingsCompanyId !== "__review__" ? { companies: [this.settingsCompanyId], allowUnassigned: false } : {}) });
    $("#environment-error").textContent = "";
    $("#environment-save-status").textContent = "";
    const companies = [...new Set([...(this.state.companies || []).map(company => company.id), ...this.environments.flatMap(env => env.companies || [])])];
    const filter = $("#environment-company-filter");
    filter.replaceChildren(...companies.map(id => option(id, this.state.companies?.find(company => company.id === id)?.name || id)));
    if (!companies.length || this.settingsCompanyId === "" || this.environments.some(env => env.allowUnassigned)) filter.append(option("", "Unassigned chats"));
    if (this.settingsCompanyId === "__review__" || this.environments.some(env => !env.companies?.length && !env.allowUnassigned)) filter.append(option("__review__", "Needs company assignment"));
    filter.value = this.settingsCompanyId || "";
    const select = $("#environment-editor-select");
    select.replaceChildren(...this.companyEnvironments().map(env => option(env.id, `${env.name}${env.archived ? " · Archived" : ""}`)));
    if (!environment) select.append(option("", "New environment"));
    select.value = environment?.id || "";
    $("#environment-advanced").open = false;
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
    this.captureEnvironmentFields(); this.environmentBaseline = JSON.stringify(this.draft); this.showEnvironmentSection();
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
      const remove = button("×", () => { this.draft.variables.splice(index, 1); this.renderVariables(); this.updateEnvironmentDirty(); }, "small-icon"); remove.setAttribute("aria-label", `Delete variable ${index + 1}`); actions.append(enabled, remove);
      row.append(keyCell, typeCell, valueCell, actions); body.append(row);
    });
    this.filterVariables();
  }
  filterVariables() { const query = $("#variable-search").value.toLowerCase(); [...$("#variables-table-body").children].forEach((row, i) => { row.hidden = !this.draft.variables[i].key.toLowerCase().includes(query); }); }
  async saveEnvironment(event) {
    event.preventDefault();
    if (this.environmentSaving || !this.environmentDirty()) return;
    if (!this.draft.name.trim()) { this.showEnvironmentSection(); $("#environment-name").focus(); return; }
    this.environmentSaving = true; this.updateEnvironmentDirty(); $("#environment-error").textContent = "";
    const fields = [...$("#environments-dialog").querySelectorAll("input, select, textarea, button")];
    const disabled = fields.map(field => field.disabled); fields.forEach(field => { field.disabled = true; });
    try {
      this.requireCompanyScopes();
      const { environment } = await this.api(this.draft.id ? `/api/environments/${this.draft.id}` : "/api/environments", { method: this.draft.id ? "PATCH" : "POST", body: JSON.stringify(this.draft) });
      await this.load();
      if (!environment.archived) { $("#environment-select").value = environment.id; await this.changeEnvironment(); }
      this.environmentBaseline = JSON.stringify(this.draft); $("#environments-dialog").close(); this.toast("Environment saved");
    } catch (error) { $("#environment-error").textContent = error.message; }
    finally { fields.forEach((field, index) => { field.disabled = disabled[index]; }); this.environmentSaving = false; this.updateEnvironmentDirty(); }
  }
  async deleteEnvironment() {
    if (!confirm(`Delete environment “${this.draft.name}”?`)) return;
    try { await this.api(`/api/environments/${this.draft.id}`, { method: "DELETE" }); await this.load(); this.editEnvironment(this.companyEnvironments()[0]); }
    catch (error) { $("#environment-error").textContent = error.message; }
  }
  requireCompanyScopes() { if (!this.state.config?.features?.companyScopes) throw new Error("Restart Relay to activate company-scoped settings before saving. This server still uses the old global settings."); }
}
