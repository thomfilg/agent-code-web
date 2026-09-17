// Vim owns editing only. The existing textarea remains Relay's draft/selection
// interface, so submission, attachments and installed command pickers keep the
// same paths. CodeMirror is self-hosted and loaded only after explicit opt-in.
let loading;
const assets = new Map();
function asset(path, style = false) {
  if (assets.has(path)) return assets.get(path);
  const promise = new Promise((resolve, reject) => {
    const element = document.createElement(style ? "link" : "script");
    if (style) { element.rel = "stylesheet"; element.href = path; } else element.src = path;
    element.onload = resolve;
    element.onerror = () => { assets.delete(path); element.remove(); reject(new Error("Could not load Vim editing. Your draft is unchanged; try again.")); };
    document.head.append(element);
  });
  assets.set(path, promise); return promise;
}
async function editorLibrary() {
  loading ||= (async () => {
    await Promise.all([asset("/vendor/codemirror.css", true), asset("/vendor/codemirror-dialog.css", true)]);
    if (!window.CodeMirror) await asset("/vendor/codemirror.js");
    if (!window.CodeMirror.Vim) for (const name of ["searchcursor", "dialog", "matchbrackets", "vim"]) await asset(`/vendor/codemirror-${name}.js`);
    return window.CodeMirror;
  })().catch(error => { loading = null; throw error; });
  return loading;
}

export function composerHasFocus(input) { return document.activeElement === input || Boolean(input.relayVimEditor?.hasFocus()); }
export function composerIsInserting(input) { return !input.relayVimEditor || Boolean(input.relayVimEditor.state.vim?.insertMode); }

export class VimComposer {
  constructor({ input, getChatId, notify, keydown, changed, help }) {
    Object.assign(this, { input, getChatId, notify, keydown, changed });
    this.enabledChats = new Set(); this.generation = 0;
    this.button = document.querySelector("#vim-button"); this.status = document.querySelector("#vim-status");
    this.button.onclick = () => { this.button.closest("details").open = false; void this.toggle().catch(error => notify(error.message)); };
    document.querySelector("#vim-disable").onclick = () => void this.toggle(false);
    document.querySelector("#vim-help").onclick = help;
    this.render();
  }
  async toggle(enabled = !this.enabledChats.has(this.getChatId()), { command } = {}) {
    const chatId = this.getChatId(), generation = ++this.generation;
    if (!chatId) return false;
    if (enabled) {
      this.pending = true; this.render();
      try { this.library = await editorLibrary(); }
      finally { if (generation === this.generation) { this.pending = false; this.render(); } }
      if (generation !== this.generation || this.getChatId() !== chatId) return false;
      // Loading may take time. Never erase newly typed text or another chat's draft.
      if (command !== undefined && this.input.value.trim() === command) { this.input.value = ""; this.changed(); }
      this.enabledChats.add(chatId); this.mount();
    } else {
      this.pending = false;
      this.enabledChats.delete(chatId); this.unmount();
      if (command !== undefined && this.input.value.trim() === command) { this.input.value = ""; this.changed(); }
    }
    this.render(); this.input.focus(); return true;
  }
  beforeSelect() { this.generation++; this.pending = false; this.unmount(); }
  select() {
    if (!this.getChatId()) { this.beforeSelect(); this.render(); return; }
    if (this.enabledChats.has(this.getChatId())) this.mount();
    this.sync(); this.render();
  }
  resetIdentity() { this.beforeSelect(); this.enabledChats.clear(); this.render(); }
  forget(chatId) { this.enabledChats.delete(chatId); if (this.chatId === chatId) this.beforeSelect(); }
  render() {
    const enabled = this.enabledChats.has(this.getChatId());
    this.button.textContent = this.pending ? "Loading Vim editing…" : enabled ? "Disable Vim editing" : "Enable Vim editing";
    this.button.setAttribute("aria-pressed", String(enabled)); this.button.disabled = !this.getChatId();
    this.status.hidden = !this.cm;
    if (this.cm) document.querySelector("#vim-mode").textContent = `VIM · ${this.mode || "NORMAL"}`;
  }
  sync() {
    if (!this.cm) return;
    this.cm.setOption("readOnly", this.input.disabled || this.input.readOnly);
    this.cm.getInputField().setAttribute("aria-disabled", String(this.input.disabled));
  }
  mount() {
    if (this.cm || !this.library) return;
    const input = this.input, CodeMirror = this.library;
    // This pinned upstream hook resets registers, macros, search and Ex history.
    // They must never survive a chat/account switch or a disabled editor.
    CodeMirror.Vim.resetVimGlobalState_();
    const start = input.selectionStart, end = input.selectionEnd;
    const cm = this.cm = CodeMirror.fromTextArea(input, { keyMap: "vim", inputStyle: "contenteditable", lineWrapping: true,
      viewportMargin: 12, undoDepth: 30, tabSize: 2, dragDrop: false, lineNumbers: false, mode: null,
      screenReaderLabel: "Message (Vim editor)", leaveSubmitMethodAlone: true, readOnly: input.disabled || input.readOnly });
    this.chatId = this.getChatId(); input.relayVimEditor = cm; this.mode = "NORMAL";
    cm.getWrapperElement().classList.add("relay-vim-editor");
    cm.getInputField().setAttribute("aria-describedby", "vim-status composer-keyboard-hint");
    cm.getInputField().setAttribute("role", "combobox");
    cm.setSelection(cm.posFromIndex(start), cm.posFromIndex(end));
    this.bridge(cm);
    cm.on("changes", () => { if (this.cm === cm) { this.syncNative(); input.dispatchEvent(new Event("input", { bubbles: true })); } });
    cm.on("cursorActivity", () => { if (this.cm === cm) this.syncNative(); });
    cm.on("focus", () => { if (this.cm === cm) input.dispatchEvent(new Event("focus")); });
    cm.on("blur", () => { if (this.cm === cm) input.dispatchEvent(new Event("blur")); });
    cm.on("mousedown", () => queueMicrotask(() => { if (this.cm === cm) input.dispatchEvent(new Event("click")); }));
    cm.on("vim-mode-change", event => { if (this.cm !== cm) return; this.mode = `${event.mode}${event.subMode ? ` ${event.subMode}` : ""}`.toUpperCase(); this.render(); this.changed(); input.dispatchEvent(new Event("input")); });
    cm.on("beforeChange", (editor, change) => {
      const length = editor.getValue().length - (editor.indexFromPos(change.to) - editor.indexFromPos(change.from)) + change.text.join("\n").length;
      if (input.maxLength >= 0 && length > input.maxLength) { change.cancel(); this.notify(`Messages are limited to ${input.maxLength.toLocaleString()} characters. Your draft is unchanged.`); }
    });
    cm.on("keydown", (editor, event) => {
      if (this.cm !== cm) return;
      if (input.disabled || input.readOnly) return;
      if (event.isComposing || event.keyCode === 229 || document.querySelector("dialog[open]")) { event.codemirrorIgnore = true; return; }
      // Tab remains focus navigation. All editing keys otherwise reach Vim;
      // only actual Relay actions/pickers may consume the event first.
      if (event.key === "Tab" && document.querySelector("#slash-menu").hidden && document.querySelector("#file-menu").hidden) {
        event.codemirrorIgnore = true; return;
      }
      this.keydown(event, { vim: true, inserting: Boolean(editor.state.vim?.insertMode) });
    });
    cm.on("paste", (editor, event) => {
      if (this.cm !== cm) return;
      if (input.disabled || input.readOnly) return;
      const forwarded = new ClipboardEvent("paste", { clipboardData: event.clipboardData, bubbles: true, cancelable: true });
      input.dispatchEvent(forwarded); if (forwarded.defaultPrevented) event.preventDefault();
    });
    this.observer = new MutationObserver(() => {
      if (this.cm !== cm) return;
      this.sync();
      const field = cm.getInputField();
      for (const attr of ["aria-controls", "aria-expanded", "aria-activedescendant", "aria-autocomplete"]) {
        if (input.hasAttribute(attr)) field.setAttribute(attr, input.getAttribute(attr)); else field.removeAttribute(attr);
      }
    });
    this.observer.observe(input, { attributes: true, attributeFilter: ["disabled", "readonly", "aria-controls", "aria-expanded", "aria-activedescendant", "aria-autocomplete"] });
    this.render(); this.changed();
  }
  bridge(cm) {
    const input = this.input, proto = HTMLTextAreaElement.prototype, raw = Object.getOwnPropertyDescriptor(proto, "value");
    const saved = new Map(), define = (key, descriptor) => { saved.set(key, Object.getOwnPropertyDescriptor(input, key)); Object.defineProperty(input, key, { configurable: true, ...descriptor }); };
    define("value", { get: () => cm.getValue(), set: value => {
      const next = String(value); if (next === cm.getValue()) return;
      if (input.maxLength >= 0 && next.length > input.maxLength) { this.notify(`Messages are limited to ${input.maxLength.toLocaleString()} characters. Your draft is unchanged.`); return; }
      cm.setValue(next); cm.clearHistory(); cm.setCursor(cm.posFromIndex(cm.getValue().length));
      raw.set.call(input, cm.getValue());
    } });
    const range = (start, end, direction) => cm.setSelection(cm.posFromIndex(direction === "backward" ? end : start), cm.posFromIndex(direction === "backward" ? start : end));
    define("selectionStart", { get: () => cm.indexFromPos(cm.getCursor("from")), set: start => range(start, Math.max(start, input.selectionEnd)) });
    define("selectionEnd", { get: () => cm.indexFromPos(cm.getCursor("to")), set: end => range(Math.min(end, input.selectionStart), end) });
    define("selectionDirection", { get: () => cm.indexFromPos(cm.getCursor("anchor")) > cm.indexFromPos(cm.getCursor("head")) ? "backward" : "forward" });
    define("setSelectionRange", { value: range });
    define("focus", { value: () => cm.focus() });
    define("setRangeText", { value: (replacement, start = input.selectionStart, end = input.selectionEnd, mode = "preserve") => {
      raw.set.call(input, cm.getValue()); proto.setSelectionRange.call(input, input.selectionStart, input.selectionEnd);
      proto.setRangeText.call(input, replacement, start, end, mode);
      const a = Object.getOwnPropertyDescriptor(proto, "selectionStart").get.call(input), b = Object.getOwnPropertyDescriptor(proto, "selectionEnd").get.call(input);
      cm.replaceRange(replacement, cm.posFromIndex(start), cm.posFromIndex(end), "+input"); range(a, b);
    } });
    this.syncNative = () => {
      raw.set.call(input, cm.getValue());
      proto.setSelectionRange.call(input, cm.indexFromPos(cm.getCursor("from")), cm.indexFromPos(cm.getCursor("to")));
    };
    this.syncNative();
    this.restoreBridge = () => {
      const value = cm.getValue(), a = input.selectionStart, b = input.selectionEnd;
      for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(input, key, descriptor); else delete input[key]; }
      raw.set.call(input, value); input.setSelectionRange(a, b);
    };
  }
  unmount() {
    if (!this.cm) return;
    const cm = this.cm;
    this.observer?.disconnect();
    cm.setOption("keyMap", "default"); // Detach Vim listeners and pending insert-mode state.
    this.restoreBridge(); this.restoreBridge = null;
    cm.toTextArea(); this.cm = null; this.syncNative = null; delete this.input.relayVimEditor;
    this.library.Vim.resetVimGlobalState_(); this.mode = null; this.chatId = null;
    this.changed(); this.render();
  }
}
