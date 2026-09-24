const catalogs = new Map();
const option = (value, text) => { const el = document.createElement("option"); el.value = value; el.textContent = text; return el; };
const selectionKey = (agent, selected, useDefaults) => JSON.stringify([selected.id || null, selected.ownerId || null, agent, selected.agentAccountId || null, selected.model || null, selected.effort || null, selected.ultracode === true, useDefaults]);
export function modelOptionLabel(model = {}) {
  const label = String(model.label || model.id || "Model");
  const detail = String(model.description || "").split("·")[0].trim();
  if (!detail || !/\b\d+(?:\.\d+)*\b/.test(detail)) return label;
  if (model.id === "default") return `${label} · ${detail}`;
  return detail;
}
export function compactModelLabel(model = {}) {
  const detail = String(model.description || "").split("·")[0].trim();
  const claude = /\b(Opus|Fable|Sonnet|Haiku)\s+\d+(?:\.\d+)*/i.exec(detail || String(model.label || ""));
  if (claude) return claude[0].replace(/^./, character => character.toUpperCase());
  return String(model.label || model.id || "Model").replace(/^Default\s*(?:\(recommended\))?\s*(?:[·:-]\s*)?/i, "") || "Model";
}
export function claudeCatalogMatchesChat(context, chat) {
  // Only named Claude discovery fills the metadata-only command fallback.
  // Do not trigger Codex model probes or shared-host CLI command discovery.
  return Boolean(context.agent === "claude" && context.agentAccountId && chat?.id && context.chatId === chat.id && context.ownerId === (chat.ownerId || null)
    && context.agent === chat.agent && context.agentAccountId === (chat.agentAccountId || null) && context.model === (chat.model || null));
}
export class ModelPicker {
  static clearCatalogs() { catalogs.clear(); }
  constructor({ root, api, onChange, onCatalogReady = () => {} }) {
    Object.assign(this, { root, api, onChange, onCatalogReady }); this.version = 0;
    this.model = root.querySelector(".model-select"); this.compactLabel = root.querySelector(".model-compact-label"); this.effort = root.querySelector(".effort-select"); this.note = root.querySelector(".model-note");
    this.slider = root.querySelector(".effort-slider"); this.effortLabel = root.querySelector(".effort-label");
    this.model.addEventListener("change", () => { this.renderEfforts(); this.changed(); });
    this.effort.addEventListener("change", () => this.changed());
    this.slider?.addEventListener("input", () => { this.effort.value = this.levels[Number(this.slider.value)] || ""; this.syncEffort(); });
    this.slider?.addEventListener("change", () => this.changed());
  }
  value() {
    const ultracode = this.agent === "claude" && this.effort.value === "ultracode";
    return { model: this.model.value || null, effort: ultracode ? "xhigh" : this.effort.value || null, ...(this.agent === "claude" ? { ultracode } : {}) };
  }
  async setAgent(agent, selected = {}, { useDefaults = false } = {}) {
    const key = selectionKey(agent, selected, useDefaults);
    if (this.key === key || this.busy) return;
    this.key = key; this.agent = agent; this.agentAccountId = selected.agentAccountId || null; this.chatId = selected.id || null; this.ownerId = selected.ownerId || null; this.useDefaults = useDefaults; const version = ++this.version;
    const context = { chatId: this.chatId, ownerId: this.ownerId, agent, agentAccountId: this.agentAccountId, model: selected.model || null };
    this.root.dataset.status = "loading";
    this.root.hidden = !agent || agent === "mock";
    this.model.replaceChildren(option("", "Loading models…")); if (this.compactLabel) this.compactLabel.textContent = "Model"; this.model.disabled = true; this.effort.disabled = true;
    this.effort.replaceChildren(option("", "Default effort")); this.note.textContent = "";
    this.syncEffort();
    if (!agent || agent === "mock") return;
    try {
      const catalogKey = `${agent}:${selected.agentAccountId || "legacy"}`;
      if (!catalogs.has(catalogKey)) catalogs.set(catalogKey, this.api(`/api/models?agent=${agent}${selected.agentAccountId ? `&account=${encodeURIComponent(selected.agentAccountId)}` : ""}`).catch(error => { catalogs.delete(catalogKey); throw error; }));
      const catalog = await catalogs.get(catalogKey); if (version !== this.version) return;
      this.catalog = catalog;
      if (useDefaults) selected = { ...selected, model: selected.model || catalog.defaults?.model, effort: selected.effort || catalog.defaults?.effort };
      const defaultModel = catalog.configuredDefault || catalog.models.find(model => model.isDefault)?.id;
      const nativeDefault = agent === "claude" && catalog.models.some(model => model.id === "default");
      const useNativeDefault = nativeDefault && (!defaultModel || defaultModel === "default");
      this.noEnabledModels = catalog.source === "claude-account" && !catalog.models.some(model => model.disabled !== true);
      const configured = catalog.models.find(model => model.id === defaultModel), configuredLabel = configured ? modelOptionLabel(configured) : defaultModel;
      this.model.replaceChildren(...(useNativeDefault || this.noEnabledModels ? [] : [option("", configuredLabel ? `${nativeDefault ? "Configured default" : "Default"} · ${configuredLabel}` : "Account default")]), ...catalog.models.map(model => {
        const el = option(model.id, modelOptionLabel(model) + (model.disabled ? ` — ${model.disabledReason || model.description || "Unavailable"}` : ""));
        el.disabled = model.disabled === true; el.title = model.disabledReason || model.description || ""; return el;
      }));
      if (!catalog.models.length && this.noEnabledModels) { const el = option("", "No available Claude models"); el.disabled = true; this.model.append(el); }
      if (selected.model && !catalog.models.some(model => model.id === selected.model)) { const el = option(selected.model, `${selected.model} (saved; unavailable)`); el.disabled = true; this.model.append(el); }
      this.model.value = selected.model || (useNativeDefault ? "default" : "");
      this.renderEfforts(selected.effort, selected.ultracode === true);
      this.model.disabled = this.noEnabledModels; this.root.dataset.status = "ready";
      this.model.title = `Model · ${selected.model || defaultModel || "Account default"}`;
      this.effort.title = selected.ultracode ? "Ultracode · xhigh + workflows" : `Effort · ${this.effort.value || catalog.configuredDefaultEffort || "Default"}`;
      // Selected-account model discovery also supplies native command metadata.
      // Notify only after this exact selection's result has been accepted.
      this.onCatalogReady(context);
    } catch (error) { if (version === this.version) { this.model.replaceChildren(option("", "Default model")); if (this.compactLabel) this.compactLabel.textContent = "Model"; this.note.textContent = error.message; this.root.dataset.status = "error"; this.key = null; } }
  }
  renderEfforts(selected = this.effort.value, ultracode = false) {
    const model = this.catalog?.models.find(item => item.id === (this.model.value || this.catalog.configuredDefault)) || (!this.model.value ? this.catalog?.models.find(item => item.isDefault) : null);
    const levels = model?.efforts || (this.agent === "claude" && !this.model.value ? this.catalog?.models.find(item => item.id === "opus")?.efforts : []) || [];
    // Auto is a native policy, not the lowest point on an effort scale.
    this.levels = levels.filter(level => level !== "auto");
    const defaultEffort = levels.includes(this.catalog?.configuredDefaultEffort) ? this.catalog.configuredDefaultEffort : model?.defaultEffort;
    this.effort.replaceChildren(option("", !levels.length ? "N/A" : defaultEffort ? `Default · ${defaultEffort}` : "Default"), ...levels.map(level => option(level, level === "xhigh" ? "Extra high" : level[0].toUpperCase() + level.slice(1))));
    this.effort.value = levels.includes(selected) ? selected : "";
    if (this.agent === "claude") {
      const mode = option("ultracode", `Ultracode · xhigh + workflows${model?.ultracode?.supported ? "" : " (unavailable)"}`);
      mode.disabled = model?.ultracode?.supported !== true; mode.title = model?.ultracode?.reason || "Ultracode has not been verified for this account and model.";
      this.effort.append(mode);
      if (ultracode) this.effort.value = "ultracode";
    }
    this.effort.disabled = !levels.length || model?.disabled === true || this.noEnabledModels;
    this.note.textContent = model?.disabled ? model.disabledReason || model.description || "This model is currently unavailable." : this.noEnabledModels ? "No enabled Claude models were reported for this account. Reload to retry." : this.catalog?.note || "";
    if (this.compactLabel) this.compactLabel.textContent = compactModelLabel(model || { label: this.model.options[this.model.selectedIndex]?.textContent });
    if (ultracode) this.note.textContent = model?.ultracode?.reason || "Ultracode has not been verified for this account and model. Choose ordinary effort.";
    this.syncEffort();
  }
  syncEffort() {
    if (!this.slider) return;
    const value = this.effort.value || this.catalog?.configuredDefaultEffort;
    const selected = this.effort.options[this.effort.selectedIndex]?.textContent || "Effort";
    this.effortLabel.textContent = selected.replace(/^Default · /, "");
    this.slider.max = Math.max(0, (this.levels?.length || 0) - 1);
    this.slider.value = Math.max(0, this.levels?.indexOf(value) ?? 0);
    this.slider.hidden = value === "auto" || value === "ultracode" || !this.levels?.length;
    this.slider.disabled = this.effort.disabled || this.slider.hidden;
    const scale = this.root.querySelector(".effort-scale"), autoNote = this.root.querySelector(".effort-auto-note");
    if (scale) scale.hidden = this.slider.hidden;
    if (autoNote) autoNote.hidden = value !== "auto";
  }
  changed() {
    const value = this.value(); this.key = selectionKey(this.agent, { ...value, id: this.chatId, ownerId: this.ownerId, agentAccountId: this.agentAccountId }, this.useDefaults);
    this.note.textContent = value.ultracode ? "Ultracode combines xhigh effort with workflows. The selected worker must confirm both before a message is sent." : this.catalog?.note || "";
    this.busy = true; this.model.disabled = true; this.effort.disabled = true;
    this.syncEffort();
    this.saving = Promise.resolve(this.onChange(value)).then(() => { this.root.dataset.status = "ready"; this.model.title = `Model · ${value.model || "Default"}`; this.effort.title = value.ultracode ? "Ultracode · xhigh + workflows" : `Effort · ${value.effort || "Default"}`; }).catch(error => { this.note.textContent = `Not saved: ${error.message}`; this.root.dataset.status = "error"; this.key = null; throw error; }).finally(() => { this.busy = false; this.model.disabled = false; this.effort.disabled = this.effort.options.length <= 1; this.syncEffort(); });
    this.saving.catch(() => {});
  }
}
