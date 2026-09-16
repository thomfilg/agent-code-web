import { STATUS_ITEMS, DEFAULT_STATUS_ITEMS, validateStatusItems, statusItemValue } from "./status-line.js";
const node = (tag, text, className) => { const element = document.createElement(tag); if (text !== undefined) element.textContent = text; if (className) element.className = className; return element; };
const button = (text, action) => { const element = node("button", text); element.type = "button"; element.onclick = action; return element; };
export class StatusLineControls {
  constructor({ api, controls, notify, getChat }) {
    Object.assign(this, { api, controls, notify, getChat }); this.snapshot = { items: [...DEFAULT_STATUS_ITEMS] }; this.identityVersion = 0; this.loadVersion = 0;
    this.root = document.querySelector("#chat-statusline");
  }
  resetIdentity() { this.identityVersion++; this.loadVersion++; this.snapshot = { items: [...DEFAULT_STATUS_ITEMS] }; this.preview = null; this.root.replaceChildren(); this.root.hidden = true; }
  async load() {
    const version = ++this.loadVersion, identity = this.identityVersion, result = await this.api("/api/statusline");
    if (version !== this.loadVersion || identity !== this.identityVersion) return null;
    this.snapshot = { ...result, items: validateStatusItems(result.items) }; this.render(); return this.snapshot;
  }
  draw(root, items) {
    root.replaceChildren();
    for (const id of items) {
      const item = statusItemValue(id, this.getChat() || {}), field = node("span", undefined, `statusline-item${item.unavailable ? " unavailable" : ""}`);
      field.dataset.item = id; field.title = item.title; field.append(node("span", `${item.label}: `, "statusline-label"), node("span", item.value)); root.append(field);
    }
    if (!items.length) root.append(node("span", "Status line hidden", "muted"));
  }
  render() {
    this.root.hidden = !this.getChat() || !this.snapshot.items.length;
    this.draw(this.root, this.snapshot.items);
    if (this.getChat()?.status === "stopped" && this.snapshot.items.length) this.root.append(node("span", "Saved snapshot", "statusline-snapshot"));
    this.preview?.();
  }
  async open() {
    const identity = this.identityVersion, status = node("p", "Loading status-line settings…", "muted"), scope = node("p", "", "muted"); status.setAttribute("role", "status");
    const preview = node("div", undefined, "statusline-preview"), rows = node("div", undefined, "statusline-rows"); preview.setAttribute("aria-label", "Status line preview");
    const save = button("Save status line", () => void persist());
    const defaults = button("Restore defaults", () => { draft = [...DEFAULT_STATUS_ITEMS]; edit(); });
    const hide = button("Hide status line", () => { draft = []; edit(); });
    const reload = button("Reload status line", () => { if (!dirty || confirm("Discard unsaved status-line edits and reload?")) void refresh(); });
    const panel = node("div", undefined, "statusline-settings"), about = node("details", undefined, "statusline-about"), actions = node("div", undefined, "statusline-actions");
    save.className = "primary-button";
    about.append(node("summary", "About these fields"), node("p", "This configures Relay's web footer, not native tui.status_line or config.toml. It never wakes a worker or sends a message. Values use saved worker reports; missing data stays Not reported, and stopped workers show a saved snapshot. Closing without saving leaves the footer unchanged.", "muted"));
    actions.append(save, defaults, hide, reload);
    panel.append(node("p", "Choose fields, then drag selected rows or use the arrows to reorder. Save to apply.", "muted"), scope, about, preview, rows, status, actions);
    this.controls.dialog("Status line", panel);
    const version = this.controls.dialogVersion, dialog = document.querySelector("#controls-dialog");
    const current = () => dialog.open && this.controls.dialogVersion === version && identity === this.identityVersion;
    let snapshot = null, draft = [], dirty = false, pending = false, dragging = null;
    this.preview = () => { if (current() && snapshot) this.draw(preview, draft); };
    const edit = focus => { dirty = true; status.textContent = "Unsaved status-line changes. Save to apply."; render(); if (focus) rows.querySelector(focus)?.focus(); };
    const move = (id, index) => { if (pending || !current() || !draft.includes(id) || index < 0 || index >= draft.length) return; draft.splice(draft.indexOf(id), 1); draft.splice(index, 0, id); edit(`[data-id="${id}"] input`); };
    const render = () => {
      if (!current()) return;
      save.disabled = pending || !snapshot || !dirty; defaults.disabled = hide.disabled = pending || !snapshot; reload.disabled = pending; rows.replaceChildren(); this.preview();
      if (!snapshot) return;
      const ordered = [...draft, ...STATUS_ITEMS.map(item => item.id).filter(id => !draft.includes(id))];
      for (const id of ordered) {
        const item = STATUS_ITEMS.find(item => item.id === id), index = draft.indexOf(id), selected = index >= 0;
        const row = node("section", undefined, "statusline-row"), check = node("input"), label = node("label"), description = node("small", item.help, "muted");
        row.dataset.id = id; check.type = "checkbox"; check.checked = selected; check.disabled = pending; check.setAttribute("aria-label", `Show ${item.label}`);
        check.onchange = () => { draft = check.checked ? [...draft, id] : draft.filter(value => value !== id); edit(`[data-id="${id}"] input`); };
        label.append(check, node("span", item.label)); description.id = `statusline-help-${id}`; check.setAttribute("aria-describedby", description.id);
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
      if (!current() || pending) return; pending = true; status.textContent = "Loading saved status-line settings…"; render();
      try {
        const result = await this.load(); if (!current() || !result) return;
        snapshot = result; draft = [...result.items]; dirty = false;
        scope.textContent = result.account ? `Saved for your Relay account: ${result.account.username}.` : "No private Relay account is signed in. Preferences are shared by this Relay installation; sign in for separate account preferences.";
        status.textContent = "Saved status line loaded. Nothing has changed.";
      } catch (error) { if (current()) status.textContent = error.message; }
      finally { pending = false; render(); }
    };
    const persist = async () => {
      if (!current() || pending || !snapshot || !dirty) return;
      pending = true; this.loadVersion++; status.textContent = "Saving status line…"; render();
      try {
        const result = await this.api("/api/statusline", { method: "PATCH", body: JSON.stringify({ scope: snapshot.scope, revision: snapshot.revision, items: draft }) });
        const items = validateStatusItems(result.items);
        if (identity === this.identityVersion && result.scope === this.snapshot.scope && result.revision >= this.snapshot.revision) { this.loadVersion++; this.snapshot = { ...result, items }; this.render(); }
        if (!current()) { this.notify?.("Status line saved for the account shown in the original panel."); return; }
        snapshot = result; draft = items; dirty = false; status.textContent = "Status line saved and active.";
      } catch (error) { if (current()) status.textContent = `${error.message} Your status-line draft is retained. Reload to check what was saved before retrying.`; else this.notify?.(error.message); }
      finally { pending = false; render(); }
    };
    render(); await refresh(); return current() && Boolean(snapshot);
  }
}
