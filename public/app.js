import { ChatSidebar } from "./chat-sidebar.js";
import { stateLabel } from "./chat-organization.js";
import { WorkspaceSettings } from "./workspace-settings.js";
import { ModelPicker } from "./model-picker.js";

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
  sidebar.render();
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
  $("#organize-chat-button").textContent = stateLabel(chat.workflowState);
  const runtimeLabel = chat.runtimeMetadata?.instanceId ? ` · ${chat.runtimeMetadata.instanceId}` : "";
  elements.meta.textContent = `${agentLabel(chat.agent)}${runtimeLabel} · ${chat.workspace}`;
  elements.status.textContent = chat.status;
  elements.detail.textContent = chat.statusDetail || "";
  elements.statusDot.className = `status-dot ${chat.status}`;
  $("#stop-button").disabled = chat.status === "stopped";
  const unavailable = ["running", "starting", "stopping"].includes(chat.status) || chat.workflowState === "archived";
  elements.send.disabled = unavailable;
  elements.input.disabled = unavailable;
  elements.input.placeholder = chat.workflowState === "archived" ? "Archived · unarchive this chat to continue" : "Ask your agent to build, inspect, or fix something…";
  elements.composerAgent.replaceChildren(node("span", "agent-glyph", glyph(chat.agent)), node("span", "", agentLabel(chat.agent)));
  activeModelPicker.setAgent(chat.agent, chat);
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
  await activeModelPicker.saving?.catch(() => {});
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
      // EventSource replays turn history on reconnect; old snapshots must not
      // undo newer pins, moves, names or states already fetched from the API.
      if ((event.chat.revision || 0) < (state.active.revision || 0) || event.chat.updatedAt < state.active.updatedAt) return;
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

async function openNewChat() {
  elements.newForm.reset();
  renderSecurityHint();
  $("#create-chat-error").textContent = "";
  elements.newDialog.showModal();
  try { await workspaceSettings.openNew(); renderSecurityHint(); }
  catch (error) { $("#create-chat-error").textContent = error.message; }
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
  const originalLabel = submitter.textContent;
  submitter.textContent = "Checking repositories…";
  $("#create-chat-error").textContent = "";
  try {
    await workspaceSettings.modelPicker.saving;
    const payload = workspaceSettings.payload();
    const initialPrompt = $("#initial-prompt").value.trim();
    const { chat } = await api("/api/chats", { method: "POST", body: JSON.stringify(payload) });
    await workspaceSettings.remember();
    updateChatSummary(chat);
    elements.newDialog.close();
    await selectChat(chat.id);
    if (initialPrompt) {
      try { await api(`/api/chats/${chat.id}/messages`, { method: "POST", body: JSON.stringify({ text: initialPrompt }) }); }
      catch (error) { elements.input.value = initialPrompt; resizeInput(); toast(error.message); }
    }
    elements.input.focus();
  } catch (error) { $("#create-chat-error").textContent = error.message; }
  finally { submitter.disabled = false; submitter.textContent = originalLabel; }
}

async function sendMessage(event) {
  event.preventDefault();
  const text = elements.input.value.trim();
  if (!text || !state.active) return;
  elements.input.value = "";
  resizeInput();
  try {
    await activeModelPicker.saving;
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
  const dialog = [...document.querySelectorAll("dialog[open]")].at(-1);
  if (dialog) {
    let error = dialog.querySelector("[role=alert]");
    if (!error) { error = node("p", "form-error"); error.setAttribute("role", "alert"); dialog.querySelector("form, .dialog-card")?.append(error); }
    error.textContent = message;
    return;
  }
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
  await sidebar.refresh();
  sidebar.connect();
  elements.agentSelect.replaceChildren();
  for (const agent of state.config.agents.filter((item) => item.enabled)) {
    const option = node("option", "", agent.label);
    option.value = agent.id;
    elements.agentSelect.append(option);
  }
  await workspaceSettings.load();
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
const sidebar = new ChatSidebar({ state, api, select: selectChat, toast, age: escapeTime, agentLabel,
  updated: chat => {
    updateChatSummary(chat);
    if (state.active?.id === chat.id) { state.active = { ...state.active, ...chat }; renderActive(); }
  },
});
const workspaceSettings = new WorkspaceSettings({ state, api, toast });
const activeModelPicker = new ModelPicker({ root: $("#composer-model-controls"), api, onChange: async settings => {
  if (!state.active) return;
  const id = state.active.id;
  const { chat } = await api(`/api/chats/${id}/model`, { method: "PATCH", body: JSON.stringify(settings) });
  updateChatSummary(chat);
  if (state.active?.id === id) state.active = { ...state.active, ...chat };
} });
setInterval(tickCountdown, 1000);

boot().catch((error) => toast(error.message));
