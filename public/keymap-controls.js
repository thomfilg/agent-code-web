import { KEY_ACTIONS, boundAction, validateBindings } from "./key-bindings.js";
const node = (tag, text, className) => { const element = document.createElement(tag); if (text !== undefined) element.textContent = text; if (className) element.className = className; return element; };
const button = (text, action) => { const element = node("button", text); element.type = "button"; element.onclick = action; return element; };
export class KeymapControls {
  constructor({ api, controls, notify, changed }) { Object.assign(this, { api, controls, notify, changed }); this.snapshot = { bindings: {} }; this.identityVersion = 0; this.loadVersion = 0; }
  resetIdentity() { this.identityVersion++; this.loadVersion++; this.snapshot = { bindings: {} }; this.changed?.(); }
  action(event, context) { return boundAction(this.snapshot.bindings, event, context); }
  async load() {
    const version = ++this.loadVersion, identity = this.identityVersion;
    const result = await this.api("/api/keymap");
    if (version !== this.loadVersion || identity !== this.identityVersion) return null;
    this.snapshot = { ...result, bindings: validateBindings(result.bindings) }; this.changed?.(); return this.snapshot;
  }
  async open() {
    const identity = this.identityVersion, status = node("p", "Loading keyboard shortcuts…", "muted"); status.setAttribute("role", "status");
    const scope = node("p", "", "muted"), context = node("select"); context.id = "keymap-context";
    for (const [value, label] of [["global", "Global controls"], ["composer", "Composer"]]) { const option = node("option", label); option.value = value; context.append(option); }
    const label = node("label", "Shortcut context"); label.htmlFor = context.id;
    const rows = node("div", undefined, "keymap-rows"), save = button("Save shortcuts", () => void persist());
    const defaults = button("Restore all defaults", () => { draft = {}; dirty = true; render(); status.textContent = "Defaults staged. Save shortcuts to apply them."; });
    const reload = button("Reload shortcuts", () => { if (!dirty || confirm("Discard unsaved shortcut edits and reload the saved keymap?")) void refresh(); });
    this.controls.dialog("Keyboard shortcuts", node("p", "These shortcuts control Relay's web UI, not the remote Codex terminal. Saving does not change native config.toml, wake a worker, send a message or grant permissions.", "muted"), scope,
      node("p", "Use names such as ctrl-enter, meta-enter or alt-up; separate alternatives with commas. An empty field unbinds that Relay action, leaving normal browser editing intact. Composer bindings take priority over global bindings. Slash/file pickers keep their navigation keys; Escape, Tab and standard browser/text-editing shortcuts stay available. Browsers may reserve other shortcuts too.", "muted"),
      status, label, context, rows, save, defaults, reload);
    const version = this.controls.dialogVersion, dialog = document.querySelector("#controls-dialog");
    const current = () => dialog.open && this.controls.dialogVersion === version && identity === this.identityVersion;
    let snapshot = null, draft = {}, dirty = false, pending = false, error = null;
    const validate = () => { try { validateBindings(draft); error = null; } catch (failure) { error = failure.message; } save.disabled = pending || !snapshot || !dirty || Boolean(error); if (error) status.textContent = error; };
    const render = () => {
      if (!current()) return;
      context.disabled = defaults.disabled = pending || !snapshot; reload.disabled = pending; rows.replaceChildren();
      if (snapshot) for (const action of KEY_ACTIONS.filter(item => item.context === context.value)) {
        const row = node("section", undefined, "native-app-card keymap-row"), field = node("input"), fieldLabel = node("label", action.label);
        field.id = `keymap-${action.context}-${action.id}`; fieldLabel.htmlFor = field.id; field.autocomplete = "off"; field.spellcheck = false; field.maxLength = 260; field.disabled = pending;
        field.value = (draft[action.context]?.[action.id] ?? action.defaults).join(", "); field.placeholder = "Unbound";
        const help = node("small", `Default: ${action.defaults.join(", ") || "Unbound"}`, "muted"); help.id = `${field.id}-help`; field.setAttribute("aria-describedby", help.id);
        field.oninput = () => { (draft[action.context] ||= {})[action.id] = field.value.split(",").map(value => value.trim()).filter(Boolean); dirty = true; status.textContent = "Unsaved shortcut changes."; validate(); };
        const reset = button("Use default", () => { if (draft[action.context]) delete draft[action.context][action.id]; dirty = true; render(); status.textContent = "Default staged. Save shortcuts to apply it."; }); reset.disabled = pending; reset.setAttribute("aria-label", `Use default for ${action.label}`);
        row.append(fieldLabel, field, help, reset); rows.append(row);
      }
      validate();
    };
    context.onchange = render;
    const refresh = async () => {
      if (!current() || pending) return;
      pending = true; status.textContent = "Loading saved keyboard shortcuts…"; render();
      try {
        const result = await this.load(); if (!current() || !result) return;
        snapshot = result; draft = structuredClone(result.bindings); dirty = false;
        scope.textContent = result.account ? `Saved for your Relay account: ${result.account.username}.` : "No private Relay account is signed in. These shortcuts are shared by this Relay installation; sign in for separate account preferences.";
        status.textContent = "Saved shortcuts loaded. Nothing has changed.";
      } catch (failure) { if (current()) status.textContent = failure.message; }
      finally { pending = false; render(); }
    };
    const persist = async () => {
      if (!current() || pending || !snapshot || !dirty) return; validate(); if (error) return;
      pending = true; status.textContent = "Saving keyboard shortcuts…"; render();
      try {
        const result = await this.api("/api/keymap", { method: "PATCH", body: JSON.stringify({ scope: snapshot.scope, revision: snapshot.revision, bindings: draft }) });
        if (identity === this.identityVersion && result.scope === this.snapshot.scope && result.revision >= this.snapshot.revision) { this.loadVersion++; this.snapshot = { ...result, bindings: validateBindings(result.bindings) }; this.changed?.(); }
        if (!current()) { this.notify?.("Keyboard shortcuts saved for the account shown in the original panel."); return; }
        snapshot = result; draft = structuredClone(result.bindings); dirty = false; status.textContent = "Keyboard shortcuts saved and active.";
      } catch (failure) { if (current()) status.textContent = `${failure.message} Your shortcut draft is retained. If the result is uncertain, reload to check what was saved.`; else this.notify?.(failure.message); }
      finally { pending = false; render(); }
    };
    render(); await refresh(); return current();
  }
}
