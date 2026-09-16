import { openSidePanel, closeSidePanel } from "./side-panels.js";
import { renderContent } from "./message-content.js";
import { renderAgentRequest } from "./agent-request.js";

const $ = selector => document.querySelector(selector);
const node = (tag, text, className = "") => { const value = document.createElement(tag); value.textContent = text; value.className = className; return value; };

export class AgentThreadsPanel {
  constructor({ api, getChat, toast, onPreview }) {
    Object.assign(this, { api, getChat, toast, onPreview }); this.version = 0; this.drafts = new Map(); this.requests = new Map();
    this.panel = $("#agents-panel"); this.input = $("#agents-input"); this.messages = $("#agents-messages"); this.picker = $("#agents-picker");
    $("#open-agents").onclick = () => this.open().catch(error => toast(error.message));
    $("#hide-agents").onclick = () => this.hide();
    $("#agents-refresh").onclick = () => this.connect().catch(error => toast(error.message));
    this.picker.onchange = () => this.select(this.picker.value).catch(error => toast(error.message));
    $("#agents-older").onclick = () => this.select(this.selected, this.page?.nextCursor || this.current()?.nextCursor).catch(error => toast(error.message));
    $("#agents-latest").onclick = () => this.select(this.selected).catch(error => toast(error.message));
    $("#agents-form").onsubmit = event => { event.preventDefault(); void this.send(); };
    $("#agents-stop").onclick = () => this.action("stop").catch(error => toast(error.message));
    this.input.oninput = () => this.saveDraft();
    this.input.onkeydown = event => { if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); void this.send(); } };
  }
  key(id = this.selected) { return `${this.chatId}:${this.snapshot?.rootThreadId}:${id}`; }
  current() { return this.snapshot?.threads.find(thread => thread.id === this.selected); }
  saveDraft() { if (this.selected) this.drafts.set(this.key(), this.input.value); }
  hide() { this.saveDraft(); this.version++; closeSidePanel("agents"); $("#message-input").focus(); }
  setChat(chat) {
    $("#open-agents").hidden = chat?.agent !== "codex";
    const identity = `${chat?.id}:${chat?.agent}:${chat?.agentSessionId}`;
    if (this.identity === identity) return;
    if (this.chatId === chat?.id && this.agent === chat?.agent && !this.nativeRoot) { this.nativeRoot = chat?.agentSessionId; this.identity = identity; return; }
    this.saveDraft(); this.version++; this.identity = identity; this.chatId = chat?.id;
    this.nativeRoot = chat?.agentSessionId; this.agent = chat?.agent;
    this.snapshot = null; this.selected = null; this.page = null; this.input.value = "";
    closeSidePanel("agents"); this.render();
  }
  update(snapshot, chatId) {
    if (this.chatId !== chatId || this.getChat()?.agent !== "codex") return;
    if (snapshot.rootThreadId && this.getChat()?.agentSessionId && snapshot.rootThreadId !== this.getChat().agentSessionId) return;
    if (snapshot.epoch === this.snapshot?.epoch && snapshot.revision < this.snapshot.revision) return;
    this.snapshot = snapshot; this.render();
  }
  async refresh() {
    const chatId = this.chatId;
    if (!chatId || this.getChat()?.agent !== "codex") return;
    try { this.update(await this.api(`/api/chats/${chatId}/subagents`), chatId); } catch { /* Opening reports errors; SSE reconnect can retry safely. */ }
  }
  async open() {
    const chatId = this.chatId, version = ++this.version;
    if (!chatId) throw new Error("Select a chat first");
    openSidePanel("agents");
    this.update(await this.api(`/api/chats/${chatId}/subagents`), chatId);
    if (this.chatId !== chatId || version !== this.version) return;
    if (!this.snapshot?.threads.length && !this.getChat()?.archived) await this.connect();
    if (!this.panel.hidden) this.picker.focus();
  }
  async connect() {
    const chatId = this.chatId;
    if (this.connecting) return;
    this.connecting = true; this.render();
    try { this.update(await this.api(`/api/chats/${chatId}/subagents`, { method: "POST" }), chatId); }
    finally { this.connecting = false; this.render(); }
  }
  async select(id, cursor = null) {
    this.saveDraft();
    if (!id) { this.selected = null; this.hide(); return; }
    const chatId = this.chatId, version = ++this.version;
    this.selected = id; this.page = null; this.input.value = this.drafts.get(this.key(id)) || ""; this.render();
    if (!this.snapshot?.awake) return; // Cached messages do not wake a worker.
    const result = await this.action("select", { cursor });
    if (this.chatId !== chatId || this.selected !== id || version !== this.version) return;
    if (cursor) this.page = result.page;
    this.render(); if (!cursor) { this.messages.scrollTop = this.messages.scrollHeight; this.input.focus(); }
  }
  async action(action, payload = {}) {
    const chatId = this.chatId, threadId = this.selected, rootThreadId = this.snapshot?.rootThreadId;
    if (!threadId || !rootThreadId) throw new Error("Choose an agent thread first");
    const result = await this.api(`/api/chats/${chatId}/subagents/${action}`, { method: "POST", body: JSON.stringify({ ...payload, threadId, rootThreadId }) });
    this.update(result, chatId); return result;
  }
  async send() {
    const text = this.input.value.trim(), key = this.key();
    if (!text || this.sending || !this.current() || !this.snapshot?.awake) return;
    let attempt = this.requests.get(key);
    if (!attempt || attempt.text !== text) { attempt = { text, requestId: crypto.randomUUID() }; this.requests.set(key, attempt); }
    this.sending = true; this.render();
    try {
      await this.action("messages", attempt);
      if (this.drafts.get(key)?.trim() === text) this.drafts.set(key, "");
      if (this.key() === key && this.input.value.trim() === text) { this.input.value = ""; this.saveDraft(); }
      this.requests.delete(key);
    } catch (error) { this.toast(error.message); }
    finally { this.sending = false; this.render(); }
  }
  render() {
    const snapshot = this.snapshot, current = this.current(), threads = snapshot?.threads || [];
    const requestCount = threads.filter(thread => thread.pendingRequest).length;
    $("#open-agents").textContent = requestCount ? `Agents · ${requestCount} need input` : threads.length ? `Agents · ${threads.length}` : "Agents";
    this.picker.replaceChildren(new Option("Main chat — return to its composer", ""));
    for (const thread of threads) this.picker.add(new Option(`${thread.name} · ${thread.role} · ${thread.pendingRequest ? "input needed" : thread.status}`, thread.id));
    this.picker.value = this.selected || "";
    $("#agents-status").textContent = this.connecting ? "Connecting to the chat's native agents…" : !snapshot?.awake ? "Saved snapshot · worker asleep. Connect to refresh or send." : threads.length ? "Native threads belonging to this chat. Main chat continues independently." : "No child agents in this chat yet.";
    $("#agents-refresh").textContent = snapshot?.awake ? "Refresh agents" : "Connect to agents";
    $("#agents-refresh").disabled = this.connecting || Boolean(this.getChat()?.archived);
    $("#agents-limit").hidden = !snapshot?.truncated;
    $("#agents-form").hidden = !current;
    $("#agents-send").disabled = this.sending || !snapshot?.awake || current?.canAcceptDirectInput === false;
    $("#agents-send").textContent = current?.status === "active" ? "Send to running agent" : "Send to agent";
    $("#agents-stop").hidden = !snapshot?.awake || current?.status !== "active";
    $("#agents-error").textContent = current?.error || "";
    $("#agents-older").hidden = !snapshot?.awake || !(this.page?.nextCursor || !this.page && current?.nextCursor);
    $("#agents-latest").hidden = !this.page;
    const atBottom = this.messages.scrollHeight - this.messages.scrollTop - this.messages.clientHeight < 80;
    const messages = this.page?.messages || current?.messages || [];
    const contentKey = JSON.stringify([this.selected, messages]);
    if (contentKey !== this.contentKey) {
      this.contentKey = contentKey; this.messages.replaceChildren();
      if (current && !messages.length) this.messages.append(node("p", current.historyLoaded ? "No visible messages in this agent thread." : "Select this agent while connected to load its recent messages.", "muted"));
      for (const message of messages) {
        const article = node("article", "", "side-message"), content = node("div", "");
        article.append(node("strong", message.role === "user" ? "Input · agent thread" : message.role === "tool" ? "Tool activity" : `${current?.name || "Agent"} · response`));
        if (message.role === "tool") { const details = node("details", ""); details.append(node("summary", "Tool details"), node("pre", message.text)); content.append(details); }
        else renderContent(content, message.text, { onPreview: this.onPreview });
        article.append(content); this.messages.append(article);
      }
      if (atBottom && !this.page) this.messages.scrollTop = this.messages.scrollHeight;
    }
    const request = current?.pendingRequest, key = this.key(), approval = $("#agents-approval");
    renderAgentRequest(approval, request, `${key}:${request?.requestId}`, async payload => {
      if (this.key() !== key || this.current()?.pendingRequest?.requestId !== request.requestId) return;
      const controls = [...approval.querySelectorAll("button, input, textarea")]; if (controls.some(control => control.disabled)) return;
      controls.forEach(control => { control.disabled = true; });
      try { await this.action("respond", { ...payload, requestId: request.requestId }); } catch (error) { this.toast(error.message); }
      finally { controls.forEach(control => { control.disabled = false; }); }
    });
  }
}
