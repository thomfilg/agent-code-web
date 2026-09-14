export class SlashComposer {
  constructor({ api, state }) {
    Object.assign(this, { api, state }); this.input = document.querySelector("#message-input"); this.menu = document.querySelector("#slash-menu"); this.cache = new Map(); this.index = 0;
    this.input.setAttribute("role", "combobox"); this.input.setAttribute("aria-autocomplete", "list"); this.input.setAttribute("aria-controls", "slash-menu"); this.close();
    this.input.addEventListener("input", () => { this.index = 0; void this.update(); });
    this.input.addEventListener("click", () => this.update());
    this.input.addEventListener("blur", () => setTimeout(() => this.close(), 150));
    document.querySelector("#slash-commands").onclick = () => { document.querySelectorAll(".control-menu[open]").forEach(n => n.open = false); this.input.value = "/"; this.input.focus(); this.update(); };
  }
  key() { return `${this.state.active?.id}:${this.state.active?.agent}`; }
  query() { return this.input.selectionStart === this.input.value.length && /^\/[\w:.-]*$/.test(this.input.value) ? this.input.value.slice(1).toLowerCase() : null; }
  async update() {
    const q = this.query(), key = this.key(), id = this.state.active?.id;
    if (q === null || !id) return this.close();
    this.menu.hidden = false; this.input.setAttribute("aria-expanded", "true");
    if (!this.cache.has(key) || this.cache.get(key).expires < Date.now()) {
      this.menu.textContent = "Loading commands and skills…";
      try { this.cache.set(key, { ...await this.api(`/api/chats/${id}/commands`), expires: Date.now() + 60000 }); } catch (error) { this.menu.textContent = error.message; return; }
      if (this.key() !== key || this.query() === null) return this.close();
    }
    this.matches = this.cache.get(key).commands.filter(n => n.name.toLowerCase().startsWith(this.query()));
    this.index = Math.min(this.index, Math.max(0, this.matches.length - 1)); this.menu.replaceChildren();
    for (const [i, item] of this.matches.entries()) {
      const row = document.createElement("div"); row.id = `slash-option-${i}`; row.setAttribute("role", "option"); row.setAttribute("aria-selected", String(i === this.index)); row.className = "slash-option";
      const name = document.createElement("strong"); name.textContent = `/${item.name}`;
      const note = document.createElement("small"); note.textContent = item.description || item.kind; row.append(name, note);
      row.onmousedown = event => { event.preventDefault(); this.choose(i); }; this.menu.append(row);
    }
    if (!this.matches.length) this.menu.textContent = "No matching commands or installed skills";
    this.highlight();
  }
  highlight() { [...this.menu.children].forEach((n, i) => n.setAttribute("aria-selected", String(i === this.index))); const selected = this.menu.children[this.index]; if (selected) { this.input.setAttribute("aria-activedescendant", selected.id); selected.scrollIntoView({ block: "nearest" }); } else this.input.removeAttribute("aria-activedescendant"); }
  keydown(event) {
    if (event.isComposing || this.menu.hidden) return false;
    if (event.key === "Escape") { event.preventDefault(); this.close(); return true; }
    if (["ArrowDown", "ArrowUp", "Enter", "Tab"].includes(event.key)) {
      event.preventDefault();
      if (!this.matches?.length) return true;
      if (event.key === "Enter" || event.key === "Tab") this.choose(this.index);
      else { this.index = (this.index + (event.key === "ArrowDown" ? 1 : -1) + this.matches.length) % this.matches.length; this.highlight(); }
      return true;
    } return false;
  }
  choose(index) { const item = this.matches[index]; if (!item) return; this.input.value = `/${item.name} `; this.input.focus(); this.input.setSelectionRange(this.input.value.length, this.input.value.length); this.close(); this.input.dispatchEvent(new Event("input")); }
  close() { this.menu.hidden = true; this.matches = []; this.input.setAttribute("aria-expanded", "false"); this.input.removeAttribute("aria-activedescendant"); }
}
