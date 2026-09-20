export class RuntimeWake {
  constructor({ button, api, getChat, unavailable = () => false, updated, ready = () => {}, changed = () => {}, notify }) {
    Object.assign(this, { button, api, getChat, unavailable, updated, ready, changed, notify });
    this.pending = new Set(); this.waiting = new Set();
    button.addEventListener("click", () => void this.wake());
  }
  isWaiting(chatId) { return this.pending.has(chatId) || this.waiting.has(chatId); }
  render(chat) {
    this.button.hidden = !chat;
    if (!chat) return;
    const pending = this.pending.has(chat.id), asleep = ["stopped", "error"].includes(chat.status);
    const suspension = chat.suspension?.status;
    this.button.disabled = pending || !asleep || chat.archived || chat.workflowState === "archived" || this.unavailable(chat.id);
    this.button.textContent = pending ? (suspension === "hibernated" ? "Resuming…" : "Waking…")
      : chat.status === "starting" ? (suspension === "hibernated" ? "Resuming…" : "Starting…")
      : chat.status === "stopping" ? (suspension === "hibernating" ? "Hibernating…" : "Stopping…")
      : suspension === "hibernated" ? "Resume environment"
      : suspension === "failed" && chat.status === "error" ? "Reconcile environment"
      : asleep ? "Wake environment" : "Environment awake";
    this.button.setAttribute("aria-busy", String(pending || chat.status === "starting"));
    this.button.title = suspension === "hibernated"
      ? "Resume this exact hibernated environment without sending a message to the agent."
      : "Start this chat's environment without sending a message to the agent. Stopped app servers are not restarted automatically.";
    if (!pending && this.waiting.has(chat.id) && !["starting", "stopping"].includes(chat.status)) {
      this.waiting.delete(chat.id);
      if (chat.status === "idle") this.ready(chat.id);
    }
  }
  async wake() {
    const chat = this.getChat();
    if (!chat || this.button.disabled || this.pending.has(chat.id)) return;
    this.pending.add(chat.id); this.changed(); this.render(chat);
    try {
      const result = await this.api(`/api/chats/${chat.id}/wake`, { method: "POST", body: "{}" });
      this.waiting.add(chat.id);
      // A response from the previous selection cannot switch chats or replace
      // a newer SSE snapshot. The application merges only current revisions.
      if (this.getChat()?.id === chat.id) this.updated(result.chat);
    } catch (error) {
      this.waiting.delete(chat.id);
      if (this.getChat()?.id === chat.id) this.notify(error.message);
    } finally {
      this.pending.delete(chat.id); this.render(this.getChat()); this.changed();
    }
  }
}
