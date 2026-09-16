import { openSidePanel, closeSidePanel } from "./side-panels.js";
import { renderContent } from "./message-content.js";
import { renderAgentRequest } from "./agent-request.js";

const $ = selector => document.querySelector(selector);
const node = (tag, text, className = "") => { const e = document.createElement(tag); e.textContent = text; e.className = className; return e; };

export class SideChatPanel {
  constructor({ api, getChat, toast, onPreview }) {
    Object.assign(this, { api, getChat, toast, onPreview }); this.version = 0; this.revision = -1;
    this.panel = $("#side-panel"); this.input = $("#side-input"); this.messages = $("#side-messages"); this.approval = $("#side-approval");
    $("#open-side").onclick = () => this.open().catch(error => toast(error.message));
    $("#hide-side").onclick = () => { this.version++; closeSidePanel("side"); $("#message-input").focus(); };
    $("#end-side").onclick = () => this.end().catch(error => toast(error.message));
    $("#side-form").onsubmit = event => { event.preventDefault(); void this.sendDraft(); };
    $("#side-stop").onclick = () => this.action("stop").catch(error => toast(error.message));
    this.input.onkeydown = event => { if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); void this.sendDraft(); } };
  }
  setChat(chat) {
    $("#open-side").hidden = chat?.agent !== "codex";
    $("#side-main-status").textContent = `Main chat: ${chat?.status || "stopped"}`;
    if (this.chatId === chat?.id) return;
    this.version++; this.chatId = chat?.id; this.side = null; this.revision = -1; this.epoch = null; this.input.value = "";
    closeSidePanel("side"); this.render();
  }
  async refresh() {
    const chatId = this.chatId;
    if (!chatId || this.getChat()?.agent !== "codex") return;
    try { this.update(await this.api(`/api/chats/${chatId}/side`), chatId); } catch { /* SSE reconnect retries; opening reports actionable errors. */ }
  }
  update(snapshot, chatId) {
    if (this.chatId !== chatId) return;
    if (this.epoch === snapshot.epoch && snapshot.revision < this.revision) return;
    this.epoch = snapshot.epoch; this.revision = snapshot.revision; this.side = snapshot.side;
    this.render();
  }
  async open(text = "", attachments = []) {
    const chatId = this.chatId, version = ++this.version;
    if (!chatId) throw new Error("Select a chat first");
    openSidePanel("side"); $("#side-status").textContent = "Opening side chat…";
    try {
      const snapshot = await this.api(`/api/chats/${chatId}/side`, { method: "POST" });
      this.update(snapshot, chatId);
      if (this.chatId !== chatId || version !== this.version) throw new Error("Side action cancelled because the view changed");
      if (text) await this.action("messages", { text, attachments });
      if (!this.panel.hidden && version === this.version) this.input.focus();
    } catch (error) { if (this.chatId === chatId && version === this.version) $("#side-status").textContent = error.message; throw error; }
  }
  async action(action, payload = {}) {
    const chatId = this.chatId, sideId = this.side?.id;
    if (!sideId) throw new Error("Open a side chat first");
    const result = await this.api(`/api/chats/${chatId}/side/${action}`, { method: "POST", body: JSON.stringify({ ...payload, sideId }) });
    this.update(result, chatId); return result;
  }
  async sendDraft() {
    const text = this.input.value.trim(), sideId = this.side?.id, chatId = this.chatId;
    if (!text || this.sending || this.side?.status !== "idle") return;
    this.sending = true;
    try {
      await this.action("messages", { text });
      if (this.chatId === chatId && this.side?.id === sideId && this.input.value.trim() === text) this.input.value = "";
    } catch (error) { this.toast(error.message); }
    finally { this.sending = false; }
  }
  async end() {
    if (!this.side) { closeSidePanel("side"); return; }
    if (!confirm("End this temporary side chat? Its conversation will be discarded. Shared workspace changes will remain.")) return;
    const chatId = this.chatId, sideId = this.side.id, version = ++this.version;
    const result = await this.api(`/api/chats/${chatId}/side`, { method: "DELETE", body: JSON.stringify({ sideId }) });
    this.update(result, chatId);
    if (this.chatId === chatId && version === this.version) { this.input.value = ""; closeSidePanel("side"); }
  }
  render() {
    const side = this.side;
    $("#side-status").textContent = side ? side.status === "running" ? "Side agent is working…" : side.status === "starting" ? "Starting side chat…" : "Ready for a side question" : "No active side chat. Use /side to start one.";
    $("#side-error").textContent = side?.error || "";
    $("#side-send").disabled = side?.status !== "idle";
    $("#side-stop").hidden = side?.status !== "running";
    $("#end-side").disabled = !side;
    $("#open-side").textContent = side?.pendingRequest ? "Side · input needed" : side?.status === "running" ? "Side · running" : "Side chat";
    const atBottom = this.messages.scrollHeight - this.messages.scrollTop - this.messages.clientHeight < 80;
    this.messages.replaceChildren();
    if (side?.omittedMessages) this.messages.append(node("p", "Showing the latest side messages. Earlier context remains in this temporary thread.", "muted"));
    for (const message of [...(side?.messages || []), ...(side?.stream ? [{ role: "assistant", text: side.stream }] : [])]) {
      const item = node("article", "", "side-message"), content = node("div", "");
      item.append(node("strong", message.role === "user" ? "You · side chat" : message.role === "assistant" ? "Codex · side chat" : "Side chat"));
      renderContent(content, message.text, { onPreview: this.onPreview }); item.append(content); this.messages.append(item);
    }
    if (side?.tools?.length) {
      const tools = node("details", ""); tools.append(node("summary", `Side tools · ${side.tools.length}`));
      for (const tool of side.tools) { tools.append(node("p", `${tool.title || tool.tool || "Tool"} · ${tool.state}`)); if (tool.command || tool.output) tools.append(node("pre", String(tool.command || tool.output).slice(0, 20000))); }
      this.messages.append(tools);
    }
    if (atBottom) this.messages.scrollTop = this.messages.scrollHeight;
    const request = side?.pendingRequest, chatId = this.chatId, sideId = side?.id;
    renderAgentRequest(this.approval, request, `${sideId}:${request?.requestId}`, async payload => {
      if (this.chatId !== chatId || this.side?.id !== sideId || this.side?.pendingRequest?.requestId !== request.requestId) return;
      const controls = [...this.approval.querySelectorAll("button, input, textarea")]; if (controls.some(control => control.disabled)) return;
      controls.forEach(control => { control.disabled = true; });
      try { await this.action("respond", { ...payload, requestId: request.requestId }); } catch (error) { this.toast(error.message); }
      finally { controls.forEach(control => { control.disabled = false; }); }
    });
  }
}
