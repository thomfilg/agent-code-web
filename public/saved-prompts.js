import { promptAvailable, promptProjectKey, validatePrompts, PROMPT_TEXT_LIMIT } from "./saved-prompts-model.js";

const $ = selector => document.querySelector(selector);
const node = (tag, text, className) => { const value = document.createElement(tag); if (text !== undefined) value.textContent = text; if (className) value.className = className; return value; };
const button = (text, action, className = "secondary-button") => { const value = node("button", text, className); value.type = "button"; value.onclick = action; return value; };
const label = project => `${project.companyId} / ${project.repository}`;

export class SavedPromptPicker {
  constructor({ api, context, toast }) {
    Object.assign(this, { api, context, toast }); this.version = 0; this.editorVersion = 0;
    this.panel = $("#saved-prompts-picker"); this.dialog = $("#saved-prompt-dialog");
    this.triggers = [...document.querySelectorAll("[data-saved-prompts]")];
    for (const trigger of this.triggers) trigger.onclick = () => this.panel.hidden ? this.open(trigger) : this.close(true);
    $("#saved-prompt-add").onclick = () => this.edit();
    $("#saved-prompts-all").onchange = () => this.render();
    $("#saved-prompts-reload").onclick = () => this.open(this.trigger);
    $("#saved-prompt-form").onsubmit = event => { event.preventDefault(); void this.saveEditor(); };
    $("#saved-prompt-cancel").onclick = () => this.dialog.close();
    $("#saved-prompt-close").onclick = () => this.dialog.close();
    $("#saved-prompt-reload").onclick = () => this.reloadEditor();
    $("#saved-prompt-availability").onchange = () => { $("#saved-prompt-projects").hidden = $("#saved-prompt-availability").value !== "projects"; };
    this.dialog.addEventListener("close", () => { this.editorVersion++; this.trigger?.focus({ preventScroll: true }); });
    document.addEventListener("pointerdown", event => { if (!this.panel.hidden && !this.dialog.open && !this.panel.contains(event.target) && !this.triggers.some(trigger => trigger.contains(event.target))) this.close(); });
    document.addEventListener("keydown", event => {
      if (event.key === "Escape" && !this.dialog.open && !this.panel.hidden) { event.preventDefault(); event.stopImmediatePropagation(); this.close(true); }
    }, true);
    window.addEventListener("resize", () => this.position());
    window.addEventListener("relay-new-chat-selection-changed", () => this.sync());
    $("#environment-select").addEventListener("change", () => queueMicrotask(() => this.sync()));
  }
  sync() { if (this.openContext && this.context().key !== this.openContext.key) this.close(); }
  invalidate() { this.close(); this.library = null; this.dialog.close(); this.editorVersion++; }
  busy() { return this.saving?.view === this.version; }
  position() {
    if (this.panel.hidden || !this.trigger?.isConnected) return;
    const rect = this.trigger.getBoundingClientRect(), width = Math.min(360, innerWidth - 24);
    this.panel.style.width = `${width}px`; this.panel.style.left = `${Math.max(12, Math.min(rect.left, innerWidth - width - 12))}px`;
    this.panel.style.bottom = `${Math.max(12, innerHeight - rect.top + 8)}px`;
    this.panel.style.maxHeight = `${Math.max(120, Math.min(420, rect.top - 24))}px`;
  }
  close(focus = false) {
    this.version++; this.panel.hidden = true; this.openContext = null;
    for (const trigger of this.triggers) trigger.setAttribute("aria-expanded", "false");
    if (focus) this.trigger?.focus({ preventScroll: true });
  }
  async open(trigger) {
    const context = this.context(); if (!context.input || context.input.disabled || !trigger) return;
    this.trigger = trigger; this.openContext = context; const version = ++this.version;
    this.panel.hidden = false; trigger.setAttribute("aria-expanded", "true"); this.position();
    $("#saved-prompts-list").replaceChildren(); $("#saved-prompts-status").textContent = "Loading saved prompts…";
    $("#saved-prompt-add").disabled = true; $("#saved-prompts-reload").hidden = true;
    try {
      const result = await this.api("/api/saved-prompts");
      if (version !== this.version || this.context().key !== context.key) return;
      this.library = { ...result, items: validatePrompts(result.items) }; $("#saved-prompts-all").checked = false;
      this.render(); $("#saved-prompt-add").focus({ preventScroll: true });
    } catch (error) {
      if (version !== this.version) return;
      $("#saved-prompts-status").textContent = error.message; $("#saved-prompts-reload").hidden = false;
    }
  }
  render() {
    if (!this.library || this.panel.hidden) return;
    const project = this.context().project, all = $("#saved-prompts-all").checked;
    const visible = this.library.items.filter(item => all || promptAvailable(item, project));
    $("#saved-prompt-add").disabled = this.busy();
    $("#saved-prompts-context").textContent = project ? label(project) : "No project selected · showing all-project prompts";
    $("#saved-prompts-status").textContent = visible.length ? "Click to insert. Nothing is sent automatically." : "No prompts available here. Add one or show all to manage your library.";
    $("#saved-prompts-list").replaceChildren(...visible.map((item, index) => {
      const row = node("li", undefined, "saved-prompt-row"); row.dataset.promptId = item.id;
      const body = node("div", undefined, "saved-prompt-row-main");
      const move = button("⠿", () => {}, "saved-prompt-drag"); move.draggable = true; move.setAttribute("aria-label", `Drag prompt ${index + 1} to reorder`); move.title = "Drag to reorder; use (…) for keyboard move controls";
      move.ondragstart = event => { this.dragged = item.id; event.dataTransfer.setData("application/x-relay-prompt", item.id); event.dataTransfer.effectAllowed = "move"; };
      move.ondragend = () => { this.dragged = null; };
      row.ondragover = event => { if (this.dragged && [...event.dataTransfer.types].includes("application/x-relay-prompt")) { event.preventDefault(); event.dataTransfer.dropEffect = "move"; } };
      row.ondrop = event => { if (!this.dragged || event.dataTransfer.getData("application/x-relay-prompt") !== this.dragged) return; event.preventDefault(); const from = this.dragged; this.dragged = null; void this.move(from, item.id); };
      const insert = button(item.text.replace(/\s+/g, " ").trim(), () => this.insert(item), "saved-prompt-insert");
      insert.title = item.text; insert.setAttribute("aria-label", `Insert prompt: ${item.text.slice(0, 100)}`); insert.disabled = this.busy() || !promptAvailable(item, project);
      const actions = node("div", undefined, "saved-prompt-row-actions"); actions.hidden = true;
      const more = button("…", () => { actions.hidden = !actions.hidden; more.setAttribute("aria-expanded", String(!actions.hidden)); }, "small-icon");
      more.setAttribute("aria-label", `Prompt ${index + 1} actions`); more.setAttribute("aria-expanded", "false");
      actions.append(button("Edit", () => this.edit(item)), button("Delete", () => this.remove(item)), button("Move up", () => this.move(item.id, visible[index - 1]?.id)), button("Move down", () => this.move(item.id, visible[index + 1]?.id)));
      actions.children[2].disabled = index === 0 || this.busy(); actions.children[3].disabled = index === visible.length - 1 || this.busy();
      for (const action of [move, more, ...actions.children]) if (this.busy()) action.disabled = true;
      body.append(move, insert, more); row.append(body, node("small", item.availability === "all" ? "All my projects" : `${item.projects.length} selected project${item.projects.length === 1 ? "" : "s"}`, "muted"), actions); return row;
    }));
  }
  insert(item) {
    const current = this.context();
    if (!this.openContext || current.key !== this.openContext.key || !current.input || current.input.disabled || !promptAvailable(item, current.project)) { this.close(); return; }
    if (current.input.maxLength >= 0 && current.input.value.length + item.text.length > current.input.maxLength) { this.toast("This prompt would exceed the message length limit. Shorten the draft first."); return; }
    const cursor = current.input.selectionStart;
    current.input.setRangeText(item.text, cursor, cursor, "end"); current.input.dispatchEvent(new Event("input", { bubbles: true }));
    this.close(); current.input.focus();
  }
  edit(item) {
    if (!this.library || this.busy()) return;
    this.editorVersion++; this.editing = item?.id || null; this.editorScope = this.library.scope;
    $("#saved-prompt-fields").disabled = false;
    $("#saved-prompt-title").textContent = item ? "Edit prompt" : "Add prompt";
    $("#saved-prompt-text").value = item?.text || ""; $("#saved-prompt-text").maxLength = PROMPT_TEXT_LIMIT;
    const project = this.context().project, projects = item?.projects || (project && this.library.projects.some(value => promptProjectKey(value) === promptProjectKey(project)) ? [project] : []);
    $("#saved-prompt-availability").value = item?.availability || (projects.length ? "projects" : "all");
    this.projectChoices(projects);
    $("#saved-prompt-availability").onchange(); $("#saved-prompt-error").textContent = ""; $("#saved-prompt-reload").hidden = true;
    this.dialog.showModal(); $("#saved-prompt-text").focus();
  }
  selectedProjects() { return [...$("#saved-prompt-projects").querySelectorAll("input:checked")].map(check => { const [companyId, repository] = JSON.parse(check.value); return { companyId, repository }; }); }
  projectChoices(projects) {
    const choices = new Map([...this.library.projects, ...projects].map(value => [promptProjectKey(value), value]));
    $("#saved-prompt-projects").replaceChildren(...[...choices.values()].map(value => {
      const line = node("label"), check = node("input"); check.type = "checkbox"; check.value = promptProjectKey(value);
      check.checked = projects.some(project => promptProjectKey(project) === check.value);
      line.append(check, node("span", `${label(value)}${this.library.projects.some(project => promptProjectKey(project) === check.value) ? "" : " · unavailable"}`)); return line;
    }));
    if (!choices.size) $("#saved-prompt-projects").append(node("p", "Select a project in a chat first to make it available here.", "muted"));
  }
  async reloadEditor() {
    const version = this.editorVersion, selected = this.selectedProjects(); $("#saved-prompt-fields").disabled = true;
    try {
      const result = await this.api("/api/saved-prompts");
      if (version !== this.editorVersion || !this.dialog.open) return;
      if (result.scope !== this.editorScope) throw Error("Your account changed. Copy your text and reopen the library in the intended account.");
      this.library = { ...result, items: validatePrompts(result.items) };
      this.projectChoices(selected);
      $("#saved-prompt-error").textContent = "Library reloaded. Your editor text is kept; review it before saving again.";
      $("#saved-prompt-reload").hidden = true;
    } catch (error) { if (version === this.editorVersion) $("#saved-prompt-error").textContent = error.message; }
    finally { if (version === this.editorVersion) $("#saved-prompt-fields").disabled = false; }
  }
  async saveEditor() {
    if (this.busy() || !this.library) return;
    const version = this.editorVersion;
    try {
      if (this.library.scope !== this.editorScope) throw Error("The library account changed. Reopen it before saving.");
      if (this.editing && !this.library.items.some(item => item.id === this.editing)) throw Error("This prompt was deleted in another tab. Copy your text and add a new prompt if needed.");
      const availability = $("#saved-prompt-availability").value;
      const projects = availability === "all" ? [] : this.selectedProjects();
      const item = { id: this.editing || `prompt_${crypto.randomUUID()}`, text: $("#saved-prompt-text").value, availability, projects };
      const items = this.editing ? this.library.items.map(value => value.id === this.editing ? item : value) : [...this.library.items, item];
      $("#saved-prompt-fields").disabled = true;
      await this.save(items);
      if (version === this.editorVersion && this.dialog.open) this.dialog.close();
    } catch (error) {
      if (version === this.editorVersion) { $("#saved-prompt-error").textContent = error.message; $("#saved-prompt-reload").hidden = error.status !== 409 && !/changed|account|another tab/.test(error.message); }
    } finally { if (version === this.editorVersion) $("#saved-prompt-fields").disabled = false; }
  }
  async save(items) {
    validatePrompts(items);
    const operation = { view: this.version, library: this.library, scope: this.library.scope }; this.saving = operation; this.render();
    try {
      const result = await this.api("/api/saved-prompts", { method: "PATCH", body: JSON.stringify({ scope: operation.scope, revision: operation.library.revision, items }) });
      // A committed save remains successful, but its delayed response cannot
      // replace a library loaded after closing, navigating or switching user.
      if (this.version === operation.view && this.library === operation.library && result.scope === operation.scope) this.library = result;
      return result;
    } finally { if (this.saving === operation) this.saving = null; if (this.version === operation.view) this.render(); }
  }
  async remove(item) {
    if (this.busy() || !confirm("Delete this saved prompt? Your composer draft will not change.")) return;
    const view = this.version;
    try { await this.save(this.library.items.filter(value => value.id !== item.id)); }
    catch (error) { if (view === this.version) { this.toast(error.message); $("#saved-prompts-reload").hidden = false; } }
  }
  async move(id, target) {
    if (this.busy() || !target || id === target) return;
    const view = this.version;
    const items = [...this.library.items], from = items.findIndex(item => item.id === id), to = items.findIndex(item => item.id === target);
    if (from < 0 || to < 0) return; items.splice(to, 0, ...items.splice(from, 1));
    try { await this.save(items); if (view === this.version) this.panel.querySelector(`[data-prompt-id="${CSS.escape(id)}"] .saved-prompt-drag`)?.focus(); }
    catch (error) { if (view === this.version) { this.toast(error.message); $("#saved-prompts-reload").hidden = false; } }
  }
}
