export class MessageHistory {
  constructor({ input, state, onChange }) { Object.assign(this, { input, state, onChange }); this.chats = new Map(); this.chatId = null; }
  select(chatId) {
    if (chatId === this.chatId) return;
    if (this.chatId) this.saveCurrent();
    this.chatId = chatId;
    if (!this.chats.has(chatId)) this.chats.set(chatId, { draft: "", index: null, messages: [], edits: new Map() });
    const entry = this.chats.get(chatId); this.set(entry.index === null ? entry.draft : entry.edits.get(entry.index) ?? entry.messages[entry.index]);
  }
  saveCurrent() {
    const entry = this.chats.get(this.chatId); if (!entry) return;
    if (entry.index === null) entry.draft = this.input.value; else entry.edits.set(entry.index, this.input.value);
  }
  reset() { if (this.chatId) this.chats.set(this.chatId, { draft: "", index: null, messages: [], edits: new Map() }); }
  set(value, atStart = false) { this.input.value = value || ""; const caret = atStart ? 0 : this.input.value.length; this.input.setSelectionRange(caret, caret); this.onChange(); }
  keydown(event) {
    if (event.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || !["ArrowUp", "ArrowDown"].includes(event.key) || this.input.selectionStart !== this.input.selectionEnd) return false;
    const previous = event.key === "ArrowUp";
    if ((previous && this.input.selectionStart !== 0) || (!previous && this.input.selectionEnd !== this.input.value.length)) return false;
    const entry = this.chats.get(this.chatId); if (!entry) return false;
    if (entry.index === null) {
      if (!previous) return false;
      entry.messages = (this.state.active?.messages || []).filter(m => m.role === "user" && !m.meta?.renderingSample).map(m => m.text || "");
      if (!entry.messages.length) return false;
      entry.draft = this.input.value; entry.edits.clear(); entry.index = entry.messages.length;
    } else this.saveCurrent();
    event.preventDefault();
    const next = Math.max(0, entry.index + (previous ? -1 : 1));
    if (next >= entry.messages.length) { entry.index = null; this.set(entry.draft); }
    else { entry.index = next; this.set(entry.edits.get(next) ?? entry.messages[next], previous); }
    return true;
  }
}
