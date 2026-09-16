import { DEFAULT_SYNTAX_THEME, SYNTAX_THEMES, validateSyntaxTheme } from "./syntax-theme.js";
import { highlightCode, retryHighlighting, refreshHighlighting } from "./syntax-highlight.js";
const node = (tag, text, className) => { const element = document.createElement(tag); if (text !== undefined) element.textContent = text; if (className) element.className = className; return element; };
const button = (text, action) => { const element = node("button", text); element.type = "button"; element.onclick = action; return element; };
export class SyntaxThemeControls {
  constructor({ api, controls, notify }) {
    Object.assign(this, { api, controls, notify }); this.snapshot = { theme: DEFAULT_SYNTAX_THEME }; this.identityVersion = 0; this.loadVersion = 0; this.apply();
  }
  apply() {
    if (document.documentElement.dataset.syntaxTheme !== this.snapshot.theme) {
      document.documentElement.dataset.syntaxTheme = this.snapshot.theme; refreshHighlighting();
    }
  }
  resetIdentity() { this.invalidatePanel?.(); this.identityVersion++; this.loadVersion++; this.snapshot = { theme: DEFAULT_SYNTAX_THEME }; this.apply(); }
  async load() {
    const version = ++this.loadVersion, identity = this.identityVersion, result = await this.api("/api/syntax-theme");
    if (version !== this.loadVersion || identity !== this.identityVersion) return null;
    const theme = validateSyntaxTheme(result.theme);
    if (this.snapshot.scope && this.snapshot.scope !== result.scope) { this.invalidatePanel?.(); this.identityVersion++; }
    this.snapshot = { ...result, theme }; this.apply(); return this.snapshot;
  }
  async open() {
    const identity = this.identityVersion, panel = node("div", undefined, "theme-settings"), scope = node("p", "", "muted");
    const status = node("p", "Loading syntax themes…", "muted"); status.setAttribute("role", "status");
    const choices = node("fieldset", undefined, "theme-choices"); choices.append(node("legend", "Syntax theme"));
    const preview = node("section", undefined, "theme-preview"); preview.setAttribute("aria-label", "Syntax theme preview");
    const previewNote = node("p", "", "muted"); previewNote.setAttribute("aria-live", "polite");
    const sample = node("pre", undefined, "syntax-surface"), code = node("code", '// Code stays literal; it is never executed.\nconst greeting = "Hello";\nfunction welcome(name) {\n  return `${greeting}, ${name}!`;\n}\nwelcome("Relay");'); sample.append(code);
    const diff = node("pre", undefined, "diff-code"); diff.append(node("div", "@@ -1 +1 @@", "diff-line hunk"), node("div", "- const count = 1;", "diff-line removed"), node("div", "+ const count = 2;", "diff-line added"));
    preview.append(sample, diff);
    const save = button("Save syntax theme", () => void persist()); save.className = "primary-button";
    const defaults = button("Restore default", () => choose(DEFAULT_SYNTAX_THEME));
    const reload = button("Reload syntax theme", () => { if (!dirty || confirm("Discard unsaved syntax-theme edits and reload?")) void refresh(); });
    const retry = button("Retry highlighting", () => { retryHighlighting(); refreshHighlighting(); });
    const actions = node("div", undefined, "theme-actions"); actions.append(save, defaults, reload, retry);
    const scroll = node("div", undefined, "theme-scroll"), about = node("details");
    about.append(node("summary", "About syntax themes"), node("p", "Web display only: native tui.theme/config.toml, workers and messages are unchanged. HTML previews keep their own styles. Unknown languages and large or complex blocks remain plain; source and Copy are unchanged.", "muted"));
    scroll.append(node("p", "Preview a theme, then Save to apply it to conversation code and diff colors. Closing cancels unsaved edits.", "muted"), scope, choices, preview, previewNote, about);
    panel.append(scroll, status, actions);
    this.controls.dialog("Syntax theme", panel);
    const version = this.controls.dialogVersion, dialog = document.querySelector("#controls-dialog");
    const current = () => dialog.open && this.controls.dialogVersion === version && identity === this.identityVersion;
    this.invalidatePanel = () => {
      if (!dialog.open || this.controls.dialogVersion !== version) return;
      status.textContent = "The Relay account changed. Close and reopen Syntax theme to edit the current account's preference.";
      choices.disabled = save.disabled = defaults.disabled = reload.disabled = true;
    };
    let snapshot = null, draft = DEFAULT_SYNTAX_THEME, dirty = false, pending = false;
    const inputs = new Map();
    for (const theme of SYNTAX_THEMES) {
      const label = node("label"), input = node("input"), text = node("span", theme.label); input.type = "radio"; input.name = "syntax-theme"; input.value = theme.id;
      input.setAttribute("aria-label", theme.label); input.onchange = () => choose(theme.id); text.append(node("small", theme.description, "muted")); label.append(input, text); choices.append(label); inputs.set(theme.id, input);
    }
    const render = () => {
      if (!current()) return;
      save.disabled = pending || !snapshot || !dirty; choices.disabled = defaults.disabled = pending || !snapshot; reload.disabled = pending;
      for (const [id, input] of inputs) input.checked = id === draft;
      preview.dataset.syntaxTheme = draft;
      previewNote.textContent = draft === "plain" ? "Plain theme: code has no syntax colors." : code.dataset.highlight === "unavailable" ? "Highlighting unavailable. Source is intact; use Retry highlighting." : code.dataset.highlight === "ready" ? "Preview uses the same highlighter as conversation code." : "Loading syntax highlighting…";
    };
    code.addEventListener("relay-syntax-highlight", render);
    const choose = theme => { if (!current() || pending || !snapshot) return; draft = theme; dirty = draft !== snapshot.theme; status.textContent = dirty ? "Unsaved theme. Save to apply." : "Saved theme selected."; render(); refreshHighlighting(); };
    const refresh = async () => {
      if (!current() || pending) return; pending = true; status.textContent = "Loading saved syntax theme…"; render();
      try {
        const result = await this.load(); if (!current() || !result) return;
        snapshot = result; draft = result.theme; dirty = false;
        scope.textContent = result.account ? `Saved for your Relay account: ${result.account.username}.` : "No private Relay account is signed in. This preference is shared by this Relay installation; sign in for separate account preferences.";
        status.textContent = "Saved syntax theme loaded. Nothing has changed.";
      } catch (error) { if (current()) status.textContent = error.message; }
      finally { pending = false; render(); }
    };
    const persist = async () => {
      if (!current() || pending || !snapshot || !dirty) return;
      pending = true; this.loadVersion++; status.textContent = "Saving syntax theme…"; render();
      try {
        const result = await this.api("/api/syntax-theme", { method: "PATCH", body: JSON.stringify({ scope: snapshot.scope, revision: snapshot.revision, theme: draft }) });
        const theme = validateSyntaxTheme(result.theme);
        if (identity === this.identityVersion && result.scope === this.snapshot.scope && result.revision >= this.snapshot.revision) { this.loadVersion++; this.snapshot = { ...result, theme }; this.apply(); }
        if (!current()) { this.notify?.("Syntax theme saved for the account shown in the original panel."); return; }
        snapshot = result; draft = theme; dirty = false; status.textContent = "Syntax theme saved and active.";
      } catch (error) { if (current()) status.textContent = `${error.message} Your theme selection is retained. Reload to check what was saved before retrying.`; else this.notify?.(error.message); }
      finally { pending = false; render(); }
    };
    render(); highlightCode(code, "javascript"); await refresh(); return current() && Boolean(snapshot);
  }
}
