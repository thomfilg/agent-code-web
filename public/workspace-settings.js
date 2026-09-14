import { ModelPicker } from "./model-picker.js";
const $ = selector => document.querySelector(selector);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
const option = (value, text) => { const e = el("option", "", text); e.value = value; return e; };
const button = (text, action, cls = "secondary-button") => { const e = el("button", cls, text); e.type = "button"; e.addEventListener("click", action); return e; };

export class WorkspaceSettings {
  constructor({ api, state, toast }) {
    Object.assign(this, { api, state, toast }); this.selected = []; this.environments = []; this.repositories = []; this.branchCache = new Map();
    this.modelPicker = new ModelPicker({ root: $("#new-model-controls"), api, onChange: () => this.remember() });
    $("#github-button").addEventListener("click", () => this.openGitHub());
    $("#connect-github-button").addEventListener("click", () => this.openGitHub());
    $("#github-local").addEventListener("click", event => this.connectGitHub({ method: "local" }, event.target));
    $("#github-token-form").addEventListener("submit", event => { event.preventDefault(); this.connectGitHub({ token: $("#github-token").value, expiresAt: $("#github-expiry").value || null }, event.submitter); });
    $("#github-disconnect").addEventListener("click", async () => { try { await api("/api/github", { method: "DELETE" }); this.repositories = []; this.branchCache.clear(); await this.load(); await this.openGitHub(); } catch (error) { toast(error.message); } });
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
    $("#environment-select").replaceChildren(...this.environments.filter(env => !env.archived).map(env => option(env.id, env.name)));
    if (this.environments.some(env => env.id === selected && !env.archived)) $("#environment-select").value = selected;
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
      const label = el("label", "repository-option"); const input = el("input"); input.type = "checkbox"; input.checked = this.selected.some(item => item.fullName === repo.fullName);
      input.addEventListener("change", () => {
        if (input.checked) this.selected.push({ fullName: repo.fullName, branch: repo.defaultBranch });
        else this.selected = this.selected.filter(item => item.fullName !== repo.fullName);
        this.renderSelected(); this.remember();
      });
      label.append(input, el("span", "", repo.fullName), el("small", "", repo.private ? "Private" : "Public")); results.append(label);
    }
    if (!results.childElementCount) results.append(el("p", "muted", "No matching repositories. Check account permissions or refresh the list."));
  }
  renderSelected() {
    const container = $("#selected-repositories"); container.replaceChildren();
    for (const [index, repo] of this.selected.entries()) {
      const chip = el("div", "repository-chip"); chip.append(el("span", "", `${index === 0 ? "① " : ""}${repo.fullName}`));
      const branch = el("select"); branch.setAttribute("aria-label", `Branch for ${repo.fullName}`); branch.append(option(repo.branch, repo.branch));
      const loadBranches = async () => {
        try {
          const branches = this.branchCache.get(repo.fullName) || (await this.api(`/api/github/branches?repository=${encodeURIComponent(repo.fullName)}`)).branches;
          this.branchCache.set(repo.fullName, branches);
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
    const selection = $("#new-chat-dialog").open ? { agent: $("#agent-select").value, ...this.modelPicker.value() } : { agent: this.preferences.agent || $("#agent-select").value, model: this.preferences.model || null, effort: this.preferences.effort || null };
    const body = { ...selection, environmentId: $("#environment-select").value, repositories: structuredClone(this.selected) };
    this.preferenceQueue = (this.preferenceQueue || Promise.resolve()).catch(() => {}).then(() => this.api("/api/preferences", { method: "PATCH", body: JSON.stringify(body) }));
    try { await this.preferenceQueue; this.preferences = body; } catch (error) { this.toast(`Could not remember your selection: ${error.message}`); }
  }
  async openGitHub() {
    try {
      this.github = await this.api("/api/github");
      $("#github-status").textContent = this.github.connected ? `Connected as ${this.github.login}${this.github.expiresAt ? ` until ${new Date(this.github.expiresAt).toLocaleString()}` : ". No expiration reported; revocation is detected on the next GitHub request."}` : "Connect your account to select repositories. Your credential stays in encrypted PostgreSQL records, outside agent environments.";
      $("#github-local").hidden = !this.github.localAvailable; $("#github-oauth").hidden = !this.github.oauthAvailable; $("#github-disconnect").hidden = !this.github.connected;
      $("#github-error").textContent = ""; $("#github-device-code").textContent = "";
      if (!$("#github-dialog").open) $("#github-dialog").showModal();
    } catch (error) { this.toast(error.message); }
  }
  async connectGitHub(body, submitter) {
    submitter.disabled = true; $("#github-error").textContent = "";
    try { await this.api("/api/github", { method: "POST", body: JSON.stringify(body) }); $("#github-token").value = ""; this.branchCache.clear(); await this.load(); if ($("#new-chat-dialog").open) await this.loadRepositories(); $("#github-dialog").close(); }
    catch (error) { $("#github-error").textContent = error.message; }
    finally { submitter.disabled = false; }
  }
  async startDevice() {
    try {
      clearTimeout(this.deviceTimer);
      const flow = await this.api("/api/github/device", { method: "POST", body: "{}" });
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
    this.draft.mcpIds ||= [];
    $("#environment-mcp-options").replaceChildren(...this.mcps.map(connection => {
      const label = el("label", "checkbox-label"), input = el("input"); input.type = "checkbox"; input.checked = this.draft.mcpIds.includes(connection.id);
      input.onchange = () => { this.draft.mcpIds = input.checked ? [...this.draft.mcpIds, connection.id] : this.draft.mcpIds.filter(id => id !== connection.id); };
      label.append(input, el("span", "", `${connection.name} · ${connection.type}`)); return label;
    }));
    if (!this.mcps.length) $("#environment-mcp-options").append(el("p", "muted", "No saved connections. Add an MCP from the sidebar first."));
    $("#environment-setup-script").value = this.draft.setupScript || "";
    $("#environment-archived").checked = Boolean(this.draft.archived);
    $("#environment-backend").textContent = `Worker: ${this.draft.backend} · changes apply on the next worker start`;
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
    this.draft.setupScript = $("#environment-setup-script").value; this.draft.archived = $("#environment-archived").checked;
    try {
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
}
