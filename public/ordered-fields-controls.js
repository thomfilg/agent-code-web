const node = (tag, text, className) => { const element = document.createElement(tag); if (text !== undefined) element.textContent = text; if (className) element.className = className; return element; };
const button = (text, action) => { const element = node("button", text); element.type = "button"; element.onclick = action; return element; };
export class OrderedFieldsControls {
  constructor({ api, controls, notify, getChat }, options) {
    Object.assign(this, { api, controls, notify, getChat, options }); this.snapshot = { items: [...this.options.defaults] }; this.identityVersion = 0; this.loadVersion = 0;
  }
  resetIdentity() { this.identityVersion++; this.loadVersion++; this.snapshot = { items: [...this.options.defaults] }; this.preview = null; }
  async load() {
    const version = ++this.loadVersion, identity = this.identityVersion, result = await this.api(`/api/${this.options.id}`);
    if (version !== this.loadVersion || identity !== this.identityVersion) return null;
    this.snapshot = { ...result, items: this.options.validate(result.items) }; this.render(); return this.snapshot;
  }
  render() { this.preview?.(); }
  async open() {
    const { name, adjective } = this.options;
    const identity = this.identityVersion, status = node("p", `Loading ${adjective} settings…`, "muted"), scope = node("p", "", "muted"); status.setAttribute("role", "status");
    const preview = node("div", undefined, "statusline-preview"), rows = node("div", undefined, "statusline-rows"); preview.setAttribute("aria-label", this.options.previewLabel);
    const save = button(`Save ${name}`, () => void persist());
    const defaults = button("Restore defaults", () => { draft = [...this.options.defaults]; edit(); });
    const hide = button(this.options.hideLabel, () => { draft = []; edit(); });
    const reload = button(`Reload ${name}`, () => { if (!dirty || confirm(`Discard unsaved ${adjective} edits and reload?`)) void refresh(); });
    const panel = node("div", undefined, "statusline-settings"), about = node("details", undefined, "statusline-about"), actions = node("div", undefined, "statusline-actions");
    save.className = "primary-button";
    about.append(node("summary", "About these fields"), node("p", this.options.about, "muted"));
    actions.append(save, defaults, hide, reload);
    panel.append(node("p", "Choose fields, then drag selected rows or use the arrows to reorder. Save to apply.", "muted"), scope, about, preview, rows, status, actions);
    this.controls.dialog(this.options.title, panel);
    const version = this.controls.dialogVersion, dialog = document.querySelector("#controls-dialog");
    const current = () => dialog.open && this.controls.dialogVersion === version && identity === this.identityVersion;
    let snapshot = null, draft = [], dirty = false, pending = false, dragging = null;
    this.preview = () => { if (current() && snapshot) this.draw(preview, draft); };
    const edit = focus => { dirty = true; status.textContent = `Unsaved ${adjective} changes. Save to apply.`; render(); if (focus) rows.querySelector(focus)?.focus(); };
    const move = (id, index) => { if (pending || !current() || !draft.includes(id) || index < 0 || index >= draft.length) return; draft.splice(draft.indexOf(id), 1); draft.splice(index, 0, id); edit(`[data-id="${id}"] input`); };
    const render = () => {
      if (!current()) return;
      save.disabled = pending || !snapshot || !dirty; defaults.disabled = hide.disabled = pending || !snapshot; reload.disabled = pending; rows.replaceChildren(); this.preview();
      if (!snapshot) return;
      const ordered = [...draft, ...this.options.items.map(item => item.id).filter(id => !draft.includes(id))];
      for (const id of ordered) {
        const item = this.options.items.find(item => item.id === id), index = draft.indexOf(id), selected = index >= 0;
        const row = node("section", undefined, "statusline-row"), check = node("input"), label = node("label"), description = node("small", item.help, "muted");
        row.dataset.id = id; check.type = "checkbox"; check.checked = selected; check.disabled = pending; check.setAttribute("aria-label", `Show ${item.label}`);
        check.onchange = () => { draft = check.checked ? [...draft, id] : draft.filter(value => value !== id); edit(`[data-id="${id}"] input`); };
        label.append(check, node("span", item.label)); description.id = `${this.options.id}-help-${id}`; check.setAttribute("aria-describedby", description.id);
        row.append(label, description);
        if (selected) {
          const actions = node("div", undefined, "statusline-row-actions");
          for (const [offset, glyph, direction] of [[-1, "↑", "up"], [1, "↓", "down"]]) {
            const control = button(glyph, () => move(id, index + offset)); control.setAttribute("aria-label", `Move ${item.label} ${direction}`); control.disabled = pending || index + offset < 0 || index + offset >= draft.length; actions.append(control);
          }
          const handle = node("span", "⠿", "statusline-drag"); handle.draggable = !pending; handle.title = `Drag ${item.label} to reorder`; handle.setAttribute("aria-hidden", "true"); actions.prepend(handle); row.append(actions);
          handle.ondragstart = event => { if (pending) { event.preventDefault(); return; } dragging = id; event.dataTransfer.setData("text/plain", id); event.dataTransfer.effectAllowed = "move"; };
          handle.ondragend = () => { dragging = null; };
          row.ondragover = event => { if (dragging && !pending) { event.preventDefault(); event.dataTransfer.dropEffect = "move"; } };
          row.ondrop = event => { if (!dragging || pending) return; event.preventDefault(); const source = dragging; dragging = null; move(source, index); };
        }
        rows.append(row);
      }
    };
    const refresh = async () => {
      if (!current() || pending) return; pending = true; status.textContent = `Loading saved ${adjective} settings…`; render();
      try {
        const result = await this.load(); if (!current() || !result) return;
        snapshot = result; draft = [...result.items]; dirty = false;
        scope.textContent = result.account ? `Saved for your Relay account: ${result.account.username}.` : "No private Relay account is signed in. Preferences are shared by this Relay installation; sign in for separate account preferences.";
        status.textContent = `Saved ${name} loaded. Nothing has changed.`;
      } catch (error) { if (current()) status.textContent = error.message; }
      finally { pending = false; render(); }
    };
    const persist = async () => {
      if (!current() || pending || !snapshot || !dirty) return;
      pending = true; this.loadVersion++; status.textContent = `Saving ${name}…`; render();
      try {
        const result = await this.api(`/api/${this.options.id}`, { method: "PATCH", body: JSON.stringify({ scope: snapshot.scope, revision: snapshot.revision, items: draft }) });
        const items = this.options.validate(result.items);
        if (identity === this.identityVersion && result.scope === this.snapshot.scope && result.revision >= this.snapshot.revision) { this.loadVersion++; this.snapshot = { ...result, items }; this.render(); }
        if (!current()) { this.notify?.(`${this.options.title} saved for the account shown in the original panel.`); return; }
        snapshot = result; draft = items; dirty = false; status.textContent = `${this.options.title} saved and active.`;
      } catch (error) { if (current()) status.textContent = `${error.message} Your ${adjective} draft is retained. Reload to check what was saved before retrying.`; else this.notify?.(error.message); }
      finally { pending = false; render(); }
    };
    render(); await refresh(); return current() && Boolean(snapshot);
  }
}
