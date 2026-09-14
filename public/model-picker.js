const catalogs = new Map();
const option = (value, text) => { const el = document.createElement("option"); el.value = value; el.textContent = text; return el; };
export class ModelPicker {
  constructor({ root, api, onChange }) {
    Object.assign(this, { root, api, onChange }); this.version = 0;
    this.model = root.querySelector(".model-select"); this.effort = root.querySelector(".effort-select"); this.note = root.querySelector(".model-note");
    this.slider = root.querySelector(".effort-slider"); this.effortLabel = root.querySelector(".effort-label");
    this.model.addEventListener("change", () => { this.renderEfforts(); this.changed(); });
    this.effort.addEventListener("change", () => this.changed());
    this.slider?.addEventListener("input", () => { this.effort.value = this.levels[Number(this.slider.value)] || ""; this.syncEffort(); });
    this.slider?.addEventListener("change", () => this.changed());
  }
  value() { return { model: this.model.value || null, effort: this.effort.value || null }; }
  async setAgent(agent, selected = {}, { useDefaults = false } = {}) {
    const key = JSON.stringify([agent, selected.model || null, selected.effort || null, useDefaults]);
    if (this.key === key || this.busy) return;
    this.key = key; this.agent = agent; const version = ++this.version;
    this.root.dataset.status = "loading";
    this.root.hidden = agent === "mock";
    this.model.replaceChildren(option("", "Loading models…")); this.model.disabled = true; this.effort.disabled = true;
    this.effort.replaceChildren(option("", "Default effort")); this.note.textContent = "";
    this.syncEffort();
    if (agent === "mock") return;
    try {
      if (!catalogs.has(agent)) catalogs.set(agent, this.api(`/api/models?agent=${agent}`).catch(error => { catalogs.delete(agent); throw error; }));
      const catalog = await catalogs.get(agent); if (version !== this.version) return;
      this.catalog = catalog;
      if (useDefaults) selected = { model: selected.model || catalog.defaults?.model, effort: selected.effort || catalog.defaults?.effort };
      const defaultModel = catalog.configuredDefault || catalog.models.find(model => model.isDefault)?.label;
      const label = value => this.root.classList.contains("compact-model-controls") ? value.replace(/^GPT-\d+(?:\.\d+)?-/i, "") : value;
      this.model.replaceChildren(option("", defaultModel ? `Default · ${label(defaultModel)}` : "Account default"), ...catalog.models.map(model => option(model.id, label(model.label))));
      if (selected.model && !catalog.models.some(model => model.id === selected.model)) this.model.append(option(selected.model, `${selected.model} (saved; unavailable)`));
      this.model.value = selected.model || "";
      this.renderEfforts(selected.effort);
      this.model.disabled = false; this.note.textContent = catalog.note; this.root.dataset.status = "ready";
      this.model.title = `Model · ${selected.model || defaultModel || "Account default"}`;
      this.effort.title = `Effort · ${this.effort.value || catalog.configuredDefaultEffort || "Default"}`;
    } catch (error) { if (version === this.version) { this.model.replaceChildren(option("", "Default model")); this.note.textContent = error.message; this.root.dataset.status = "error"; this.key = null; } }
  }
  renderEfforts(selected = this.effort.value) {
    const model = this.catalog?.models.find(item => item.id === (this.model.value || this.catalog.configuredDefault)) || (!this.model.value ? this.catalog?.models.find(item => item.isDefault) : null);
    const levels = model?.efforts || (this.agent === "claude" && !this.model.value ? this.catalog?.models.find(item => item.id === "opus")?.efforts : []) || [];
    this.levels = levels;
    const defaultEffort = levels.includes(this.catalog?.configuredDefaultEffort) ? this.catalog.configuredDefaultEffort : model?.defaultEffort;
    this.effort.replaceChildren(option("", !levels.length ? "N/A" : defaultEffort ? `Default · ${defaultEffort}` : "Default"), ...levels.map(level => option(level, level === "xhigh" ? "Extra high" : level[0].toUpperCase() + level.slice(1))));
    this.effort.value = levels.includes(selected) ? selected : "";
    this.effort.disabled = !levels.length;
    this.note.textContent = this.catalog?.note || "";
    this.syncEffort();
  }
  syncEffort() {
    if (!this.slider) return;
    const value = this.effort.value || this.catalog?.configuredDefaultEffort;
    const selected = this.effort.options[this.effort.selectedIndex]?.textContent || "Effort";
    this.effortLabel.textContent = selected.replace(/^Default · /, "");
    this.slider.max = Math.max(0, (this.levels?.length || 0) - 1);
    this.slider.value = Math.max(0, this.levels?.indexOf(value) ?? 0);
    this.slider.disabled = this.effort.disabled;
  }
  changed() {
    const value = this.value(); this.key = JSON.stringify([this.agent, value.model, value.effort]);
    this.busy = true; this.model.disabled = true; this.effort.disabled = true;
    this.syncEffort();
    this.saving = Promise.resolve(this.onChange(value)).then(() => { this.root.dataset.status = "ready"; this.model.title = `Model · ${value.model || "Default"}`; this.effort.title = `Effort · ${value.effort || "Default"}`; }).catch(error => { this.note.textContent = `Not saved: ${error.message}`; this.root.dataset.status = "error"; this.key = null; throw error; }).finally(() => { this.busy = false; this.model.disabled = false; this.effort.disabled = this.effort.options.length <= 1; this.syncEffort(); });
    this.saving.catch(() => {});
  }
}
