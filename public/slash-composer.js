import { composerHasFocus, composerIsInserting } from "./vim-composer.js";
export class SlashComposer {
  constructor({ api, state }) {
    Object.assign(this, { api, state }); this.input = document.querySelector("#message-input"); this.menu = document.querySelector("#slash-menu"); this.cache = new Map(); this.pending = new Map(); this.index = 0; this.version = 0;
    this.options = document.querySelector("#slash-options"); this.status = document.querySelector("#slash-status");
    this.input.setAttribute("role", "combobox"); this.input.setAttribute("aria-autocomplete", "list"); this.input.setAttribute("aria-controls", "slash-options"); this.close();
    this.input.addEventListener("input", () => { this.index = 0; void this.update(); });
    this.input.addEventListener("click", () => this.update());
    this.input.addEventListener("focus", () => this.update());
    this.input.addEventListener("blur", () => { clearTimeout(this.blurTimer); this.blurTimer = setTimeout(() => { if (!composerHasFocus(this.input)) this.close(); }, 150); });
    document.querySelector("#slash-commands").onclick = () => { document.querySelectorAll(".control-menu[open]").forEach(n => n.open = false); this.input.value = "/"; this.input.focus(); this.update(); };
  }
  key() { return `${this.state.active?.id}:${this.state.active?.agent}:${this.state.active?.model || "default"}:${this.state.active?.commandCatalogRevision || 0}`; }
  refresh(chatId) {
    const reopen = this.state.active?.id === chatId && !this.menu.hidden && composerHasFocus(this.input);
    this.invalidate(chatId);
    if (reopen) void this.update();
  }
  invalidate(chatId) {
    for (const map of [this.cache, this.pending]) for (const key of map.keys()) if (key.startsWith(`${chatId}:`)) map.delete(key);
    if (this.state.active?.id === chatId) this.close();
  }
  query() { return composerIsInserting(this.input) && this.input.selectionStart === this.input.value.length && /^\/[\w:.-]*$/.test(this.input.value) ? this.input.value.slice(1).toLowerCase() : null; }
  message(text) { this.matches = []; this.options.replaceChildren(); this.status.textContent = text; this.status.hidden = false; this.input.removeAttribute("aria-activedescendant"); document.querySelector("#slash-count").textContent = ""; }
  async update() {
    const q = this.query(), key = this.key(), id = this.state.active?.id, version = ++this.version;
    if (q === null || !id) return this.close();
    this.menu.hidden = false; this.input.setAttribute("aria-expanded", "true");
    document.querySelector("#slash-caption").textContent = `${{ claude: "Claude", codex: "Codex", mock: "Mock agent" }[this.state.active.agent] || "Agent"} · available in this chat`;
    if (!this.cache.has(key) || this.cache.get(key).expires < Date.now()) {
      this.message("Loading commands and installed skills…"); this.options.setAttribute("aria-busy", "true");
      try {
        if (!this.pending.has(key)) {
          const promise = this.api(`/api/chats/${id}/commands`).then(result => { if (this.pending.get(key) === promise) this.cache.set(key, { ...result, expires: Date.now() + 60000 }); }).finally(() => { if (this.pending.get(key) === promise) this.pending.delete(key); });
          this.pending.set(key, promise);
        }
        await this.pending.get(key);
      } catch (error) { if (version === this.version) { this.message(`Could not load commands. ${error.message}`); this.options.setAttribute("aria-busy", "false"); } return; }
      // Slow discovery must not undo Escape, blur, a newer query, or a chat switch.
      if (version !== this.version || this.key() !== key || this.query() === null) return;
    }
    this.options.setAttribute("aria-busy", "false"); this.status.hidden = true;
    this.matches = (this.cache.get(key).commands || []).filter(n => n.name.toLowerCase().startsWith(this.query()));
    this.index = Math.min(this.index, Math.max(0, this.matches.length - 1)); this.options.replaceChildren();
    document.querySelector("#slash-count").textContent = String(this.matches.length);
    for (const [i, item] of this.matches.entries()) {
      const row = document.createElement("div"); row.id = `slash-option-${i}`; row.setAttribute("role", "option"); row.setAttribute("aria-selected", String(i === this.index)); row.className = "slash-option";
      const name = document.createElement("strong"); name.textContent = `/${item.name}`;
      const copy = document.createElement("div"); copy.className = "slash-option-copy"; copy.append(name);
      const note = document.createElement("small"); note.textContent = item.description || item.kind || ""; copy.append(note); row.append(copy); row.title = item.description || `/${item.name}`;
      if (item.kind || item.web) {
        const kind = document.createElement("span"); kind.className = "slash-kind"; kind.setAttribute("aria-hidden", "true");
        kind.textContent = item.web || item.kind === "Web control" ? "Control" : /skill/i.test(item.kind) ? "Skill" : "Command"; row.append(kind);
      }
      row.onmousedown = event => event.preventDefault(); row.onclick = () => this.choose(i);
      row.onpointermove = event => { if (event.pointerType === "mouse" && this.index !== i) { this.index = i; this.highlight(false); } };
      this.options.append(row);
    }
    if (!this.matches.length) { this.status.textContent = `No matches for /${q}. Try a shorter command name.`; this.status.hidden = false; }
    else if (this.cache.get(key).note) { this.status.textContent = this.cache.get(key).note; this.status.hidden = false; }
    this.highlight();
  }
  highlight(scroll = true) { [...this.options.children].forEach((n, i) => n.setAttribute("aria-selected", String(i === this.index))); const selected = this.options.children[this.index]; if (selected) { this.input.setAttribute("aria-activedescendant", selected.id); if (scroll) selected.scrollIntoView({ block: "nearest" }); } else this.input.removeAttribute("aria-activedescendant"); }
  keydown(event) {
    if (event.isComposing || this.menu.hidden) return false;
    if (event.key === "Escape") { event.preventDefault(); this.close(); return true; }
    if (event.key === "Tab" && !this.matches?.length) { this.close(); return false; }
    if (["ArrowDown", "ArrowUp", "Enter", "Tab"].includes(event.key)) {
      event.preventDefault();
      if (!this.matches?.length) return true;
      if (event.key === "Enter" || event.key === "Tab") this.choose(this.index);
      else { this.index = (this.index + (event.key === "ArrowDown" ? 1 : -1) + this.matches.length) % this.matches.length; this.highlight(); }
      return true;
    } return false;
  }
  choose(index) { const item = this.matches[index]; if (!item) return; this.input.value = `/${item.name} `; this.input.focus(); this.input.setSelectionRange(this.input.value.length, this.input.value.length); this.close(); this.input.dispatchEvent(new Event("input")); }
  close() { this.version++; this.menu.hidden = true; this.matches = []; this.input.setAttribute("aria-expanded", "false"); this.input.removeAttribute("aria-activedescendant"); }
}
