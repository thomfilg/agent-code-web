const node = (tag, text, className) => { const item = document.createElement(tag); if (text !== undefined) item.textContent = text; if (className) item.className = className; return item; };

export class CompanyPluginSettings {
  constructor({ api }) {
    this.api = api;
    this.dialog = document.createElement("dialog"); this.dialog.id = "company-plugins-dialog"; this.dialog.setAttribute("aria-labelledby", "company-plugins-title");
    this.dialog.innerHTML = `<div class="dialog-card company-plugins-card">
      <div class="dialog-heading"><div><h2 id="company-plugins-title">Plugins</h2><p id="company-plugins-company" class="muted"></p></div><button type="button" class="icon-button" aria-label="Close plugins">×</button></div>
      <p class="form-error" role="alert"></p>
      <section id="company-plugins-overview"><p class="muted">Install trusted marketplaces before a chat starts. Each company chooses independently which plugins Claude and Codex receive.</p><div id="company-plugin-list"></div><button type="button" class="secondary-button" id="company-plugin-add">+ Add marketplace</button></section>
      <form id="company-plugin-form" hidden>
        <label><span>Public GitHub marketplace</span><div class="company-plugin-source-row"><input name="source" required placeholder="owner/repository" autocomplete="off" spellcheck="false"><button type="button" class="secondary-button" id="company-plugin-inspect">Load plugins</button></div><small>Relay uses HTTPS and never copies your GitHub credentials into a worker.</small></label>
        <div id="company-plugin-selection"></div>
        <p class="muted company-plugin-hook-note">Claude trusts installed hooks automatically. Codex skills are available immediately; review Codex hooks once from Agents → Hooks after starting a chat.</p>
        <div class="company-plugin-footer"><button type="button" class="danger" id="company-plugin-delete" hidden>Remove marketplace</button><span id="company-plugin-status" class="muted" role="status"></span><button type="button" class="secondary-button" id="company-plugin-back">Cancel</button><button type="submit" class="primary-button" disabled>Save</button></div>
      </form>
    </div>`;
    document.body.append(this.dialog);
    this.overview = this.dialog.querySelector("#company-plugins-overview"); this.form = this.dialog.querySelector("form"); this.selection = this.dialog.querySelector("#company-plugin-selection");
    this.dialog.querySelector("[aria-label='Close plugins']").onclick = () => { if (this.discard()) this.dialog.close(); };
    this.dialog.addEventListener("cancel", event => { if (!this.discard()) event.preventDefault(); });
    this.dialog.addEventListener("close", () => { this.revision = (this.revision || 0) + 1; this.current = null; this.snapshot = null; this.form.hidden = true; this.overview.hidden = false; });
    this.dialog.querySelector("#company-plugin-add").onclick = () => this.edit();
    this.dialog.querySelector("#company-plugin-back").onclick = () => { if (this.discard()) this.showOverview(); };
    this.dialog.querySelector("#company-plugin-inspect").onclick = () => this.inspect();
    this.dialog.querySelector("#company-plugin-delete").onclick = () => this.remove();
    this.form.onsubmit = event => this.save(event);
    this.form.oninput = this.form.onchange = () => this.actions();
  }
  error(message = "") { this.dialog.querySelector("[role=alert]").textContent = message; }
  status(message = "") { this.dialog.querySelector("#company-plugin-status").textContent = message; }
  async open(company, options = {}) {
    this.company = company; this.validWhile = options.validWhile || (() => true); this.error(); this.status();
    this.dialog.querySelector("#company-plugins-company").textContent = company.name;
    if (!this.dialog.open) this.dialog.showModal();
    await this.load();
  }
  async load() {
    const revision = this.revision = (this.revision || 0) + 1; this.busy = true; this.lock(); this.error();
    try {
      const { marketplaces } = await this.api(`/api/company-plugins?companyId=${encodeURIComponent(this.company.id)}`);
      if (revision !== this.revision || !this.validWhile()) return;
      this.marketplaces = marketplaces; this.showOverview();
    } catch (error) { if (revision === this.revision) this.error(error.message); }
    finally { if (revision === this.revision) { this.busy = false; this.lock(); } }
  }
  lock() { for (const control of this.dialog.querySelectorAll("button,input")) control.disabled = Boolean(this.busy); this.actions(); }
  showOverview() {
    this.current = null; this.snapshot = null; this.form.hidden = true; this.overview.hidden = false; this.status();
    const list = this.dialog.querySelector("#company-plugin-list");
    list.replaceChildren(...this.marketplaces.map(marketplace => {
      const card = node("button", undefined, "company-plugin-marketplace"); card.type = "button";
      const claude = marketplace.targets.claude.length, codex = marketplace.targets.codex.length;
      card.append(node("strong", marketplace.marketplace.name), node("span", marketplace.source, "muted"), node("small", `${claude} for Claude · ${codex} for Codex`, "muted"));
      card.onclick = () => this.edit(marketplace); return card;
    }));
    if (!this.marketplaces.length) list.append(node("p", "No company plugins installed yet.", "muted"));
  }
  edit(marketplace = null) {
    this.current = marketplace; this.snapshot = marketplace ? { source: marketplace.source, marketplace: marketplace.marketplace, plugins: marketplace.plugins, revision: marketplace.sourceRevision } : null;
    this.overview.hidden = true; this.form.hidden = false; this.error(); this.status();
    this.form.elements.source.value = marketplace?.source || "";
    this.dialog.querySelector("#company-plugin-delete").hidden = !marketplace;
    this.renderSelection(); this.actions(); this.form.elements.source.focus();
  }
  async inspect() {
    if (this.busy) return;
    this.busy = true; this.lock(); this.error(); this.status("Reading the public marketplace…");
    try {
      const { marketplace } = await this.api("/api/company-plugins/inspect", { method: "POST", body: JSON.stringify({ source: this.form.elements.source.value }) });
      this.snapshot = marketplace; this.form.elements.source.value = marketplace.source; this.renderSelection(true); this.status(`Loaded ${marketplace.plugins.length} plugins from ${marketplace.marketplace.name}.`);
    } catch (error) { this.snapshot = null; this.selection.replaceChildren(); this.error(error.message); this.status(); }
    finally { this.busy = false; this.lock(); }
  }
  selected(provider) { return [...this.selection.querySelectorAll(`input[data-provider="${provider}"]:checked`)].map(input => input.value).sort(); }
  renderSelection(reset = false) {
    this.selection.replaceChildren();
    if (!this.snapshot) { this.selection.append(node("p", "Load a marketplace to choose its plugins.", "muted")); return; }
    const heading = node("div", undefined, "company-plugin-columns"); heading.append(node("strong", "Plugin"), node("strong", "Claude"), node("strong", "Codex")); this.selection.append(heading);
    for (const plugin of this.snapshot.plugins) {
      const row = node("section", undefined, "company-plugin-row"), detail = node("div");
      detail.append(node("strong", plugin.name), node("span", plugin.description || `Version ${plugin.version || "not specified"}`, "muted")); row.append(detail);
      for (const provider of ["claude", "codex"]) {
        const label = node("label", undefined, "company-plugin-provider"), input = node("input"); input.type = "checkbox"; input.value = plugin.name; input.dataset.provider = provider;
        input.checked = reset ? true : Boolean(this.current?.targets[provider].includes(plugin.name)); input.setAttribute("aria-label", `Install ${plugin.name} for ${provider === "claude" ? "Claude" : "Codex"}`); label.append(input); row.append(label);
      }
      this.selection.append(row);
    }
  }
  draft() { return { source: this.form.elements.source.value.trim().replace(/^https:\/\/github\.com\//i, "").replace(/\.git\/?$/i, ""), targets: { claude: this.selected("claude"), codex: this.selected("codex") } }; }
  dirty() {
    if (!this.snapshot) return false;
    const draft = this.draft(), old = this.current ? { source: this.current.source, targets: this.current.targets } : { source: this.snapshot.source, targets: { claude: [], codex: [] } };
    return JSON.stringify(draft) !== JSON.stringify(old);
  }
  discard() { return !this.busy && (!this.dirty() || confirm("Discard the unsaved plugin changes?")); }
  actions() {
    if (this.form.hidden) return;
    const selected = this.snapshot && (this.selected("claude").length || this.selected("codex").length);
    this.form.querySelector("[type=submit]").disabled = Boolean(this.busy || !selected || !this.dirty());
    this.dialog.querySelector("#company-plugin-inspect").disabled = Boolean(this.busy || !this.form.elements.source.value.trim());
    this.dialog.querySelector("#company-plugin-delete").disabled = Boolean(this.busy);
  }
  async save(event) {
    event.preventDefault(); if (this.busy || !this.snapshot || !this.dirty()) return;
    this.busy = true; this.lock(); this.error(); this.status("Saving plugin installation…");
    try {
      const input = { companyId: this.company.id, ...this.draft(), ...(this.current ? { revision: this.current.revision } : {}) };
      await this.api(this.current ? `/api/company-plugins/${this.current.id}` : "/api/company-plugins", { method: this.current ? "PATCH" : "POST", body: JSON.stringify(input) });
      window.dispatchEvent(new CustomEvent("relay-company-plugins-changed", { detail: { companyId: this.company.id } }));
      await this.load(); this.dialog.close();
    } catch (error) { this.error(error.message); this.status(); }
    finally { this.busy = false; this.lock(); }
  }
  async remove() {
    if (!this.current || this.busy || !confirm(`Remove ${this.current.marketplace.name} from future ${this.company.name} chats?`)) return;
    this.busy = true; this.lock(); this.error(); this.status("Removing marketplace…");
    try {
      await this.api(`/api/company-plugins/${this.current.id}`, { method: "DELETE" });
      window.dispatchEvent(new CustomEvent("relay-company-plugins-changed", { detail: { companyId: this.company.id } }));
      await this.load(); this.dialog.close();
    }
    catch (error) { this.error(error.message); this.status(); }
    finally { this.busy = false; this.lock(); }
  }
}
