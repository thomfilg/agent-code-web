const catalogs = new Map();
const option = (value, text) => { const el = document.createElement("option"); el.value = value; el.textContent = text; return el; };
export class ModelPicker {
  constructor({ root, api, onChange }) {
    Object.assign(this, { root, api, onChange }); this.version = 0;
    this.model = root.querySelector(".model-select"); this.effort = root.querySelector(".effort-select"); this.note = root.querySelector(".model-note");
    this.model.addEventListener("change", () => { this.renderEfforts(); this.changed(); });
    this.effort.addEventListener("change", () => this.changed());
  }
  value() { return { model: this.model.value || null, effort: this.effort.value || null }; }
  async setAgent(agent, selected = {}) {
    const key = JSON.stringify([agent, selected.model || null, selected.effort || null]);
    if (this.key === key || this.busy) return;
    this.key = key; this.agent = agent; const version = ++this.version;
    this.root.hidden = agent === "mock";
    this.model.replaceChildren(option("", "Loading models…")); this.model.disabled = true; this.effort.disabled = true;
    this.effort.replaceChildren(option("", "Default effort")); this.note.textContent = "";
    if (agent === "mock") return;
    try {
      if (!catalogs.has(agent)) catalogs.set(agent, this.api(`/api/models?agent=${agent}`).catch(error => { catalogs.delete(agent); throw error; }));
      const catalog = await catalogs.get(agent); if (version !== this.version) return;
      this.catalog = catalog;
      const defaultModel = catalog.configuredDefault || catalog.models.find(model => model.isDefault)?.label;
      this.model.replaceChildren(option("", defaultModel ? `Default · ${defaultModel}` : "Account default"), ...catalog.models.map(model => option(model.id, model.label)));
      if (selected.model && !catalog.models.some(model => model.id === selected.model)) this.model.append(option(selected.model, `${selected.model} (saved; unavailable)`));
      this.model.value = selected.model || "";
      this.renderEfforts(selected.effort);
      this.model.disabled = false; this.note.textContent = catalog.note;
    } catch (error) { if (version === this.version) { this.model.replaceChildren(option("", "Default model")); this.note.textContent = error.message; this.key = null; } }
  }
  renderEfforts(selected = this.effort.value) {
    const model = this.catalog?.models.find(item => item.id === (this.model.value || this.catalog.configuredDefault)) || (!this.model.value ? this.catalog?.models.find(item => item.isDefault) : null);
    const levels = model?.efforts || (this.agent === "claude" && !this.model.value ? this.catalog?.models.find(item => item.id === "opus")?.efforts : []) || [];
    this.effort.replaceChildren(option("", !levels.length ? "Not supported" : model?.defaultEffort ? `Default · ${model.defaultEffort}` : "Default effort"), ...levels.map(level => option(level, level === "xhigh" ? "Extra high" : level[0].toUpperCase() + level.slice(1))));
    this.effort.value = levels.includes(selected) ? selected : "";
    this.effort.disabled = !levels.length;
    this.note.textContent = this.catalog?.note || "";
  }
  changed() {
    const value = this.value(); this.key = JSON.stringify([this.agent, value.model, value.effort]);
    this.busy = true; this.model.disabled = true; this.effort.disabled = true;
    this.saving = Promise.resolve(this.onChange(value)).catch(error => { this.note.textContent = `Not saved: ${error.message}`; this.key = null; throw error; }).finally(() => { this.busy = false; this.model.disabled = false; this.effort.disabled = this.effort.options.length <= 1; });
    this.saving.catch(() => {});
  }
}
