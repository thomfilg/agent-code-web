const state = {
  config: null,
  chats: [],
  active: null,
  stream: null,
  liveTools: new Map(),
  eventSource: null,
};

const $ = (selector) => document.querySelector(selector);
const elements = {
  sidebar: $("#sidebar"),
  chatList: $("#chat-list"),
  welcome: $("#welcome"),
  conversation: $("#conversation"),
  title: $("#chat-title"),
  meta: $("#chat-meta"),
  actions: $("#chat-actions"),
  messages: $("#messages"),
  status: $("#runtime-status"),
  detail: $("#runtime-detail"),
  statusDot: $("#status-dot"),
  countdown: $("#countdown"),
  input: $("#message-input"),
  send: $("#send-button"),
  composerAgent: $("#composer-agent"),
  approval: $("#approval-card"),
  newDialog: $("#new-chat-dialog"),
  newForm: $("#new-chat-form"),
  agentSelect: $("#agent-select"),
  dialogSecurity: $("#dialog-security"),
  loginDialog: $("#login-dialog"),
};

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: "same-origin",
    ...options,
    headers: { "content-type": "application/json", ...(options.headers || {}) },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `Request failed (${response.status})`);
  return payload;
}

function escapeTime(date) {
  const value = new Date(date);
  const seconds = Math.max(0, Math.floor((Date.now() - value.getTime()) / 1000));
  if (seconds < 60) return "now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

function glyph(agent) {
  return agent === "claude" ? "C" : agent === "mock" ? "M" : "X";
}

function agentLabel(agent) {
  return state.config?.agents.find((item) => item.id === agent)?.label || agent;
}

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function renderChats() {
  elements.chatList.replaceChildren();
  if (!state.chats.length) {
    elements.chatList.append(node("div", "chat-list-empty", "No conversations yet. Create one when an idea is ready."));
    return;
  }
  for (const chat of state.chats) {
    const button = node("button", `chat-item${state.active?.id === chat.id ? " active" : ""}`);
    button.type = "button";
    button.addEventListener("click", () => selectChat(chat.id));
    const top = node("div", "chat-item-top");
    top.append(node("span", "agent-glyph", glyph(chat.agent)), node("span", "chat-item-title", chat.title));
    const meta = node("div", "chat-item-meta");
    meta.append(node("span", `mini-status ${chat.status}`), node("span", "", agentLabel(chat.agent)), node("span", "", `· ${escapeTime(chat.updatedAt)}`));
    button.append(top, meta);
    elements.chatList.append(button);
  }
}

function updateChatSummary(chat) {
  const index = state.chats.findIndex((item) => item.id === chat.id);
  const summary = { ...chat, messageCount: chat.messages?.length ?? chat.messageCount ?? 0 };
  delete summary.messages;
  delete summary.pendingRequest;
  if (index >= 0) state.chats[index] = { ...state.chats[index], ...summary };
  else state.chats.unshift(summary);
  state.chats.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  renderChats();
}

function renderMessage(message, streaming = false) {
  if (message.kind === "tool") {
    const running = message.meta?.state === "running";
    const wrapper = node("article", `message tool${running ? " running" : ""}`);
    wrapper.dataset.messageId = message.id;
    wrapper.append(node("div", "message-avatar", "⌁"));
    const details = node("details", "tool-details");
    const label = message.meta?.title || message.text || "Tool activity";
    const summary = node("summary", "", running ? `${label} · running` : label);
    details.append(summary);
    if (message.meta?.output) details.append(node("pre", "tool-output", message.meta.output));
    wrapper.append(details);
    return wrapper;
  }
  const role = message.role || "system";
  const wrapper = node("article", `message ${role}${message.kind === "error" ? " error" : ""}`);
  wrapper.dataset.messageId = message.id || "stream";
  wrapper.append(node("div", "message-avatar", role === "assistant" ? glyph(state.active?.agent) : role === "user" ? "YOU" : "!"));
  const body = node("div", "message-body");
  body.append(node("div", "message-label", role === "assistant" ? agentLabel(state.active?.agent) : role));
  const text = node("div", "message-text", message.text || "");
  if (streaming) text.append(node("span", "stream-caret"));
  body.append(text);
  wrapper.append(body);
  return wrapper;
}

function renderMessages({ pinBottom = false } = {}) {
  if (!state.active) return;
  const wasNearBottom = elements.messages.scrollHeight - elements.messages.scrollTop - elements.messages.clientHeight < 110;
  elements.messages.replaceChildren();
  const persisted = state.active.messages || [];
  if (!persisted.length && !state.stream && !state.liveTools.size) {
    elements.messages.append(node("div", "messages-empty", "This workspace is ready.\nSend a message to wake the agent."));
  } else {
    for (const message of persisted) elements.messages.append(renderMessage(message));
    for (const tool of state.liveTools.values()) {
      elements.messages.append(renderMessage({ id: `live-${tool.itemId}`, kind: "tool", role: "tool", text: tool.title, meta: tool }));
    }
    if (state.stream) elements.messages.append(renderMessage({ id: state.stream.id, role: "assistant", text: state.stream.text }, true));
  }
  if (pinBottom || wasNearBottom) elements.messages.scrollTop = elements.messages.scrollHeight;
}

function renderApproval() {
  const request = state.active?.pendingRequest;
  elements.approval.replaceChildren();
  elements.approval.hidden = !request;
  if (!request) return;
  elements.approval.append(node("h3", "", request.method.includes("requestUserInput") ? "The agent has a question" : "Approval required"));
  elements.approval.append(node("p", "", request.prompt));
  if (request.command) elements.approval.append(node("code", "", request.command));
  const actions = node("div", "approval-actions");
  if (request.questions?.length) {
    const answers = {};
    for (const question of request.questions) {
      const label = node("label", "");
      label.append(node("p", "", question.question));
      const input = node("input", "question-input");
      input.placeholder = question.header || "Answer";
      input.addEventListener("input", () => { answers[question.id] = input.value; });
      label.append(input);
      elements.approval.append(label);
    }
    const answer = node("button", "approve", "Answer");
    answer.addEventListener("click", () => resolveRequest({ answers }));
    actions.append(answer);
  } else {
    const once = node("button", "approve", "Approve once");
    once.addEventListener("click", () => resolveRequest({ decision: "accept" }));
    const session = node("button", "secondary-button", "For this session");
    session.addEventListener("click", () => resolveRequest({ decision: "acceptForSession" }));
    const deny = node("button", "deny", "Deny");
    deny.addEventListener("click", () => resolveRequest({ decision: "decline" }));
    actions.append(once, session, deny);
  }
  elements.approval.append(actions);
}

function renderActive() {
  const chat = state.active;
  elements.welcome.hidden = Boolean(chat);
  elements.conversation.hidden = !chat;
  elements.actions.hidden = !chat;
  if (!chat) {
    elements.title.textContent = "Agent Relay";
    elements.meta.textContent = "Independent workspaces. Disposable runtimes.";
    return;
  }
  elements.title.textContent = chat.title;
  const runtimeLabel = chat.runtimeMetadata?.instanceId ? ` · ${chat.runtimeMetadata.instanceId}` : "";
  elements.meta.textContent = `${agentLabel(chat.agent)}${runtimeLabel} · ${chat.workspace}`;
  elements.status.textContent = chat.status;
  elements.detail.textContent = chat.statusDetail || "";
  elements.statusDot.className = `status-dot ${chat.status}`;
  $("#stop-button").disabled = chat.status === "stopped";
  elements.send.disabled = chat.status === "running" || chat.status === "starting";
  elements.input.disabled = chat.status === "running" || chat.status === "starting";
  elements.composerAgent.replaceChildren(node("span", "agent-glyph", glyph(chat.agent)), node("span", "", agentLabel(chat.agent)));
  renderMessages();
  renderApproval();
  tickCountdown();
}

function tickCountdown() {
  const deadline = state.active?.idleDeadlineAt ? new Date(state.active.idleDeadlineAt).getTime() : 0;
  if (!deadline || state.active?.status !== "idle") {
    elements.countdown.textContent = "";
    return;
  }
  const seconds = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
  elements.countdown.textContent = `SLEEPS IN ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

async function selectChat(id) {
  state.eventSource?.close();
  state.stream = null;
  state.liveTools.clear();
  try {
    state.active = (await api(`/api/chats/${id}`)).chat;
    renderChats();
    renderActive();
    elements.sidebar.classList.remove("open");
    connectEvents(id);
    requestAnimationFrame(() => { elements.messages.scrollTop = elements.messages.scrollHeight; });
  } catch (error) { toast(error.message); }
}

function connectEvents(chatId) {
  const source = new EventSource(`/api/chats/${chatId}/events`, { withCredentials: true });
  state.eventSource = source;
  source.onmessage = ({ data }) => {
    if (state.active?.id !== chatId) return;
    const event = JSON.parse(data);
    if (event.type === "chat_updated") {
      state.active = { ...state.active, ...event.chat };
      updateChatSummary(event.chat);
      renderActive();
    } else if (event.type === "message") {
      if (event.message.kind === "tool" && event.message.meta?.itemId) state.liveTools.delete(event.message.meta.itemId);
      const index = state.active.messages.findIndex((message) => message.id === event.message.id);
      if (index >= 0) state.active.messages[index] = event.message;
      else state.active.messages.push(event.message);
      renderMessages({ pinBottom: true });
    } else if (event.type === "turn_started") {
      state.liveTools.clear();
      state.stream = { id: event.messageId, text: "" };
      renderMessages({ pinBottom: true });
    } else if (event.type === "assistant_delta") {
      if (!state.stream) state.stream = { id: "stream", text: "" };
      state.stream.text += event.delta || "";
      renderMessages({ pinBottom: true });
    } else if (event.type === "tool") {
      if (event.state === "running") state.liveTools.set(event.itemId, event);
      else state.liveTools.delete(event.itemId);
      renderMessages({ pinBottom: true });
    } else if (event.type === "turn_completed") {
      state.liveTools.clear();
      state.stream = null;
      if (!state.active.messages.some((message) => message.id === event.message.id)) state.active.messages.push(event.message);
      renderMessages({ pinBottom: true });
    } else if (event.type === "turn_failed") {
      state.liveTools.clear();
      state.stream = null;
      if (!state.active.messages.some((message) => message.id === event.message.id)) state.active.messages.push(event.message);
      renderMessages({ pinBottom: true });
    } else if (event.type === "request") {
      state.active.pendingRequest = event.request;
      renderApproval();
    } else if (event.type === "request_resolved") {
      state.active.pendingRequest = null;
      renderApproval();
    } else if (event.type === "runtime_error") {
      toast(event.text);
    }
  };
  source.onerror = () => {
    if (state.active?.id === chatId) elements.detail.textContent = "Live connection interrupted; reconnecting…";
  };
}

async function resolveRequest(payload) {
  const request = state.active?.pendingRequest;
  if (!request) return;
  try {
    await api(`/api/chats/${state.active.id}/requests/${request.requestId}/respond`, { method: "POST", body: JSON.stringify(payload) });
    state.active.pendingRequest = null;
    renderApproval();
  } catch (error) { toast(error.message); }
}

function openNewChat() {
  elements.newForm.reset();
  $("#workspace-source").value = state.config?.workspaceSource || "";
  renderSecurityHint();
  elements.newDialog.showModal();
}

function renderSecurityHint() {
  const agent = state.config?.agents.find((item) => item.id === elements.agentSelect.value);
  elements.dialogSecurity.replaceChildren();
  if (!agent) return;
  if (agent.authMode === "gateway") {
    const strong = node("strong", "", "Gateway protected. ");
    elements.dialogSecurity.append(strong, document.createTextNode("The long-lived provider key remains in the control plane; this worker receives a short-lived chat capability."));
  } else if (agent.authMode === "host") {
    elements.dialogSecurity.append(node("strong", "", "Local login mode. "), document.createTextNode("This reuses the CLI credential store and is intended for a local POC, not a hardened deployment."));
  } else {
    elements.dialogSecurity.textContent = "Mock mode makes no provider request and is safe for testing the interface and autosleep lifecycle.";
  }
}

async function createChat(event) {
  event.preventDefault();
  const submitter = event.submitter;
  if (submitter?.value === "cancel") return elements.newDialog.close();
  submitter.disabled = true;
  try {
    const payload = {
      agent: elements.agentSelect.value,
      title: $("#new-chat-title").value,
      source: $("#workspace-source").value,
    };
    const { chat } = await api("/api/chats", { method: "POST", body: JSON.stringify(payload) });
    updateChatSummary(chat);
    elements.newDialog.close();
    await selectChat(chat.id);
    elements.input.focus();
  } catch (error) { toast(error.message); }
  finally { submitter.disabled = false; }
}

async function sendMessage(event) {
  event.preventDefault();
  const text = elements.input.value.trim();
  if (!text || !state.active) return;
  elements.input.value = "";
  resizeInput();
  try {
    await api(`/api/chats/${state.active.id}/messages`, { method: "POST", body: JSON.stringify({ text }) });
  } catch (error) {
    elements.input.value = text;
    resizeInput();
    toast(error.message);
  }
}

function resizeInput() {
  elements.input.style.height = "auto";
  elements.input.style.height = `${Math.min(elements.input.scrollHeight, 170)}px`;
}

function toast(message) {
  const item = node("div", "toast", message);
  $("#toasts").append(item);
  setTimeout(() => item.remove(), 5500);
}

async function boot() {
  const auth = await api("/api/auth");
  if (auth.required && !auth.authenticated) {
    elements.loginDialog.showModal();
    return;
  }
  state.config = await api("/api/config");
  state.chats = (await api("/api/chats")).chats;
  elements.agentSelect.replaceChildren();
  for (const agent of state.config.agents.filter((item) => item.enabled)) {
    const option = node("option", "", agent.label);
    option.value = agent.id;
    elements.agentSelect.append(option);
  }
  $("#isolation-label").textContent = state.config.workerBackend === "ec2"
    ? "One EC2 worker per chat"
    : state.config.processIsolation === "namespace" ? "Private PID namespaces" : "Process isolation disabled";
  renderChats();
  if (state.chats.length) await selectChat(state.chats[0].id);
  else renderActive();
}

$("#login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await api("/api/session", { method: "POST", body: JSON.stringify({ token: $("#login-token").value }) });
    elements.loginDialog.close();
    await boot();
  } catch (error) { $("#login-error").textContent = error.message; }
});
$("#new-chat-button").addEventListener("click", openNewChat);
$("#welcome-new-chat").addEventListener("click", openNewChat);
elements.newForm.addEventListener("submit", createChat);
elements.agentSelect.addEventListener("change", renderSecurityHint);
$("#composer").addEventListener("submit", sendMessage);
elements.input.addEventListener("input", resizeInput);
elements.input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    $("#composer").requestSubmit();
  }
});
$("#stop-button").addEventListener("click", async () => {
  if (!state.active) return;
  try { await api(`/api/chats/${state.active.id}/stop`, { method: "POST", body: "{}" }); }
  catch (error) { toast(error.message); }
});
$("#delete-button").addEventListener("click", async () => {
  if (!state.active || !confirm(`Delete “${state.active.title}” and its workspace?`)) return;
  try {
    const id = state.active.id;
    await api(`/api/chats/${id}`, { method: "DELETE" });
    state.eventSource?.close();
    state.chats = state.chats.filter((chat) => chat.id !== id);
    state.active = null;
    renderChats();
    if (state.chats.length) await selectChat(state.chats[0].id);
    else renderActive();
  } catch (error) { toast(error.message); }
});
$("#open-sidebar").addEventListener("click", () => elements.sidebar.classList.add("open"));
$("#close-sidebar").addEventListener("click", () => elements.sidebar.classList.remove("open"));
document.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    openNewChat();
  }
});
setInterval(() => { tickCountdown(); renderChats(); }, 1000);

boot().catch((error) => toast(error.message));
