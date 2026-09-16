export class ChatPresence {
  constructor({ api }) {
    this.api = api; this.clientId = crypto.randomUUID();
    document.addEventListener("visibilitychange", () => this.sync());
    window.addEventListener("pageshow", () => this.sync());
    window.addEventListener("pagehide", () => this.send(this.chatId, false));
    setInterval(() => { if (document.visibilityState === "visible") this.sync(); }, 15000);
  }
  select(chatId) {
    if (this.chatId === chatId) return;
    this.send(this.chatId, false); this.chatId = chatId; this.sync();
  }
  sync() { this.send(this.chatId, document.visibilityState === "visible"); }
  send(chatId, active) {
    if (!chatId) return;
    // A presence bit only; never sends URLs, clicks, text, or images to an agent.
    void this.api(`/api/chats/${chatId}/presence`, { method: "POST", keepalive: true, body: JSON.stringify({ clientId: this.clientId, active }) }).catch(() => {});
  }
}
