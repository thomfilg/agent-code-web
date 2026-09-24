import { ModelPicker } from "./model-picker.js";
import { companyForChat, scopeAllows, scopeLabel, scopesOverlap } from "./company-scope.js";
import { companyContext } from "./company-context.js";
import { environmentAllows, environmentCompany } from "./environment-scope.js";
import { GitHubAccounts } from "./github-accounts.js";
import { agentAccountLabel, agentProjectKey } from "./agent-account-options.js";
import { loginState } from "./browser-profile-sessions.js";
const $ = selector => document.querySelector(selector);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
const option = (value, text) => { const e = el("option", "", text); e.value = value; return e; };
const button = (text, action, cls = "secondary-button") => { const e = el("button", cls, text); e.type = "button"; e.addEventListener("click", action); return e; };
const instanceLabel = instance => `${instance.id} · ${instance.vcpu} vCPU · ${instance.memoryGiB} GiB · $${instance.usdPerHour.toFixed(4)}/hour${instance.recommended ? " · Recommended" : instance.burstable ? " · Burstable" : ""}`;

export class WorkspaceSettings {
  constructor({ api, state, toast }) {
    Object.assign(this, { api, state, toast }); this.selected = []; this.environments = []; this.repositories = []; this.branchCache = new Map(); this.selectionCache = new Map(); this.repositoryRequest = 0;
    try { this.lastCompany = localStorage.getItem("relay-last-new-chat-company") || null; } catch { this.lastCompany = null; }
    $("#environment-company").addEventListener("change", event => {
      const companyId = event.target.value;
      if (this.environmentScopedCompanyId && companyId !== this.environmentScopedCompanyId) { event.target.value = this.environmentScopedCompanyId; return; }
      Object.assign(this.draft, { companyId, companies: companyId ? [companyId] : [], allowUnassigned: false, scopeNeedsReview: !companyId, confirmCompanyAssignment: true });
      if (this.browserProfiles?.find(profile => profile.id === this.draft.browserProfileId)?.companyId !== companyId) this.draft.browserProfileId = null;
      this.renderEnvironmentMcps(); this.renderBrowserProfiles(); this.updateEnvironmentDirty();
    });
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
    $("#environment-select").addEventListener("change", () => this.changeEnvironment().catch(error => toast(error.message)));
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
    $("#environment-instance-type").addEventListener("change", event => { if (this.draft) this.draft.instanceType = event.target.value; this.renderInstancePrice(); this.updateEnvironmentDirty(); });
    document.querySelectorAll("[data-environment-section]").forEach(node => node.addEventListener("click", () => this.showEnvironmentSection(node.dataset.environmentSection)));
    $("#environment-editor-back").addEventListener("click", () => this.showEnvironmentSection());
    $("#environment-browser-profile").addEventListener("change", event => { if (this.draft) this.draft.browserProfileId = event.target.value || null; this.renderBrowserProfiles(); this.updateEnvironmentDirty(); });
    $("#browser-profile-create").addEventListener("click", () => this.browserProfileAction("create"));
    $("#browser-profile-upload").addEventListener("click", () => this.browserProfileAction("upload"));
    $("#browser-profile-delete").addEventListener("click", () => this.browserProfileAction("delete"));
    $("#browser-profile-refresh").addEventListener("click", () => this.browserProfileAction("refresh"));
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
    const [github, environments, saved, mcps, accounts, registry, profiles] = await Promise.all([this.api("/api/github"), this.api("/api/environments"), this.api("/api/preferences"), this.api("/api/mcps"), this.state.config.features?.agentAccounts ? this.api("/api/agent-accounts") : { accounts: [] }, this.state.config.features?.companyRegistry ? this.api("/api/companies") : {}, this.api("/api/browser-profiles").catch(() => ({ profiles: [] }))]);
    if (request !== this.loadRequest || !validWhile()) return false;
    const repositoryScope = JSON.stringify(github.connections || []);
    if (this.repositoryScope !== repositoryScope) {
      this.repositoryScope = repositoryScope; this.repositoryRequest++;
      this.repositories = []; this.repositoryLoading = false; this.repositoryError = false;
    }
    this.mcps = mcps.connections;
    if (registry.companies) this.state.companies = registry.companies;
    this.github = github; this.environments = environments.environments; this.software = environments.software; this.browserProfiles = profiles.profiles || [];
    this.instances = environments.instances || []; this.defaultInstanceType = environments.defaultInstanceType || "t3.medium";
    this.instanceRegion = environments.region || ""; this.instancePricingRegion = environments.pricingRegion || this.instanceRegion;
    this.preferences = saved.preferences;
    this.selectionMemory = saved.selectionMemory === true;
    this.projectAgents = saved.projectAgents || {};
    this.accounts = accounts.accounts;
    this.snapshotReady = true;
    const savedCompany = companyForChat(saved.preferences);
    this.selectionCache ||= new Map();
    if (savedCompany) this.selectionCache.set(savedCompany, structuredClone(saved.preferences));
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
    const available = this.environments.filter(env => !env.archived && !env.scopeNeedsReview && environmentCompany(env));
    const chosen = available.find(env => env.id === selected) || available.find(env => scopeAllows(env, company)) || available[0];
    $("#environment-select").replaceChildren(...available.map(env => option(env.id, env.name)));
    if (chosen) $("#environment-select").value = chosen.id;
    else $("#environment-select").append(option("", "No active environments · manage environments"));
    this.renderAccounts();
  }
  selectedEnvironment() { return this.environments.find(env => env.id === $("#environment-select").value && !env.archived && !env.scopeNeedsReview && environmentCompany(env)); }
  async changeEnvironment() {
    const environment = this.selectedEnvironment();
    if (!environment) { this.updateCreateAvailability(); return; }
    const company = environment.companies?.length === 1 ? environment.companies[0] : null;
    // A same-company environment switch keeps the selected model/account and
    // waits for their complete restore, including a queued catalog request.
    if (this.restoringSelection && this.selectionModels && company === this.selectionCompany) {
      const current = this.selectionVersion;
      await this.selectionModels.catch(() => {});
      if (current !== this.selectionVersion) return;
    }
    const version = this.selectionVersion = (this.selectionVersion || 0) + 1;
    this.setRestoringSelection(false);
    if (this.selectionMemory && company && company !== (this.selectionCompany || companyForChat({ repositories: this.selected }))) {
      await this.restoreSelection({ companyId: company }, { environmentId: environment.id });
      return;
    }
    // Changing to a second environment of this company must not capture the
    // temporary "Loading models" value or enable Send with a default model.
    if (this.modelLoad) {
      this.setRestoringSelection(true); this.updateCreateAvailability();
      await this.modelLoad.catch(() => {});
      if (version !== this.selectionVersion) return;
      this.setRestoringSelection(false);
    }
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
    const company = companyForChat({ repositories: this.selected }) || this.selectionCompany || null;
    const explicit = this.restoredAccount?.key === JSON.stringify([company, project]);
    const sameProject = this.accountProject === project;
    const sameCompany = company === companyForChat(this.preferences);
    const saved = explicit ? this.restoredAccount.id : sameCompany ? (!this.selectionMemory ? this.projectAgents?.[project]?.agentAccountId : null) || (project === agentProjectKey(this.preferences) ? this.preferences?.agentAccountId : null) : null;
    const old = explicit ? saved : sameProject && sameCompany ? select.value || saved : saved;
    const available = (this.accounts || []).filter(account => ["codex", "claude"].includes(account.provider) && account.status === "connected");
    $("#agent-account-requirement").hidden = !supported || available.length > 0;
    select.replaceChildren(option("", "Choose agent"), ...available.map(account => option(account.id, agentAccountLabel(account))));
    if (available.some(account => account.id === old)) select.value = old;
    else if (!explicit && !old && available.length === 1) select.value = available[0].id;
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
    const staleModel = this.modelPicker?.model?.selectedOptions?.[0]?.disabled || this.modelPicker?.root?.dataset?.status === "error";
    $("#create-chat-button").disabled = Boolean(this.restoringSelection || this.modelLoad || this.selectionRestoreError || staleModel) || Boolean(this.selected.length && !this.github?.connected) || Boolean(environmentError) || !agent || Boolean(needed && !$("#new-agent-account").value);
  }
  async updateModels(selected = {}) {
    const agent = $("#agent-select").value;
    const needed = this.state.config.features?.agentAccounts && ["codex", "claude"].includes(agent);
    const agentAccountId = needed ? $("#new-agent-account").value : null;
    const version = this.modelLoadVersion = (this.modelLoadVersion || 0) + 1;
    await this.modelLoad?.catch(() => {});
    if (version !== this.modelLoadVersion || $("#agent-select").value !== agent || needed && $("#new-agent-account").value !== agentAccountId) return;
    const loading = this.modelLoad = this.modelPicker.setAgent(!agent || needed && !agentAccountId ? null : agent, { ...selected, agentAccountId }, { useDefaults: true });
    this.updateCreateAvailability();
    try { await loading; }
    finally { if (this.modelLoad === loading) this.modelLoad = null; this.updateCreateAvailability(); }
  }
  async openNew(project, { validWhile = () => true } = {}) {
    $("#create-chat-error").textContent = "";
    // The authenticated account/environment snapshot is already refreshed by
    // boot and explicit settings changes. Reuse it when opening a draft rather
    // than blocking every New chat navigation on the same API fan-out.
    if (!this.snapshotReady) await this.loadCurrent();
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
    if (this.github.connected && !this.repositories.length && !this.repositoryLoading) void this.loadRepositories();
    if (this.selectionMemory && validWhile()) {
      const companyId = project?.companyId || this.lastCompany || (!this.selectionCompany ? companyForChat({ repositories: this.selected }) : null);
      if (companyId) await this.restoreSelection({ companyId, ...(project?.repository ? { repository: project.repository } : {}) }, { validWhile });
    }
  }
  async restoreSelection(project, { environmentId, validWhile = () => true } = {}) {
    const version = this.selectionVersion = (this.selectionVersion || 0) + 1;
    const cached = this.selectionCache.get(project.companyId);
    // Never render repositories from the previous company under the newly
    // selected environment while the authoritative snapshot is refreshed.
    this.selected = structuredClone(cached?.repositories || []);
    this.selectionCompany = project.companyId;
    this.lastCompany = project.companyId;
    try { localStorage.setItem("relay-last-new-chat-company", project.companyId); } catch { /* Browser storage is optional. */ }
    if (cached) {
      this.restoredAccount = { key: JSON.stringify([project.companyId, agentProjectKey(cached)]), id: cached.agentAccountId || "" };
      $("#environment-select").value = environmentId || cached.environmentId || "";
      $("#agent-select").value = cached.agent || "";
    }
    this.renderSelected(); this.renderRepositories();
    this.setRestoringSelection(true); this.updateCreateAvailability();
    try {
      await this.preferenceQueue?.catch(() => {});
      const query = new URLSearchParams({ company: project.companyId, ...(project.repository ? { repository: project.repository } : {}) });
      const result = await this.api(`/api/preferences/restore?${query}`);
      if (version !== this.selectionVersion || !validWhile()) return;
      const saved = result.selection;
      this.selectionCache.set(project.companyId, structuredClone(saved));
      this.selectionRestoreError = Boolean(result.warnings?.length);
      this.selected = structuredClone(saved.repositories || []);
      this.selectionCompany = project.companyId;
      this.restoredAccount = { key: JSON.stringify([project.companyId, agentProjectKey(saved)]), id: saved.agentAccountId || "" };
      $("#environment-select").value = environmentId || saved.environmentId || "";
      $("#agent-select").value = saved.agent || "";
      this.accountProject = undefined;
      this.renderSelected(); this.renderRepositories();
      // No active environment is a blocking selection, not permission to pick
      // an environment from a different company via renderEnvironments fallback.
      if (!environmentId && !saved.environmentId) $("#environment-select").value = "";
      const modelRestore = this.selectionModels = (async () => {
        await this.modelPicker.saving?.catch(() => {});
        if (version !== this.selectionVersion || !validWhile()) return;
        await this.updateModels(saved);
      })();
      try { await modelRestore; }
      finally { if (this.selectionModels === modelRestore) this.selectionModels = null; }
      if (version !== this.selectionVersion || !validWhile()) return;
      const unavailableEffort = saved.effort && ![...this.modelPicker.effort.options].some(option => option.value === saved.effort);
      if (this.modelPicker.root?.dataset.status === "error" || this.modelPicker.model?.selectedOptions?.[0]?.disabled || unavailableEffort) {
        this.selectionRestoreError = true;
        result.warnings = [...(result.warnings || []), "Saved model options are unavailable. Choose an available model or retry this project."];
      }
      $("#repo-search").value = "";
      $("#create-chat-error").textContent = (result.warnings || []).join(" ");
    } catch (error) {
      if (version !== this.selectionVersion || !validWhile()) return;
      this.selected = []; this.selectionCompany = project.companyId;
      this.selectionRestoreError = true;
      this.restoredAccount = { key: JSON.stringify([project.companyId, null]), id: "" };
      $("#agent-select").value = ""; this.renderSelected(); this.renderRepositories();
      $("#environment-select").value = environmentId || "";
      $("#create-chat-error").textContent = `Could not restore project settings: ${error.message}`;
    } finally {
      if (version === this.selectionVersion) {
        this.setRestoringSelection(false); this.updateCreateAvailability();
        if (validWhile()) {
          window.dispatchEvent(new CustomEvent("relay-new-chat-selection-changed"));
          if (!this.selectionRestoreError) void this.remember();
        }
      }
    }
  }
  setRestoringSelection(busy) {
    this.restoringSelection = busy;
    // A slow account/model restore must not make repository controls dead.
    // An explicit repository edit cancels the pending restore below.
    for (const selector of ["#new-agent-account", "#agent-select", "#new-model-controls"]) $(selector).inert = busy;
  }
  beginRepositoryEdit() {
    if (!this.restoringSelection) return;
    this.selectionVersion = (this.selectionVersion || 0) + 1;
    this.selectionRestoreError = false;
    this.setRestoringSelection(false);
    this.updateCreateAvailability();
  }
  async loadRepositories(refresh = false) {
    const request = ++this.repositoryRequest;
    this.repositoryLoading = true; this.repositoryError = false; this.renderRepositories();
    try {
      const { repositories } = await this.api(`/api/github/repositories${refresh ? "?refresh=1" : ""}`);
      if (request !== this.repositoryRequest) return;
      this.repositories = repositories;
    } catch (error) {
      if (request !== this.repositoryRequest) return;
      // A failed listing is not evidence that every saved GitHub login expired.
      // Fetch the authoritative connection status before advising a new sign-in.
      let github = this.github;
      try { github = await this.api("/api/github"); } catch { /* The original failure remains actionable. */ }
      if (request !== this.repositoryRequest) return;
      this.github = github;
      const disconnected = github?.connections?.filter(connection => !connection.connected) || [];
      this.repositories = [];
      if (disconnected.length) {
        const names = disconnected.map(connection => connection.name || connection.login || "GitHub").join(", ");
        this.repositoryError = `GitHub ${disconnected.length === 1 ? "account" : "accounts"} ${names} ${disconnected.length === 1 ? "is" : "are"} disconnected. Reconnect in Manage GitHub accounts, then retry.`;
      } else if (/connection changed while loading/i.test(error.message)) {
        this.repositoryError = "A GitHub connection changed while repositories were loading. Retry the list; no new sign-in is needed.";
      } else if (github?.connected) {
        this.repositoryError = "Your GitHub accounts are connected, but repositories could not be loaded. Retry; if this continues, check repository permissions or GitHub API limits.";
      } else {
        this.repositoryError = "Could not load repositories or verify GitHub connections. Retry or check Manage GitHub accounts.";
      }
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
    // Keep cached repository rows visible while a refresh is in flight. An
    // empty picker is preferable to a blocking/loading interstitial.
    if (this.repositoryLoading && !this.repositories.length) return;
    if (this.repositoryError) return status(this.repositoryError, { error: true, manage: true, retry: true });
    const primaryCompany = companyForChat({ repositories: this.selected }), environment = this.selectedEnvironment();
    // Legacy repository responses have no companyId; retain their old display
    // behavior, with environment admission still checked in payload and server.
    const scoped = this.repositories.filter(repo => (!primaryCompany || !repo.companyId || repo.companyId === primaryCompany) && (!environment || !repo.companyId || scopeAllows(environment, repo.companyId)));
    for (const repo of scoped.filter(repo => repo.fullName.toLowerCase().includes(query))) {
      const label = el("label", "repository-option"); const input = el("input"); input.type = "checkbox"; input.checked = this.selected.some(item => item.fullName === repo.fullName && (!item.githubConnectionId || item.githubConnectionId === repo.githubConnectionId));
      input.addEventListener("change", () => {
        this.beginRepositoryEdit();
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
      const name = button(`‹/› ${repo.fullName.split("/").at(-1)}`, event => {
        event.stopPropagation();
        this.beginRepositoryEdit();
        const menu = $("#repository-picker .repository-picker-dropdown");
        menu.open = !menu.open;
      }, "repository-name");
      name.setAttribute("aria-label", `Change repository ${repo.fullName}`); chip.append(name);
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
      branch.addEventListener("change", () => { this.beginRepositoryEdit(); repo.branch = branch.value; this.remember(); }); chip.append(branch);
      if (index) { const primary = button("↑", () => { this.beginRepositoryEdit(); this.selected.splice(index, 1); this.selected.unshift(repo); this.renderSelected(); this.remember(); }, "small-icon"); primary.setAttribute("aria-label", `Make ${repo.fullName} primary`); chip.append(primary); }
      const remove = button("×", () => { this.beginRepositoryEdit(); this.selected = this.selected.filter(item => item !== repo); this.renderSelected(); this.renderRepositories(); this.remember(); }, "small-icon"); remove.setAttribute("aria-label", `Remove ${repo.fullName}`); chip.append(remove); container.append(chip);
    }
    const company = companyForChat({ repositories: this.selected });
    const label = this.state.companies?.find(entry => entry.id === company)?.name || company;
    $("#repository-group-hint").textContent = this.selected.length ? `Grouped under ${label} → ${this.selected[0].fullName.split("/").at(-1)}. Use ↑ to choose another primary repository.` : "Select repositories. The first repository's GitHub connection determines the company.";
  }
  payload() {
    if (this.restoringSelection || this.modelLoad) throw new Error("Wait for the project selection to finish loading");
    if (this.selectionRestoreError || this.modelPicker?.model?.selectedOptions?.[0]?.disabled || this.modelPicker?.root?.dataset?.status === "error") throw new Error("Review the unavailable saved project options before sending");
    if (this.selected.length && !this.github?.connected) throw new Error("Connect GitHub to use the selected repositories");
    const environmentError = this.environmentSelectionError();
    if (environmentError) throw new Error(environmentError);
    const agent = $("#agent-select").value, agentAccountId = $("#new-agent-account").value;
    if (!agent || this.state.config.features?.agentAccounts && ["codex", "claude"].includes(agent) && !agentAccountId) throw new Error("Connect and select an agent account first");
    return { agent, ...(agentAccountId && ["codex", "claude"].includes(agent) ? { agentAccountId } : {}), ...this.modelPicker.value(), mode: $("#new-mode-select").value, environmentId: $("#environment-select").value, repositories: this.selected };
  }
  resetNewChatMode() { $("#new-mode-select").value = "auto"; }
  async remember(modelSelection = {}) {
    if (this.restoringSelection) return;
    if (this.selected.length) this.selectionRestoreError = false;
    if (!$("#environment-select").value) return;
    const selection = this.draftReady ? { agent: $("#agent-select").value, ...this.modelPicker.value() } : { agent: this.preferences.agent || $("#agent-select").value, model: this.preferences.model || null, effort: this.preferences.effort || null };
    const body = { ...selection, ...modelSelection, environmentId: $("#environment-select").value, repositories: structuredClone(this.selected) };
    body.agent ||= null;
    delete body.ultracode; // Session mode is never inherited by another new chat.
    if (this.state.config.features?.agentAccounts && ["codex", "claude"].includes(body.agent)) {
      body.agentAccountId = this.draftReady ? $("#new-agent-account").value : this.preferences.agentAccountId;
      if (!body.agentAccountId) { body.agent = null; body.model = null; body.effort = null; }
    }
    const project = agentProjectKey(body);
    this.selectionCompany = companyForChat(body) || (this.selectedEnvironment()?.companies?.length === 1 ? this.selectedEnvironment().companies[0] : null);
    this.restoredAccount = { key: JSON.stringify([this.selectionCompany, project]), id: body.agentAccountId || "" };
    const remembered = { agent: body.agent, agentAccountId: body.agentAccountId };
    const previous = this.projectAgents?.[project];
    if (project && body.agentAccountId) this.projectAgents = { ...this.projectAgents, [project]: remembered };
    this.preferenceQueue = (this.preferenceQueue || Promise.resolve()).catch(() => {}).then(() => this.api("/api/preferences", { method: "PATCH", body: JSON.stringify(body) }));
    try {
      await this.preferenceQueue; this.preferences = body;
      if (this.selectionCompany) (this.selectionCache ||= new Map()).set(this.selectionCompany, structuredClone(body));
    } catch (error) {
      if (this.projectAgents?.[project] === remembered) { if (previous) this.projectAgents[project] = previous; else delete this.projectAgents[project]; }
      this.toast(`Could not remember your selection: ${error.message}`);
    }
    this.updateCreateAvailability();
  }
  async openGitHub() {
    await this.githubAccounts.open();
  }
  companyEnvironments() { return this.environments.filter(env => this.settingsCompanyId === "__review__" ? env.scopeNeedsReview || !environmentCompany(env) : environmentAllows(env, this.settingsCompanyId)); }
  async openEnvironments(id, companyId = null, { validWhile = () => true } = {}) {
    const revision = this.environmentOpenRevision = (this.environmentOpenRevision || 0) + 1;
    try {
      await this.loadCurrent();
      if (revision !== this.environmentOpenRevision || !validWhile()) return;
      this.environmentScopedCompanyId = companyId;
      const requested = this.environments.find(env => env.id === id);
      this.settingsCompanyId = companyId ?? requested?.companies?.[0] ?? this.state.companies?.[0]?.id ?? this.environments[0]?.companies?.[0] ?? "";
      if (!companyId && (requested?.scopeNeedsReview || requested && !environmentCompany(requested) || !this.settingsCompanyId)) this.settingsCompanyId = "__review__";
      this.editEnvironment(this.companyEnvironments().find(env => env.id === id) || this.companyEnvironments()[0]);
      $("#environments-dialog").dataset.companyScoped = String(Boolean(companyId));
      companyContext($("#environments-dialog"), this.state.companies || [], this.settingsCompanyId);
      $("#environment-company-filter").closest("label").hidden = Boolean(companyId);
      $("#environments-dialog").showModal();
    }
    catch (error) { if (revision === this.environmentOpenRevision && validWhile()) this.toast(error.message); }
  }
  discardEnvironmentEdits() { return !this.environmentSaving && (!this.environmentDirty() || confirm("Discard unsaved environment changes?")); }
  captureEnvironmentFields() {
    if (!this.draft) return;
    Object.assign(this.draft, { name: $("#environment-name").value, variablesEnabled: $("#variables-enabled").checked,
      setupScript: $("#environment-setup-script").value, archived: $("#environment-archived").checked,
      ciMonitoring: { notifyFailures: $("#environment-ci-notify-failures").checked, wakePassing: $("#environment-ci-wake-passing").checked },
      ...(this.draft.backend === "ec2" ? { instanceType: $("#environment-instance-type").value || this.defaultInstanceType } : {}) });
  }
  environmentDirty() { this.captureEnvironmentFields(); return Boolean(this.draft && this.environmentBaseline !== JSON.stringify(this.draft)); }
  updateEnvironmentDirty() {
    $("#save-environment").disabled = Boolean(this.environmentSaving) || !this.environmentDirty();
    if (!this.draft) return;
    $("#environment-software-summary").textContent = `${this.draft.software.length} selected`;
    $("#environment-variables-summary").textContent = this.draft.variablesEnabled ? `${this.draft.variables.length} ${this.draft.variables.length === 1 ? "variable" : "variables"}` : "Disabled";
    $("#environment-setup-summary").textContent = this.draft.setupScript.trim() ? "Startup script configured" : "No startup script";
    const profile = this.browserProfiles?.find(item => item.id === this.draft.browserProfileId);
    const attention = (profile?.sessions || []).filter(session => loginState(session).level !== "valid").length;
    $("#environment-browser-summary").textContent = profile ? `${profile.name} · v${profile.currentVersion}${attention ? ` · ${attention} sign-in${attention === 1 ? "" : "s"} to renew` : ""}` : "Empty profile";
  }
  renderBrowserProfiles() {
    if (!this.draft) return;
    const companyId = environmentCompany(this.draft), select = $("#environment-browser-profile");
    const profiles = (this.browserProfiles || []).filter(profile => profile.companyId === companyId);
    select.replaceChildren(option("", "None · empty profile"), ...profiles.map(profile => option(profile.id, `${profile.name} · v${profile.currentVersion}`)));
    select.value = profiles.some(profile => profile.id === this.draft.browserProfileId) ? this.draft.browserProfileId : "";
    const selected = profiles.find(profile => profile.id === select.value);
    const details = $("#environment-browser-details");
    details.replaceChildren(el("p", "", !selected ? "Chats start with an empty browser profile."
      : !selected.currentVersion ? "No version yet. Upload an archive, or sign in from a chat’s Browser panel and choose “Save to profile”."
      : `Version ${selected.currentVersion} · ${selected.versions.at(-1).source === "chat" ? "saved from a chat" : "uploaded"} ${new Date(selected.versions.at(-1).createdAt).toLocaleString()} · Chrome ${selected.chromeVersion || "unknown"}`));
    if (selected?.sessions?.length) {
      const list = el("ul", "browser-profile-sessions");
      for (const session of selected.sessions) {
        const state = loginState(session), item = el("li", `browser-profile-session ${state.level}`);
        item.append(el("strong", "", session.site), el("span", "", ` · ${state.text}`));
        item.title = session.cookie ? `Longest-lived login cookie: ${session.cookie}` : "";
        list.append(item);
      }
      if (selected.refresh) details.append(el("p", `browser-profile-refresh-status ${selected.refresh.status}`, `Last renewal ${new Date(selected.refresh.at).toLocaleString()}: ${{ running: "in progress", renewed: `renewed as version ${selected.refresh.version}`, "needs-sign-in": "sign in again", skipped: "skipped", failed: "failed" }[selected.refresh.status] || selected.refresh.status}${selected.refresh.message && selected.refresh.status !== "renewed" ? ` — ${selected.refresh.message}` : ""}`));
      details.append(el("p", "muted", "Sign-ins saved in this version. They are renewed automatically every day. A site can still end a session earlier; sign in again from a chat’s Browser panel and choose “Save to profile” to refresh the snapshot."), list);
    }
    $("#browser-profile-upload").disabled = $("#browser-profile-delete").disabled = !selected;
    $("#browser-profile-refresh").disabled = !selected?.currentVersion || selected?.refresh?.status === "running";
    $("#browser-profile-create").disabled = !companyId;
  }
  async browserProfileAction(action) {
    const error = $("#environment-error"); error.textContent = "";
    const selected = $("#environment-browser-profile").value, file = $("#browser-profile-file").files[0];
    const archive = async () => {
      if (!file) return null;
      const data = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(reader.error); reader.readAsDataURL(file); });
      return String(data).replace(/^data:[^,]*,/, "");
    };
    try {
      if (action === "refresh") {
        await this.api(`/api/browser-profiles/${selected}/refresh`, { method: "POST", body: "{}" });
        $("#environment-save-status").textContent = "Renewal started on a private worker; it takes a few minutes.";
        this.browserProfiles = (await this.api("/api/browser-profiles")).profiles; this.renderBrowserProfiles();
        return;
      }
      if (action === "delete") {
        if (!confirm("Delete this browser profile and all of its versions? Chats that already copied it keep their copies.")) return;
        await this.api(`/api/browser-profiles/${selected}`, { method: "DELETE" });
        if (this.draft.browserProfileId === selected) this.draft.browserProfileId = null;
      } else {
        let id = selected;
        if (action === "create") {
          const name = $("#browser-profile-name").value.trim();
          if (!name) { $("#browser-profile-name").focus(); throw new Error("Name the new browser profile"); }
          id = (await this.api("/api/browser-profiles", { method: "POST", body: JSON.stringify({ name, companyId: environmentCompany(this.draft) }) })).profile.id;
          this.draft.browserProfileId = id; $("#browser-profile-name").value = "";
        }
        const data = await archive();
        if (action === "upload" && !data) throw new Error("Choose a profile archive to upload");
        if (data) await this.api(`/api/browser-profiles/${id}/versions`, { method: "POST", body: JSON.stringify({ archive: data }) });
        $("#browser-profile-file").value = "";
      }
      this.browserProfiles = (await this.api("/api/browser-profiles")).profiles;
      this.renderBrowserProfiles(); this.updateEnvironmentDirty();
      $("#environment-save-status").textContent = action === "delete" ? "Browser profile deleted" : "Browser profile saved · save the environment to use it";
    } catch (failure) { error.textContent = failure.message; this.browserProfiles = (await this.api("/api/browser-profiles").catch(() => ({ profiles: this.browserProfiles }))).profiles; this.renderBrowserProfiles(); }
  }
  showEnvironmentSection(section = null) {
    $("#environment-overview").hidden = Boolean(section); $("#environment-editor-heading").hidden = !section;
    const titles = { software: "Installed software", variables: "Environment variables", setup: "Setup script", browser: "Browser profile" };
    for (const id of Object.keys(titles)) $("#environment-" + id + "-editor").hidden = id !== section;
    $("#environment-editor-title").textContent = titles[section] || "";
    this.updateEnvironmentDirty();
  }
  editEnvironment(environment) {
    this.draft = structuredClone(environment || { name: "", backend: this.state.config.workerBackend, ...(this.state.config.workerBackend === "ec2" ? { instanceType: this.defaultInstanceType || "t3.medium" } : {}), variablesEnabled: true, variables: [], software: [], ciMonitoring: { notifyFailures: true, wakePassing: true }, ...(this.settingsCompanyId && this.settingsCompanyId !== "__review__" ? { companies: [this.settingsCompanyId], allowUnassigned: false } : {}) });
    this.draft.ciMonitoring ||= { notifyFailures: true, wakePassing: true };
    $("#environment-error").textContent = "";
    $("#environment-save-status").textContent = "";
    const companies = (this.state.companies || []).map(company => company.id);
    const filter = $("#environment-company-filter");
    filter.replaceChildren(...companies.map(id => option(id, this.state.companies?.find(company => company.id === id)?.name || id)));
    if (!companies.length || this.settingsCompanyId === "__review__" || this.environments.some(env => env.scopeNeedsReview || !environmentCompany(env))) filter.append(option("__review__", "Needs company assignment"));
    filter.value = this.settingsCompanyId || "";
    const select = $("#environment-editor-select");
    select.replaceChildren(...this.companyEnvironments().map(env => option(env.id, `${env.name}${env.archived ? " · Archived" : ""}`)));
    if (!environment) select.append(option("", "New environment"));
    select.value = environment?.id || "";
    $("#environment-advanced").open = false;
    $("#environment-name").value = this.draft.name;
    const companySelect = $("#environment-company");
    companySelect.replaceChildren(option("", "Choose one company"), ...(this.state.companies || []).map(company => option(company.id, company.name || company.id)));
    companySelect.value = this.draft.scopeNeedsReview ? "" : environmentCompany(this.draft) || "";
    companySelect.disabled = Boolean(this.environmentScopedCompanyId);
    $("#environment-company-review").hidden = !this.draft.scopeNeedsReview;
    this.renderEnvironmentMcps();
    $("#environment-setup-script").value = this.draft.setupScript || "";
    $("#environment-ci-notify-failures").checked = this.draft.ciMonitoring.notifyFailures;
    $("#environment-ci-wake-passing").checked = this.draft.ciMonitoring.wakePassing;
    $("#environment-archived").checked = Boolean(this.draft.archived);
    $("#environment-backend").textContent = `Worker: ${this.draft.backend} · changes apply on the next worker start`;
    const harness = this.draft.harnessUpdate;
    const version = (installed, latest) => installed ? `${installed}${latest && latest !== installed ? ` → ${latest}` : ""}` : latest ? `pending → ${latest}` : "not checked";
    $("#environment-harness-status").textContent = !this.draft.id ? "Harness updates · checked on first worker start"
      : `Harness updates · ${harness?.status || "not checked"} · Codex ${version(harness?.installed?.codex, harness?.latest?.codex)} · Claude ${version(harness?.installed?.claude, harness?.latest?.claude)}${harness?.error ? ` · ${harness.error}` : ""}`;
    const instanceField = $("#environment-instance-type-field"), instanceSelect = $("#environment-instance-type");
    instanceField.hidden = this.draft.backend !== "ec2";
    const instances = this.instances || [];
    instanceSelect.replaceChildren(...instances.map(instance => option(instance.id, instanceLabel(instance))));
    instanceSelect.value = this.draft.instanceType || this.defaultInstanceType || instances[0]?.id || "";
    if (this.draft.backend === "ec2") this.draft.instanceType = instanceSelect.value;
    this.renderInstancePrice();
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
    this.draft.browserProfileId ??= null; this.renderBrowserProfiles();
    this.captureEnvironmentFields(); this.environmentBaseline = JSON.stringify(this.draft); this.showEnvironmentSection();
  }
  renderInstancePrice() {
    const selected = this.instances?.find(instance => instance.id === $("#environment-instance-type").value);
    const region = this.instanceRegion === this.instancePricingRegion ? this.instanceRegion || "configured region" : `${this.instancePricingRegion} reference price`;
    $("#environment-instance-price").textContent = selected ? `$${selected.usdPerHour.toFixed(4)}/hour · ${region}${selected.burstable ? " · CPU credits may add cost under sustained load" : " · sustained performance"}` : "";
  }
  renderEnvironmentMcps() {
    if (this.state.config?.features?.companyMcpConnections) {
      const allowed = this.mcps.filter(connection => connection.companyId && environmentAllows(this.draft, connection.companyId));
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
      if (!environmentCompany(this.draft) || !this.state.companies?.some(company => company.id === environmentCompany(this.draft))) throw new Error("Choose one registered company before saving this environment.");
      if (this.environmentScopedCompanyId && environmentCompany(this.draft) !== this.environmentScopedCompanyId) throw new Error("This editor belongs to another company. Reopen the environment in its company settings.");
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
