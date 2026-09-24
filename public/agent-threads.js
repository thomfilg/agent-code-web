import { openSidePanel, closeSidePanel } from "./side-panels.js";
import { renderContent } from "./message-content.js";
import { renderAgentRequest } from "./agent-request.js";
import { companyForChat } from "./company-scope.js";

const $ = selector => document.querySelector(selector);
const node = (tag, text, className = "") => { const value = document.createElement(tag); value.textContent = text; value.className = className; return value; };

export class AgentThreadsPanel {
  constructor({ api, getChat, toast, onPreview }) {
    Object.assign(this, { api, getChat, toast, onPreview }); this.version = 0; this.chatEpoch = 0;
    this.drafts = new Map(); this.draftEdits = new Map(); this.requests = new Map();
    this.panel = $("#agents-panel"); this.input = $("#agents-input"); this.messages = $("#agents-messages"); this.picker = $("#agents-picker");
    this.list = $("#agents-list"); this.dialog = $("#agent-conversation-dialog");
    $("#close-agent-conversation").onclick = () => this.dialog.close();
    this.dialog.addEventListener("close", () => {
      this.saveDraft(); this.version++;
      const button = [...this.list.querySelectorAll("button")].find(button => button.dataset.threadId === this.selected);
      if (!this.panel.hidden) (button || $("#agents-refresh")).focus({ preventScroll: true });
    });
    $("#open-agents").onclick = () => this.open().catch(error => toast(error.message));
    $("#hide-agents").onclick = () => this.hide();
    $("#agents-refresh").onclick = () => this.connect().catch(error => toast(error.message));
    this.picker.onchange = () => this.select(this.picker.value).catch(error => toast(error.message));
    $("#agents-older").onclick = () => this.select(this.selected, this.page?.nextCursor || this.current()?.nextCursor).catch(error => toast(error.message));
    $("#agents-latest").onclick = () => this.select(this.selected).catch(error => toast(error.message));
    $("#agents-form").onsubmit = event => { event.preventDefault(); void this.send(); };
    $("#agents-stop").onclick = () => this.action("stop").catch(error => toast(error.message));
    this.input.oninput = () => {
      if (this.selected) this.draftEdits.set(this.key(), (this.draftEdits.get(this.key()) || 0) + 1);
      this.saveDraft();
    };
    this.input.onkeydown = event => { if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); void this.send(); } };
  }
  key(id = this.selected) { return `${this.scope}:${this.snapshot?.rootThreadId}:${id}`; }
  current() { return this.snapshot?.threads.find(thread => thread.id === this.selected); }
  saveDraft() { if (this.selected) this.drafts.set(this.key(), this.input.value); }
  hide() { this.saveDraft(); this.version++; this.dialog.close(); closeSidePanel("agents"); $("#message-input").focus(); }
  setChat(chat) {
    $("#open-agents").hidden = !["codex", "claude"].includes(chat?.agent);
    const scope = JSON.stringify([chat?.id, chat?.ownerId, chat?.agent, chat?.agentAccountId, chat?.environmentId, chat?.workspace, companyForChat(chat || {})]);
    const identity = `${scope}:${chat?.agentSessionId}`;
    if (this.identity === identity) return;
    this.chatEpoch++;
    if (this.scope === scope && !this.nativeRoot) { this.nativeRoot = chat?.agentSessionId; this.identity = identity; return; }
    this.saveDraft(); this.version++; this.identity = identity; this.chatId = chat?.id;
    this.scope = scope; this.dialog.close();
    this.nativeRoot = chat?.agentSessionId; this.agent = chat?.agent;
    this.snapshot = null; this.selected = null; this.page = null; this.input.value = "";
    closeSidePanel("agents"); this.render();
  }
  update(snapshot, chatId) {
    if (this.chatId !== chatId || !["codex", "claude"].includes(this.getChat()?.agent)) return;
    if ((snapshot.rootThreadId || null) !== (this.getChat()?.agentSessionId || null)) return;
    if (snapshot.epoch === this.snapshot?.epoch && snapshot.revision < this.snapshot.revision) return;
    this.snapshot = snapshot; this.render();
  }
  async refresh() {
    const chatId = this.chatId, epoch = this.chatEpoch, previous = this.snapshot;
    if (!chatId || !["codex", "claude"].includes(this.getChat()?.agent)) return;
    try {
      const snapshot = await this.api(`/api/chats/${chatId}/subagents`);
      if (epoch === this.chatEpoch && (previous === this.snapshot || snapshot.epoch === this.snapshot?.epoch)) this.update(snapshot, chatId);
    } catch { /* Opening reports errors; SSE reconnect can retry safely. */ }
  }
  async open() {
    const chatId = this.chatId, epoch = this.chatEpoch, version = ++this.version, previous = this.snapshot;
    if (!chatId) throw new Error("Select a chat first");
    openSidePanel("agents");
    const snapshot = await this.api(`/api/chats/${chatId}/subagents`);
    if (epoch !== this.chatEpoch || version !== this.version) return;
    if (previous === this.snapshot || snapshot.epoch === this.snapshot?.epoch) this.update(snapshot, chatId);
    if (!this.panel.hidden) (this.list.querySelector("button") || $("#agents-refresh")).focus();
  }
  async connect() {
    const chatId = this.chatId, epoch = this.chatEpoch, previous = this.snapshot;
    if (this.connecting) return;
    this.connecting = true; this.render();
    try {
      const snapshot = await this.api(`/api/chats/${chatId}/subagents`, { method: "POST" });
      if (epoch === this.chatEpoch && (previous === this.snapshot || snapshot.epoch === this.snapshot?.epoch)) this.update(snapshot, chatId);
    }
    finally { this.connecting = false; this.render(); }
  }
  async select(id, cursor = null) {
    this.saveDraft();
    if (!id) { this.selected = null; this.hide(); return; }
    const chatId = this.chatId, version = ++this.version, epoch = this.snapshot?.epoch;
    this.selected = id; this.page = null; this.input.value = this.drafts.get(this.key(id)) || ""; this.render();
    if (!this.dialog.open) this.dialog.showModal();
    if (!this.snapshot?.awake) return; // Cached messages do not wake a worker.
    const result = await this.action("select", { cursor });
    if (this.chatId !== chatId || this.selected !== id || version !== this.version || epoch !== this.snapshot?.epoch) return;
    if (cursor) this.page = result.page;
    this.render(); if (!cursor) { this.messages.scrollTop = this.messages.scrollHeight; (this.agent === "claude" ? $("#close-agent-conversation") : this.input).focus(); }
  }
  async action(action, payload = {}) {
    const chatId = this.chatId, epoch = this.chatEpoch, previous = this.snapshot, threadId = this.selected, rootThreadId = this.snapshot?.rootThreadId;
    if (!threadId || !rootThreadId) throw new Error("Choose an agent thread first");
    const result = await this.api(`/api/chats/${chatId}/subagents/${action}`, { method: "POST", body: JSON.stringify({ ...payload, threadId, rootThreadId }) });
    if (epoch === this.chatEpoch && (previous === this.snapshot || result.epoch === this.snapshot?.epoch)) this.update(result, chatId); return result;
  }
  async send() {
    const text = this.input.value.trim(), key = this.key(), edit = this.draftEdits.get(key) || 0;
    if (!text || this.sending || !this.current() || !this.snapshot?.awake || this.agent === "claude" || this.current().canAcceptDirectInput === false) return;
    let attempt = this.requests.get(key);
    if (!attempt || attempt.text !== text) { attempt = { text, requestId: crypto.randomUUID() }; this.requests.set(key, attempt); }
    this.sending = true; this.render();
    try {
      await this.action("messages", attempt);
      // Equal text is not necessarily the submitted draft: the user may have
      // returned to this chat and typed it again while the receipt was pending.
      if ((this.draftEdits.get(key) || 0) === edit) {
        if (this.drafts.get(key)?.trim() === text) this.drafts.set(key, "");
        if (this.key() === key && this.input.value.trim() === text) { this.input.value = ""; this.saveDraft(); }
      }
      this.requests.delete(key);
    } catch (error) { this.toast(error.message); }
    finally { this.sending = false; this.render(); }
  }
  render() {
    const snapshot = this.snapshot, current = this.current(), threads = snapshot?.threads || [];
    const claude = this.agent === "claude", focusedId = this.list.contains(document.activeElement) ? document.activeElement.dataset.threadId : null;
    this.list.replaceChildren();
    for (const thread of threads) {
      const row = node("li", ""), button = node("button", "", "agent-thread-card"); button.type = "button"; button.dataset.threadId = thread.id;
      button.setAttribute("aria-label", `Open agent ${thread.name}`);
      button.append(node("strong", thread.name), node("small", `${thread.role} · ${!snapshot.awake ? "offline snapshot" : thread.pendingRequest ? "input needed" : thread.status}`));
      if (thread.lastTool) button.append(node("small", `Latest tool: ${thread.lastTool}`));
      button.onclick = () => this.select(thread.id).catch(error => this.toast(error.message)); row.append(button); this.list.append(row);
    }
    if (!threads.length) this.list.append(node("li", "No observed child agents yet.", "muted"));
    if (focusedId && document.activeElement === document.body) [...this.list.querySelectorAll("button")].find(button => button.dataset.threadId === focusedId)?.focus({ preventScroll: true });
    const requestCount = threads.filter(thread => thread.pendingRequest).length;
    $("#open-agents").textContent = requestCount ? `Agents · ${requestCount} need input` : threads.length ? `Agents · ${threads.length}` : "Agents";
    this.picker.replaceChildren(new Option("Main chat — return to its composer", ""));
    for (const thread of threads) this.picker.add(new Option(`${thread.name} · ${thread.role} · ${thread.pendingRequest ? "input needed" : thread.status}`, thread.id));
    this.picker.value = this.selected || "";
    $("#agents-status").textContent = this.connecting ? "Connecting to the chat's native agents…" : !snapshot?.awake ? "Saved snapshot · native process offline. Connect explicitly to refresh." : claude ? snapshot.coverage || "Observed native children. Main chat continues independently." : threads.length ? "Native threads belonging to this chat. Main chat continues independently." : "No child agents in this chat yet.";
    $("#agent-conversation-title").textContent = current?.name || "Agent conversation";
    $("#agent-conversation-status").textContent = current ? `${current.role} · ${!snapshot?.awake ? "offline snapshot" : current.stopping ? "Waiting for native Stop confirmation" : current.status}` : "";
    $("#agent-conversation-capability").hidden = !claude;
    $("#agent-conversation-capability").textContent = claude ? "Public conversation observed by this process only; earlier history is unavailable. Direct messaging to this child is not supported by this Claude interface. Stop affects only this child, not the main conversation." : "";
    $("#agents-refresh").textContent = snapshot?.awake ? "Refresh agents" : "Connect to agents";
    $("#agents-refresh").disabled = this.connecting || Boolean(this.getChat()?.archived);
    $("#agents-limit").hidden = !snapshot?.truncated;
    $("#agents-form").hidden = !current || claude;
    $("#agents-send").disabled = this.sending || !snapshot?.awake || current?.canAcceptDirectInput === false;
    $("#agents-send").textContent = current?.status === "active" ? "Send to running agent" : "Send to agent";
    $("#agents-stop").hidden = !snapshot?.awake || (claude ? !current?.canStop : current?.status !== "active");
    $("#agents-error").textContent = current?.error || "";
    $("#agents-older").hidden = !snapshot?.awake || !(this.page?.nextCursor || !this.page && current?.nextCursor);
    $("#agents-latest").hidden = !this.page;
    const atBottom = this.messages.scrollHeight - this.messages.scrollTop - this.messages.clientHeight < 80;
    const messages = this.page?.messages || current?.messages || [];
    const contentKey = JSON.stringify([this.selected, messages]);
    if (contentKey !== this.contentKey) {
      this.contentKey = contentKey; this.messages.replaceChildren();
      if (current && !messages.length) this.messages.append(node("p", current.historyLimited ? "History omitted because the saved preview reached its size limit." : claude ? "No public messages observed for this child in the current process." : current.historyLoaded ? "No visible messages in this agent thread." : "Select this agent while connected to load its recent messages.", "muted"));
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
