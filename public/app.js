import { ChatSidebar } from "./chat-sidebar.js";
import { GoogleLogin } from "./google-login.js";
import { AgentAccountSettings } from "./agent-accounts.js";
import { closeSidePanel } from "./side-panels.js";
import { WorkspaceSettings } from "./workspace-settings.js";
import { ModelPicker } from "./model-picker.js";
import { ChatControls } from "./chat-controls.js";
import { renderContent } from "./message-content.js";
import { ToolActivity, groupTools } from "./tool-activity.js";
import { UsagePanel } from "./usage-panel.js";
import { SlashComposer } from "./slash-composer.js";
import { McpSettings } from "./mcp-settings.js";
import { MessageHistory } from "./message-history.js";
import { MessageNavigator } from "./message-navigator.js";
import { DocumentPreview } from "./document-preview.js";
import { SharedBrowserPanel } from "./shared-browser.js";
import { AppPreviewDialog } from "./app-preview.js";
import { BrowserConnectionSettings } from "./browser-connections.js";
import { setupPanelResizers } from "./panel-resizers.js";
import { MessageWindow } from "./message-window.js";
import { ChatPresence } from "./chat-presence.js";
import { WEB_COMMAND_ALIASES } from "./web-commands.js";
import { renderAgentRequest } from "./agent-request.js";
import { SideChatPanel } from "./side-chat.js";
import { AgentThreadsPanel } from "./agent-threads.js";
import { WorkspaceContext } from "./workspace-context.js";
import { NativeAppsPicker } from "./native-apps.js";
import { NativePluginsPicker } from "./native-plugins.js";
import { NativeHooksBrowser } from "./native-hooks.js";
import { NativeFeaturesPicker } from "./native-features.js";
import { NativeMemoriesControls } from "./native-memories.js";
import { NativeImportsControls } from "./native-imports.js";
import { NativeApprovalControls } from "./native-approvals.js";
import { NativeFeedbackControls } from "./native-feedback.js";
import { NativeLogoutControls } from "./native-logout.js";
import { KeymapControls } from "./keymap-controls.js";
import { VimComposer } from "./vim-composer.js";
import { StatusLineControls } from "./statusline-controls.js";
import { TabTitleControls } from "./tab-title-controls.js";
import { SyntaxThemeControls } from "./syntax-theme-controls.js";
import { PetControls } from "./pet-controls.js";
import { DesktopHandoff } from "./desktop-handoff.js";
import { ClaudeWorkspaceTrustControls } from "./claude-workspace-trust.js";

const state = {
  config: null,
  chats: [],
  active: null,
  stream: null,
  liveTools: new Map(),
  queueActions: new Map(),
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
  agentPicker: $("#chat-agent-select"),
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
  if (response.status === 401 && state.config?.features.googleLogin) window.dispatchEvent(new Event("relay-auth-required"));
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
  wrapper.append(node("div", "message-avatar", role === "assistant" ? glyph(message.agent || state.active?.agent) : role === "user" ? "YOU" : "!"));
  const body = node("div", "message-body");
  body.append(node("div", "message-label", role === "assistant" ? agentLabel(message.agent || state.active?.agent) : role));
  const text = node("div", "message-text");
  renderContent(text, message.text || "", { onPreview: preview => documentPreview.open({ ...preview, messageId: message.id }) });
  if (streaming) text.append(node("span", "stream-caret"));
  body.append(text);
  if (message.attachments?.length) {
    const files = node("div", "message-attachments");
    for (const file of message.attachments) files.append(file.id ? chatControls.attachmentButton(file, { messageId: message.id }) : node("span", "muted", file.name));
    body.append(files);
  }
  wrapper.append(body);
  return wrapper;
}

const messageWindow = new MessageWindow();
let adjustingMessageWindow = false;
let messageRenderVersion = 0;
function renderMessages({ pinBottom = false } = {}) {
  if (!state.active) return;
  const version = ++messageRenderVersion;
  const changedChat = messageWindow.chatId !== state.active.id;
  const wasNearBottom = elements.messages.scrollHeight - elements.messages.scrollTop - elements.messages.clientHeight < 110;
  const oldTop = elements.messages.getBoundingClientRect().top;
  const anchor = [...elements.messages.querySelectorAll(".message")].find(n => n.getBoundingClientRect().bottom > oldTop + 10);
  const anchorId = anchor?.dataset.messageId, anchorOffset = anchor ? anchor.getBoundingClientRect().top - oldTop : 0;
  adjustingMessageWindow = true;
  elements.messages.replaceChildren();
  const persisted = (state.active.messages || []).filter(message => !message.meta?.renderingSample);
  if (!persisted.length && !state.stream && !state.liveTools.size) {
    messageWindow.update(state.active.id, []);
    toolActivity.update(state.active.id, new Map());
    elements.messages.append(node("div", "messages-empty", "This workspace is ready.\nSend a message to wake the agent."));
  } else {
    const { rows, groups } = groupTools(persisted, [...state.liveTools.values()]);
    toolActivity.update(state.active.id, groups);
    const visible = messageWindow.update(state.active.id, rows);
    const pager = (label, action) => { const button = node("button", "message-page-button", label); button.type = "button"; button.onclick = action; return button; };
    if (messageWindow.start) elements.messages.append(pager(`Load earlier messages · ${messageWindow.start} above`, () => { messageNavigator.readingHistory = true; messageWindow.move(-1); renderMessages(); }));
    for (const message of visible) elements.messages.append(message.kind === "tool_group" ? toolActivity.button(message.key) : renderMessage(message));
    if (messageWindow.end < rows.length) {
      elements.messages.append(pager(`Load newer messages · ${rows.length - messageWindow.end} below`, () => { messageWindow.move(1); renderMessages(); }));
      elements.messages.append(pager("Jump to latest", () => { messageWindow.latest(); messageNavigator.readingHistory = false; renderMessages({ pinBottom: true }); }));
    } else if (state.stream) elements.messages.append(renderMessage({ id: state.stream.id, role: "assistant", text: state.stream.text }, true));
  }
  messageNavigator.update();
  if (messageWindow.tail && !messageNavigator.readingHistory && (changedChat || pinBottom || wasNearBottom)) elements.messages.scrollTop = elements.messages.scrollHeight;
  else if (anchorId) {
    const retained = [...elements.messages.querySelectorAll(".message")].find(n => n.dataset.messageId === anchorId);
    if (retained) elements.messages.scrollTop += retained.getBoundingClientRect().top - elements.messages.getBoundingClientRect().top - anchorOffset;
  }
  requestAnimationFrame(() => requestAnimationFrame(() => { if (version === messageRenderVersion) adjustingMessageWindow = false; }));
}

function renderApproval() {
  const request = state.active?.pendingRequest;
  const key = request ? `${state.active.id}:${request.requestId}` : null;
  const target = { chatId: state.active?.id, requestId: request?.requestId };
  renderAgentRequest(elements.approval, request, key, payload => resolveRequest(payload, target));
}

function renderActive() {
  const chat = state.active;
  statusline.render();
  tabTitle.render();
  pets.render();
  desktopHandoff.render();
  workspaceTrust.render();
  vimComposer.select();
  sideChat.setChat(chat);
  agentThreads.setChat(chat);
  workspaceContext.setChat(chat);
  chatPresence.select(chat?.id);
  documentPreview.setChat(chat?.id);
  sharedBrowser.setChat(chat?.id);
  appPreview.setChat(chat);
  browserConnectionSettings.setChat(chat?.id);
  elements.welcome.hidden = Boolean(chat);
  elements.conversation.hidden = !chat;
  elements.actions.hidden = !chat;
  if (!chat) {
    closeSidePanel("diff"); toolActivity.update(null, new Map());
    elements.messages.replaceChildren();
    elements.title.textContent = "Agent Relay";
    elements.meta.textContent = "Independent workspaces. Disposable runtimes.";
    return;
  }
  elements.title.textContent = chat.title;
  $("#organize-chat-button").textContent = "Rename / organize";
  const runtimeLabel = chat.runtimeMetadata?.instanceId ? ` · ${chat.runtimeMetadata.instanceId}` : "";
  const account = workspaceSettings.accounts?.find(item => item.id === chat.agentAccountId);
  elements.meta.textContent = `${agentLabel(chat.agent)}${account ? ` · ${account.name}` : ""}${runtimeLabel} · ${chat.workspace}`;
  elements.status.textContent = chat.status === "idle" && chat.idleKeepAwakeReason ? "Ready" : chat.status;
  elements.detail.textContent = chat.statusDetail || "";
  elements.statusDot.className = `status-dot ${chat.status}`;
  $("#stop-button").disabled = chat.status === "stopped";
  const switching = state.switchingChat === chat.id;
  const busy = ["running", "starting"].includes(chat.status);
  const unavailable = switching || chat.status === "stopping" || chat.workflowState === "archived";
  elements.send.disabled = unavailable;
  elements.input.disabled = unavailable;
  elements.send.type = busy ? "button" : "submit";
  elements.send.setAttribute("aria-label", busy ? "Stop agent" : "Send message");
  elements.send.querySelector("path").setAttribute("d", busy ? "M7 7h10v10H7z" : "m5 12 7-7 7 7M12 5v14");
  $("#queue-message").hidden = !busy; $("#queue-message").disabled = unavailable;
  renderKeyboardHints();
  elements.input.placeholder = chat.workflowState === "archived" ? "Archived · unarchive this chat to continue" : "Ask your agent to build, inspect, or fix something…";
  if (!elements.agentPicker.options.length) for (const agent of state.config.agents.filter(item => item.enabled)) {
    const option = node("option", "", agent.id === "claude" ? "Claude" : agent.label); option.value = agent.id; elements.agentPicker.append(option);
  }
  if (![...elements.agentPicker.options].some(option => option.value === chat.agent)) {
    const option = node("option", "", agentLabel(chat.agent)); option.value = chat.agent; option.disabled = true; elements.agentPicker.append(option);
  }
  elements.agentPicker.value = chat.agent;
  const noAgent = [...elements.agentPicker.options].every(option => option.disabled);
  elements.agentPicker.disabled = noAgent || switching || ["running", "starting", "stopping"].includes(chat.status);
  elements.agentPicker.title = noAgent ? "Connect an agent in Agent accounts" : elements.agentPicker.disabled ? "Stop the working agent before switching" : "Switch agent · conversation and workspace are retained";
  const accountButton = $("#chat-agent-account");
  accountButton.hidden = !state.config.features?.agentAccounts || chat.agent === "mock";
  accountButton.textContent = account ? `${account.name}${account.status !== "connected" ? " · reconnect" : ""}` : "Choose account";
  accountButton.disabled = switching;
  activeModelPicker.setAgent(state.config.features?.agentAccounts && ["codex", "claude"].includes(chat.agent) && (!account || account.status !== "connected") ? null : chat.agent, chat);
  if (switching) { activeModelPicker.model.disabled = true; activeModelPicker.effort.disabled = true; }
  renderMessages();
  renderApproval();
  tickCountdown();
  chatControls.render(chat);
  usagePanel.render();
  renderQueue();
}

function renderQueue() {
  const root = $("#message-queue"), chat = state.active; root.replaceChildren();
  if (!chat?.queuedMessages?.length) return;
  root.append(node("strong", "", `${chat.queuePaused ? "Paused queue" : "Queued messages"} · ${chat.queuedMessages.length}`));
  const pending = state.queueActions.get(chat.id);
  const edit = async body => {
    if (state.queueActions.has(chat.id)) return;
    state.queueActions.set(chat.id, body); renderQueue();
    try {
      const result = await api(`/api/chats/${chat.id}/queue`, { method: "PATCH", body: JSON.stringify(body) });
      if (state.active?.id === chat.id && (result.chat.revision || 0) >= (state.active.revision || 0)) { state.active = { ...state.active, ...result.chat }; renderActive(); }
    } catch (error) { toast(error.message); }
    finally { state.queueActions.delete(chat.id); if (state.active?.id === chat.id) renderQueue(); }
  };
  if (chat.queuePaused) { const resume = node("button", "secondary-button", "Resume queue"); resume.type = "button"; resume.disabled = Boolean(pending); resume.onclick = () => edit({ resume: true }); root.append(resume); }
  for (const item of chat.queuedMessages) {
    const row = node("div", "queue-row"), remove = node("button", "small-icon", "×"), sendNow = node("button", "queue-send-now", pending?.sendNowId === item.id ? "Sending…" : "Send now");
    row.dataset.queueId = item.id;
    const preview = node("span", "queue-text", item.text); preview.title = item.text;
    sendNow.type = remove.type = "button";
    sendNow.disabled = remove.disabled = Boolean(pending);
    sendNow.title = "Interrupt the current turn and send this message next";
    sendNow.onclick = () => edit({ sendNowId: item.id });
    remove.setAttribute("aria-label", "Remove queued message"); remove.onclick = () => edit({ removeId: item.id });
    row.append(preview, sendNow, remove); root.append(row);
  }
  if (chat.queueError) root.append(node("p", "form-error", chat.queueError));
}

function tickCountdown() {
  if (state.active?.status === "idle" && state.active.idleKeepAwakeReason) { elements.countdown.textContent = "KEPT AWAKE"; return; }
  const deadline = state.active?.idleDeadlineAt ? new Date(state.active.idleDeadlineAt).getTime() : 0;
  if (!deadline || state.active?.status !== "idle") {
    elements.countdown.textContent = "";
    return;
  }
  const seconds = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
  elements.countdown.textContent = `SLEEPS IN ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

async function selectChat(id, { closeSidebar = true } = {}) {
  const selection = state.selection = (state.selection || 0) + 1;
  await activeModelPicker.saving?.catch(() => {});
  if (state.selection !== selection) return;
  state.eventSource?.close();
  state.stream = null;
  state.liveTools.clear();
  try {
    const { chat } = await api(`/api/chats/${id}`);
    if (state.selection !== selection) return;
    vimComposer.beforeSelect();
    state.active = chat;
    messageHistory.select(chat.id);
    slashComposer.close();
    history.replaceState(null, "", `#chat=${id}`);
    renderChats();
    renderActive();
    if (closeSidebar) elements.sidebar.classList.remove("open");
    connectEvents(id);
    requestAnimationFrame(() => { elements.messages.scrollTop = elements.messages.scrollHeight; });
  } catch (error) { if (state.selection === selection) toast(error.message); }
}

function connectEvents(chatId) {
  const source = new EventSource(`/api/chats/${chatId}/events`, { withCredentials: true });
  state.eventSource = source;
  source.onopen = () => { if (state.active?.id === chatId) { void sideChat.refresh(); void agentThreads.refresh(); } };
  source.onmessage = ({ data }) => {
    if (state.active?.id !== chatId) return;
    const event = JSON.parse(data);
    if (event.type === "side_chat_updated") { sideChat.update(event, chatId); }
    else if (event.type === "agent_threads_updated") { agentThreads.update(event, chatId); }
    else if (event.type === "chat_updated") {
      // EventSource replays turn history on reconnect; old snapshots must not
      // undo newer pins, moves, names or states already fetched from the API.
      if ((event.chat.revision || 0) < (state.active.revision || 0) || event.chat.updatedAt < state.active.updatedAt) return;
      const commandsChanged = (event.chat.commandCatalogRevision || 0) !== (state.active.commandCatalogRevision || 0);
      state.active = { ...state.active, ...event.chat };
      updateChatSummary(event.chat);
      renderActive();
      if (commandsChanged) slashComposer.refresh(chatId);
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
    } else if (event.type === "turn_interrupted" || event.type === "runtime_stopped") {
      state.liveTools.clear(); state.stream = null;
      renderMessages();
    } else if (event.type === "turn_failed") {
      state.liveTools.clear();
      state.stream = null;
      if (!state.active.messages.some((message) => message.id === event.message.id)) state.active.messages.push(event.message);
      renderMessages({ pinBottom: true });
    } else if (event.type === "request") {
      state.active.pendingRequest = event.request;
      renderApproval();
    } else if (event.type === "request_resolved") {
      if (state.active.pendingRequest?.requestId === event.requestId) { state.active.pendingRequest = null; renderApproval(); }
    } else if (event.type === "runtime_error") {
      toast(event.text);
    } else if (event.type === "chat_deleted") {
      forgetChat(chatId).catch(error => toast(error.message));
    }
  };
  source.onerror = () => {
    if (state.active?.id === chatId) elements.detail.textContent = "Live connection interrupted; reconnecting…";
  };
}

async function resolveRequest(payload, target) {
  const request = state.active?.pendingRequest;
  if (!request || state.active.id !== target.chatId || request.requestId !== target.requestId) return;
  const controls = [...elements.approval.querySelectorAll("button, input, textarea")];
  if (controls.some(control => control.disabled)) return;
  controls.forEach(control => { control.disabled = true; });
  try {
    await api(`/api/chats/${target.chatId}/requests/${encodeURIComponent(target.requestId)}/respond`, { method: "POST", body: JSON.stringify(payload) });
    if (state.active?.id === target.chatId && state.active.pendingRequest?.requestId === target.requestId) { state.active.pendingRequest = null; renderApproval(); }
  } catch (error) { toast(error.message); }
  finally { controls.forEach(control => { control.disabled = false; }); }
}

async function openNewChat() {
  if (!state.newChatReady) { toast("Relay is still loading. Try again in a moment."); return; }
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
  } else if (agent.authMode === "account") {
    elements.dialogSecurity.textContent = "Only the selected account is used. Refresh credentials remain encrypted on the controller; the worker receives an access token for this account. Local workers still share the host filesystem.";
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

const forkRequests = new Map();

async function forkFromComposer(chatId, text) {
  let action = forkRequests.get(chatId);
  if (action?.pending) return;
  if (action?.text !== text) { action = { text, requestId: crypto.randomUUID() }; forkRequests.set(chatId, action); }
  action.pending = true;
  toast("Creating an independent fork… The source conversation stays open.");
  const selection = state.selection;
  try {
    await activeModelPicker.saving;
    const { chat } = await api(`/api/chats/${chatId}/fork`, { method: "POST", body: JSON.stringify({ requestId: action.requestId, title: text.replace(/^\/fork\s*/, "") }) });
    updateChatSummary(chat); renderChats();
    forkRequests.delete(chatId);
    if (state.active?.id === chatId && state.selection === selection && elements.input.value.trim() === text) {
      elements.input.value = ""; messageHistory.reset(); resizeInput();
      await selectChat(chat.id);
    } else toast(`Fork ready: ${chat.title}`);
  } catch (error) { toast(error.message); }
  finally { action.pending = false; }
}

async function sendMessage(event) {
  event.preventDefault();
  if (!state.active || state.waitingForUploads) return;
  const waitingChat = state.active.id;
  if (chatControls.uploads.has(waitingChat)) {
    state.waitingForUploads = true;
    try { await chatControls.waitForUploads(waitingChat); } catch (error) { toast(error.message); return; } finally { state.waitingForUploads = false; }
    if (state.active?.id !== waitingChat) return;
  }
  let files = chatControls.attachments();
  let text = elements.input.value.trim() || (files.length ? "Please inspect the attached files." : "");
  if (!text || !state.active) return;
  const chatId = state.active.id;
  if (text === "/personality" && state.active.agent === "codex") {
    chatControls.personality(); elements.input.value = ""; resizeInput(); slashComposer.close(); return;
  }
  if (/^\/app(?:\s|$)/.test(text) && state.active.agent === "codex") {
    if (text !== "/app") { toast("Use /app without arguments to open the saved session's desktop handoff."); return; }
    try { if (await desktopHandoff.open() && state.active?.id === chatId && elements.input.value.trim() === text) { elements.input.value = ""; resizeInput(); slashComposer.close(); workspaceContext.closeMenu(); } }
    catch (error) { toast(error.message); } return;
  }
  if (/^\/pets?(?:\s|$)/.test(text)) {
    try {
      if (await pets.command(text.replace(/^\/pets?\s*/, "")) && state.active?.id === chatId && elements.input.value.trim() === text) { elements.input.value = ""; resizeInput(); slashComposer.close(); workspaceContext.closeMenu(); }
    } catch (error) { toast(error.message); }
    return;
  }
  if (/^\/(statusline|title|theme)(?:\s|$)/.test(text)) {
    const command = text.split(/\s/, 1)[0], control = { "/title": tabTitle, "/statusline": statusline, "/theme": syntaxTheme }[command];
    if (text !== command) { toast(command === "/theme" ? "Use /theme without arguments to preview and save syntax colors." : `Use ${command} without arguments to select and order ${command === "/title" ? "browser-tab title" : "footer"} fields.${command === "/title" ? " Use /rename to rename the chat." : ""}`); return; }
    try { if (await control.open() && state.active?.id === chatId && elements.input.value.trim() === text) { elements.input.value = ""; resizeInput(); slashComposer.close(); workspaceContext.closeMenu(); } }
    catch (error) { toast(error.message); } return;
  }
  if (/^\/vim(?:\s|$)/.test(text)) {
    try {
      const argument = text.slice(4).trim();
      if (argument && !["on", "off"].includes(argument)) throw new Error("Use /vim, /vim on or /vim off to control this web composer's editing mode.");
      if (await vimComposer.toggle(argument ? argument === "on" : undefined, { command: text }) && state.active?.id === chatId) { slashComposer.close(); workspaceContext.closeMenu(); }
    } catch (error) { toast(error.message); }
    return;
  }
  if (text === "/keymap") {
    try { if (await keymap.open() && state.active?.id === chatId && elements.input.value.trim() === text) { elements.input.value = ""; resizeInput(); } }
    catch (error) { toast(error.message); } return;
  }
  if (text === "/logout" && state.active.agent === "codex") {
    try { if (await nativeLogout.open() && state.active?.id === chatId && elements.input.value.trim() === text) { elements.input.value = ""; resizeInput(); } }
    catch (error) { toast(error.message); } return;
  }
  if (text === "/feedback" && state.active.agent === "codex") {
    try { if (await nativeFeedback.open() && state.active?.id === chatId && elements.input.value.trim() === text) { elements.input.value = ""; resizeInput(); } }
    catch (error) { toast(error.message); } return;
  }
  if (text === "/approve" && state.active.agent === "codex") {
    try { if (await nativeApprovals.open() && state.active?.id === chatId && elements.input.value.trim() === text) { elements.input.value = ""; resizeInput(); } }
    catch (error) { toast(error.message); } return;
  }
  if (text === "/import" && state.active.agent === "codex") {
    try { if (await nativeImports.open() && state.active?.id === chatId && elements.input.value.trim() === text) { elements.input.value = ""; resizeInput(); } }
    catch (error) { toast(error.message); } return;
  }
  if (text === "/memories" && state.active.agent === "codex") {
    try { if (await nativeMemories.open() && state.active?.id === chatId && elements.input.value.trim() === text) { elements.input.value = ""; resizeInput(); } }
    catch (error) { toast(error.message); } return;
  }
  if (text === "/experimental" && state.active.agent === "codex") {
    try { await nativeFeatures.open(); if (state.active?.id === chatId && elements.input.value.trim() === text) { elements.input.value = ""; resizeInput(); } }
    catch (error) { toast(error.message); } return;
  }
  if (text === "/hooks" && state.active.agent === "codex") {
    try { await nativeHooks.open(); if (state.active?.id === chatId && elements.input.value.trim() === text) { elements.input.value = ""; resizeInput(); } }
    catch (error) { toast(error.message); } return;
  }
  if (text === "/plugins" && state.active.agent === "codex") {
    try { await nativePlugins.open(); if (state.active?.id === chatId && elements.input.value.trim() === text) { elements.input.value = ""; resizeInput(); } }
    catch (error) { toast(error.message); } return;
  }
  if (text === "/apps" && state.active.agent === "codex") {
    try { await nativeApps.open(); if (state.active?.id === chatId && elements.input.value.trim() === text) { elements.input.value = ""; resizeInput(); } }
    catch (error) { toast(error.message); } return;
  }
  if (state.active.agent === "codex" && /^\/ide(?:\s|$)/.test(text)) {
    const original = text;
    try {
      if (original.replace(/^\/ide\s*/, "").startsWith("/")) throw new Error("Use /ide with a task, not another slash command");
      if (!await workspaceContext.prepareIde() || state.active?.id !== chatId || elements.input.value.trim() !== original) return;
      text = original.replace(/^\/ide\s*/, ""); files = chatControls.attachments();
      elements.input.value = text; resizeInput();
      if (!text) return; // /ide stages context for the next message.
    } catch (error) { toast(error.message); return; }
  }
  if (/^\/mention(?:\s|$)/.test(text)) {
    try { await workspaceContext.open(text.replace(/^\/mention\s*/, "")); if (state.active?.id === chatId && elements.input.value.trim() === text) { elements.input.value = ""; resizeInput(); } }
    catch (error) { toast(error.message); } return;
  }
  if (state.active.agent === "codex" && /^\/fork(?:\s|$)/.test(text)) {
    if (files.length) toast("Send or remove unsent attachments before forking. Previously sent attachments are copied automatically.");
    else await forkFromComposer(chatId, text);
    return;
  }
  if (state.active.agent === "codex" && /^\/(side|btw)(?:\s|$)/.test(text)) {
    try {
      await activeModelPicker.saving;
      const question = text.replace(/^\/(side|btw)\s*/, "");
      if (files.length && !question) throw new Error("Add a side question with these attachments");
      await sideChat.open(question, files.map(file => file.id));
      chatControls.clearAttachments(chatId, files.map(file => file.id));
      if (state.active?.id === chatId && elements.input.value.trim() === text) { elements.input.value = ""; resizeInput(); }
    } catch (error) { toast(error.message); }
    return;
  }
  if (["/skills", "/help"].includes(text) && !files.length) { elements.input.value = "/"; elements.input.focus(); void slashComposer.update(); return; }
  if (!files.length) {
    try { if (await runWebCommand(text)) { if (state.active?.id === chatId && elements.input.value.trim() === text) { elements.input.value = ""; resizeInput(); } return; } }
    catch (error) { toast(error.message); return; } // Failed controls keep the typed command.
  }
  const queued = ["starting", "running", "stopping"].includes(state.active.status) || state.active.queuedMessages?.length;
  elements.input.value = "";
  messageHistory.reset();
  resizeInput();
  try {
    await activeModelPicker.saving;
    await api(`/api/chats/${chatId}/${queued ? "queue" : "messages"}`, { method: "POST", body: JSON.stringify({ text, attachments: files.map(file => file.id) }) });
    chatControls.clearAttachments(chatId, files.map(file => file.id));
  } catch (error) {
    // A delayed failure belongs to the original submission, not a newer draft
    // or whichever conversation the user has opened in the meantime.
    if (state.active?.id === chatId && !elements.input.value) { elements.input.value = text; resizeInput(); }
    toast(error.message);
  }
}

async function runWebCommand(text) {
  text = text.replace(/^\/([\w:.-]+)(?=\s|$)/, (match, name) => WEB_COMMAND_ALIASES[name] ? `/${WEB_COMMAND_ALIASES[name]}` : match);
  const chatId = state.active.id;
  if (text === "/agent" && state.active.agent === "codex") { await agentThreads.open(); return true; }
  const apply = chat => { updateChatSummary(chat); if (state.active?.id === chatId) { state.active = { ...state.active, ...chat }; renderActive(); } };
  const goal = /^\/goal(?:\s+(pause|resume|clear|edit))?$/.exec(text);
  if (goal && state.active?.agent === "codex") { await chatControls.goal(goal[1] || null, { throwErrors: true }); return true; }
  if (["/usage", "/status", "/context"].includes(text)) { usagePanel.detailed(); return true; }
  if (text === "/model") { $("#composer-model-controls .model-select").focus(); return true; }
  if (["/effort", "/reasoning"].includes(text)) { $("#composer-model-controls .effort-menu").open = true; return true; }
  if (["/permissions", "/mode"].includes(text)) { $("#mode-menu").open = true; $("#mode-menu [data-agent-mode]").focus(); return true; }
  if (["/ps", "/debug-config", "/clean"].includes(text) && state.active.agent === "codex") { await chatControls.inspectCommand(text === "/debug-config" ? "debug-config" : "ps", text === "/clean" ? "all" : null); return true; }
  if (text === "/diff") { void chatControls.showChanges(); return true; }
  if (text === "/mcp") { void mcpSettings.open(); return true; }
  if (text === "/mcp verbose") { await chatControls.connectors(); return true; }
  if (["/stop", "/quit", "/exit"].includes(text)) { await api(`/api/chats/${state.active.id}/stop`, { method: "POST" }); return true; }
  if (["/new", "/clear"].includes(text)) { openNewChat(); return true; }
  if (text === "/rename") { $("#organize-chat-button").click(); return true; }
  if (text.startsWith("/rename ")) { const { chat } = await api(`/api/chats/${chatId}`, { method: "PATCH", body: JSON.stringify({ title: text.slice(8).trim() }) }); apply(chat); return true; }
  if (text === "/archive") { const { chat } = await api(`/api/chats/${chatId}`, { method: "PATCH", body: JSON.stringify({ archived: true }) }); apply(chat); return true; }
  if (text === "/delete") { await sidebar.remove(state.active); return true; }
  if (["/raw", "/transcript"].includes(text)) { chatControls.transcript(); return true; }
  if (text === "/copy") { const last = [...state.active.messages].reverse().find(message => message.role === "assistant" && message.text && !message.meta?.renderingSample); if (!last) throw new Error("No completed assistant response to copy yet"); await chatControls.copy(last.text, "Latest response copied"); return true; }
  if (text === "/resume") { chatControls.savedChats(state.chats, chat => selectChat(chat.id)); return true; }
  if (text === "/compact") return false; // Send through the ordinary message/queue path.
  if (text === "/plan") {
    if (["starting", "running", "stopping"].includes(state.active.status) || state.active.queuedMessages?.length) return false;
    const { chat } = await api(`/api/chats/${state.active.id}/mode`, { method: "PATCH", body: JSON.stringify({ mode: "plan" }) });
    apply(chat); return true;
  }
  return false;
}

function resizeInput() {
  if (elements.input.relayVimEditor) { vimComposer.sync(); return; }
  elements.input.style.height = "auto";
  elements.input.style.height = `${Math.min(elements.input.scrollHeight, 170)}px`;
}

function toast(message, { outsideDialog = false } = {}) {
  const dialog = !outsideDialog && [...document.querySelectorAll("dialog[open]")].at(-1);
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
  state.newChatReady = false;
  for (const id of ["#new-chat-button", "#welcome-new-chat"]) { $(id).disabled = true; $(id).title = "Loading your accounts and repositories…"; }
  setupPanelResizers();
  const auth = await api("/api/auth");
  googleLogin.render(auth);
  if (auth.required && !auth.authenticated) {
    elements.loginDialog.showModal();
    return;
  }
  state.config = await api("/api/config");
  $("#agent-accounts-button").hidden = !state.config.features?.agentAccounts;
  // Cosmetic preferences must not hold the conversation/composer behind a
  // slow settings response. The tab stays neutral until its settings arrive.
  void tabTitle.load().catch(error => toast(`Tab title stays neutral: ${error.message}`));
  void syntaxTheme.load().catch(error => toast(`Syntax theme uses defaults: ${error.message}`));
  void pets.load().catch(error => toast(`Pet stays hidden: ${error.message}`));
  await keymap.load().catch(error => toast(`Keyboard shortcuts use defaults: ${error.message}`));
  await statusline.load().catch(error => toast(`Status line uses defaults: ${error.message}`));
  await sidebar.refresh();
  sidebar.connect();
  elements.agentSelect.replaceChildren();
  for (const agent of state.config.agents.filter((item) => item.enabled)) {
    const option = node("option", "", agent.label);
    option.value = agent.id;
    elements.agentSelect.append(option);
  }
  await workspaceSettings.loadCurrent();
  state.newChatReady = true;
  for (const id of ["#new-chat-button", "#welcome-new-chat"]) { $(id).disabled = false; $(id).title = "Create a conversation"; }
  $("#isolation-label").textContent = state.config.workerBackend === "ec2"
    ? "One EC2 worker per chat"
    : state.config.processIsolation === "namespace" ? "Private PID namespaces" : "Process isolation disabled";
  renderChats();
  // A user can open the mobile drawer while startup settings are loading.
  // Automatic initial selection must not undo that explicit interaction.
  if (state.chats.length) await selectChat(state.chats.find(chat => location.hash === `#chat=${chat.id}`)?.id || state.chats[0].id, { closeSidebar: false });
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
elements.send.addEventListener("click", () => { if (elements.send.type === "button") $("#stop-button").click(); });
elements.input.addEventListener("input", resizeInput);
function keyboardAction(event, action) {
  if (action === "new_chat") { event.preventDefault(); if (!event.repeat) openNewChat(); return true; }
  if (action === "focus_composer" && !elements.input.disabled && state.active) { event.preventDefault(); elements.input.focus(); return true; }
  if (action === "answer_request" && !elements.approval.hidden) {
    const control = elements.approval.querySelector("input:not(:disabled), textarea:not(:disabled), button:not(:disabled)");
    if (control) { event.preventDefault(); control.focus(); return true; }
  }
  return false;
}
function composerKeydown(event, { vim = false, inserting = true } = {}) {
  if (event.isComposing || event.keyCode === 229 || document.querySelector("dialog[open]")) return;
  if (!inserting && !event.ctrlKey && !event.metaKey && !event.altKey) return;
  if (workspaceContext.keydown(event) || slashComposer.keydown(event)) return;
  const action = keymap.action(event, "composer");
  if (action?.startsWith("history_")) { messageHistory.keydown(event, action); return; }
  if (action === "send") {
    event.preventDefault();
    if (!event.repeat) $("#composer").requestSubmit();
  } else if (action === "newline") {
    if (!vim && event.key === "Enter" && event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) return; // Retain the browser's native undo for the default newline.
    event.preventDefault(); elements.input.setRangeText("\n", elements.input.selectionStart, elements.input.selectionEnd, "end"); elements.input.dispatchEvent(new Event("input", { bubbles: true }));
  } else keyboardAction(event, action);
}
elements.input.addEventListener("keydown", composerKeydown);
document.addEventListener("keydown", event => {
  if (event.defaultPrevented || event.isComposing || event.keyCode === 229 || document.querySelector("dialog[open]") || event.target === elements.input) return;
  if (event.target.closest?.("input, textarea, select, [contenteditable], canvas, [role=application]")) return;
  keyboardAction(event, keymap.action(event, "global"));
});
window.addEventListener("focus", () => {
  if (state.config) void keymap.load().catch(() => {});
  if (state.config) void statusline.load().catch(() => {});
  if (state.config) void tabTitle.load().catch(() => {});
  if (state.config) void syntaxTheme.load().catch(() => {});
  if (state.config) void pets.load().catch(() => {});
});
$("#stop-button").addEventListener("click", async () => {
  if (!state.active) return;
  try { await api(`/api/chats/${state.active.id}/stop`, { method: "POST", body: "{}" }); }
  catch (error) { toast(error.message); }
});
async function deleteChat(chat) {
  if (!chat || !confirm(`Permanently delete “${chat.title}”, its messages, and its workspace files? Any running agent will be stopped. This cannot be undone.`)) return false;
  const id = chat.id;
  await api(`/api/chats/${id}`, { method: "DELETE" });
  await forgetChat(id);
  toast("Chat and workspace permanently deleted.");
  return true;
}
async function forgetChat(id) {
  vimComposer.forget(id);
  state.chats = state.chats.filter(item => item.id !== id);
  chatControls.drafts.delete(id);
  if (state.active?.id === id) {
    state.eventSource?.close();
    state.selection = (state.selection || 0) + 1;
    state.stream = null; state.liveTools.clear();
    state.active = null;
    messageHistory.select(null);
    history.replaceState(null, "", location.pathname);
    renderActive();
    if (state.chats.length) await selectChat(state.chats[0].id).catch(error => toast(error.message));
  }
  renderChats();
}
$("#delete-button").addEventListener("click", () => {
  deleteChat(state.active).catch(error => toast(error.message));
});
$("#open-sidebar").addEventListener("click", () => elements.sidebar.classList.add("open"));
$("#close-sidebar").addEventListener("click", () => elements.sidebar.classList.remove("open"));
const sidebar = new ChatSidebar({ state, api, select: selectChat, remove: deleteChat, toast, agentLabel,
  updated: chat => {
    updateChatSummary(chat);
    if (state.active?.id === chat.id) { state.active = { ...state.active, ...chat }; renderActive(); }
  },
});
const workspaceSettings = new WorkspaceSettings({ state, api, toast });
const agentAccountSettings = new AgentAccountSettings({ api, state, toast, changed: async () => {
  state.config = await api("/api/config");
  const selected = elements.agentSelect.value;
  elements.agentSelect.replaceChildren();
  for (const agent of state.config.agents.filter(item => item.enabled)) {
    const option = node("option", "", agent.label); option.value = agent.id; elements.agentSelect.append(option);
  }
  if ([...elements.agentSelect.options].some(option => option.value === selected)) elements.agentSelect.value = selected;
  await workspaceSettings.load(); renderSecurityHint();
  elements.agentPicker.replaceChildren(); ModelPicker.clearCatalogs(); activeModelPicker.key = null; renderActive();
}, chatUpdated: chat => {
  updateChatSummary(chat);
  if (state.active?.id === chat.id) { state.active = chat; activeModelPicker.key = null; renderActive(); }
} });
const googleLogin = new GoogleLogin({ api, beforeSignOut: () => !(elements.input.value.trim() || chatControls.attachments().length) || confirm("Sign out? Your unsent draft and attachment selection will be cleared. Saved conversations and files will remain.") });
const mcpSettings = new McpSettings({ api, toast, state });
const toolActivity = new ToolActivity();
const usagePanel = new UsagePanel({ state, api, toast });
const chatPresence = new ChatPresence({ api });
const documentPreview = new DocumentPreview();
const sideChat = new SideChatPanel({ api, getChat: () => state.active, toast, onPreview: preview => documentPreview.open(preview) });
const agentThreads = new AgentThreadsPanel({ api, getChat: () => state.active, toast, onPreview: preview => documentPreview.open(preview) });
const appPreview = new AppPreviewDialog({ api, getChat: () => state.active, getBackend: () => state.active?.runtimeMetadata?.backend || state.config?.workerBackend });
$("#open-app-preview").onclick = () => appPreview.open();
const sharedBrowser = new SharedBrowserPanel({ api, getBackend: () => state.active?.runtimeMetadata?.backend || state.config?.workerBackend, openApp: options => appPreview.open(options) });
const browserConnectionSettings = new BrowserConnectionSettings({ api, state, toast, browser: sharedBrowser,
  accountChanged: async () => {
    appPreview.resetIdentity();
    vimComposer.resetIdentity();
    statusline.resetIdentity();
    tabTitle.resetIdentity();
    syntaxTheme.resetIdentity();
    pets.resetIdentity();
    desktopHandoff.resetIdentity();
    workspaceTrust.resetIdentity();
    keymap.resetIdentity(); await keymap.load().catch(error => toast(error.message));
    await sidebar.refresh();
    if (state.active && !state.chats.some(chat => chat.id === state.active.id)) { state.eventSource?.close(); state.active = null; state.stream = null; }
    if (state.active) await selectChat(state.active.id); else if (state.chats.length) await selectChat(state.chats[0].id); else renderActive();
    await statusline.load().catch(error => toast(error.message));
    await tabTitle.load().catch(error => toast(error.message));
    await syntaxTheme.load().catch(error => toast(error.message));
    await pets.load().catch(error => toast(error.message));
    renderChats();
  },
  chatUpdated: chat => { updateChatSummary(chat); if (state.active?.id === chat.id) { state.active = chat; renderActive(); } },
});
const chatControls = new ChatControls({ state, api, toast,
  preview: documentPreview,
  updated: chat => { updateChatSummary(chat); if (state.active?.id === chat.id) { state.active = { ...state.active, ...chat }; renderActive(); } },
  openEnvironment: () => workspaceSettings.openEnvironments(state.active?.environmentId),
  openRepositories: () => openNewChat(),
});
function renderKeyboardHints() {
  const label = binding => binding.split("-").map(key => ({ ctrl: "Ctrl", meta: "Meta", alt: "Alt", shift: "Shift", enter: "Enter" }[key] || key)).join(" + ");
  const binding = (context, action, defaults) => (keymap.snapshot.bindings[context]?.[action] ?? defaults).map(label).join(" / ");
  const send = binding("composer", "send", ["enter"]), newline = binding("composer", "newline", ["shift-enter"]);
  const busy = ["running", "starting"].includes(state.active?.status);
  $(".composer-hint").textContent = `${send ? `${send} to ${busy ? "queue" : "send"}` : "Use the send/queue button"}${busy ? " · Stop pauses the queue" : ""}${newline ? ` · ${newline} for a new line` : ""}`;
  if (elements.input.relayVimEditor && !elements.input.relayVimEditor.state.vim?.insertMode) $(".composer-hint").textContent = `Vim Normal/Visual: i to edit · Use the ${busy ? "Queue" : "Send"} button to ${busy ? "queue" : "send"}`;
  const keys = keymap.snapshot.bindings.global?.new_chat ?? ["ctrl-k", "meta-k"], preferred = keys.find(key => key.startsWith(navigator.platform?.includes("Mac") ? "meta-" : "ctrl-")) || keys[0];
  const badge = $("#new-chat-button kbd"); badge.textContent = preferred ? label(preferred) : ""; badge.hidden = !preferred;
}
const keymap = new KeymapControls({ api, controls: chatControls, notify: message => toast(message, { outsideDialog: true }), changed: renderKeyboardHints });
const statusline = new StatusLineControls({ api, controls: chatControls, getChat: () => state.active, notify: message => toast(message, { outsideDialog: true }) });
$("#statusline-button").addEventListener("click", () => void statusline.open().catch(error => toast(error.message)));
const tabTitle = new TabTitleControls({ api, controls: chatControls, getChat: () => state.active, notify: message => toast(message, { outsideDialog: true }) });
$("#tab-title-button").addEventListener("click", () => void tabTitle.open().catch(error => toast(error.message)));
const syntaxTheme = new SyntaxThemeControls({ api, controls: chatControls, notify: message => toast(message, { outsideDialog: true }) });
$("#syntax-theme-button").addEventListener("click", () => void syntaxTheme.open().catch(error => toast(error.message)));
const pets = new PetControls({ api, controls: chatControls, getChat: () => state.active, root: $("#chat-pet"), notify: message => toast(message, { outsideDialog: true }) });
$("#pets-button").addEventListener("click", () => void pets.open().catch(error => toast(error.message)));
const desktopHandoff = new DesktopHandoff({ state, api, controls: chatControls });
const workspaceTrust = new ClaudeWorkspaceTrustControls({ state, api, controls: chatControls });
$("#workspace-trust-button").addEventListener("click", () => void workspaceTrust.open().catch(error => toast(error.message)));
$("#desktop-app-button").addEventListener("click", () => void desktopHandoff.open().catch(error => toast(error.message)));
const vimComposer = new VimComposer({ input: elements.input, getChatId: () => state.active?.id, notify: toast, keydown: composerKeydown,
  changed: () => { resizeInput(); renderKeyboardHints(); },
  help: () => chatControls.dialog("Vim composer keys",
    node("p", "", "Vim editing applies only to this chat's web composer for this page session. It starts in Normal mode. New chats and page reloads start with the ordinary composer. It never changes the worker's terminal configuration or sends a prompt."),
    node("p", "", "i/a/I/A insert or append · Esc returns to Normal · h/j/k/l, w/b/e, 0/^/$, gg/G move · counts such as 3w · d/c/y with motions or text objects such as dw, ciw, da\" · x/r replace/delete · p/P paste the local Vim register · u and Ctrl+R undo/redo · v/V/Ctrl+V visual selections · / and ? search · n/N repeat search · :s substitutions."),
    node("p", "", "In Insert mode, Relay's configured send/queue, newline, message-history and command/file-picker shortcuts stay active. In Normal/Visual mode, unmodified keys belong to Vim; use the Send/Queue button, or a configured modified send shortcut. Tab moves focus outside the editor when no picker is open."),
    node("p", "muted", "Vim commands edit the unsent draft, not workspace files; :w does not send it. Attachments remain attached. Registers, macros, search and undo state are cleared when you turn Vim off or leave this chat, so they cannot leak into another chat or account. No external script/CDN, filesystem or model access is used.")),
});
$("#keymap-button").addEventListener("click", () => void keymap.open().catch(error => toast(error.message)));
const slashComposer = new SlashComposer({ state, api });
const workspaceContext = new WorkspaceContext({ state, api, controls: chatControls, toast });
const nativeApps = new NativeAppsPicker({ state, api, controls: chatControls, toast });
const nativePlugins = new NativePluginsPicker({ state, api, controls: chatControls, changed: chatId => slashComposer.invalidate(chatId) });
const nativeHooks = new NativeHooksBrowser({ state, api, controls: chatControls, changed: chatId => slashComposer.invalidate(chatId) });
const nativeFeatures = new NativeFeaturesPicker({ state, api, controls: chatControls, changed: chatId => slashComposer.invalidate(chatId) });
const nativeMemories = new NativeMemoriesControls({ state, api, controls: chatControls, changed: chatId => slashComposer.invalidate(chatId) });
const nativeApprovals = new NativeApprovalControls({ state, api, controls: chatControls, notify: message => toast(message, { outsideDialog: true }) });
const nativeFeedback = new NativeFeedbackControls({ state, api, controls: chatControls, notify: message => toast(message, { outsideDialog: true }) });
const nativeLogout = new NativeLogoutControls({ state, api, controls: chatControls, notify: message => toast(message, { outsideDialog: true }), changed: chatId => slashComposer.invalidate(chatId) });
const nativeImports = new NativeImportsControls({ state, api, controls: chatControls, changed: chatId => slashComposer.invalidate(chatId), opened: (chat, active) => {
  updateChatSummary(chat); renderChats();
  if (chat.importWarnings?.length) toast(chat.importWarnings.join(" "), { outsideDialog: true });
  if (active && !elements.input.value.trim() && !chatControls.attachments().length) void selectChat(chat.id);
  else toast(`Imported chat ready: ${chat.title}`, { outsideDialog: true });
} });
const messageHistory = new MessageHistory({ input: elements.input, state, onChange: resizeInput });
const messageNavigator = new MessageNavigator({ state, scroller: elements.messages, root: $("#message-navigator"), ensureVisible: id => { if (messageWindow.show(id)) renderMessages(); }, atLatest: () => messageWindow.tail });
elements.messages.addEventListener("scroll", () => {
  if (adjustingMessageWindow || !messageWindow.rows?.length) return;
  const nearBottom = elements.messages.scrollHeight - elements.messages.scrollTop - elements.messages.clientHeight < 100;
  messageNavigator.readingHistory = !nearBottom || !messageWindow.tail;
  if (elements.messages.scrollTop < 80 && messageWindow.start > 0) { messageWindow.move(-1); renderMessages(); }
  else if (nearBottom && messageWindow.end < messageWindow.rows.length) { messageWindow.move(1); renderMessages(); }
}, { passive: true });
const activeModelPicker = new ModelPicker({ root: $("#composer-model-controls"), api, onChange: async settings => {
  if (!state.active) return;
  const id = state.active.id;
  const { chat } = await api(`/api/chats/${id}/model`, { method: "PATCH", body: JSON.stringify(settings) });
  updateChatSummary(chat);
  if (state.active?.id === id) state.active = { ...state.active, ...chat };
} });
elements.agentPicker.addEventListener("change", async () => {
  const chat = state.active; if (!chat) return;
  const agent = elements.agentPicker.value;
  if (["codex", "claude"].includes(agent) && state.config.features?.agentAccounts && chat.agent !== agent) {
    renderActive(); await agentAccountSettings.open(); return;
  }
  state.switchingChat = chat.id; renderActive();
  try {
    await activeModelPicker.saving;
    const result = await api(`/api/chats/${chat.id}/agent`, { method: "PATCH", body: JSON.stringify({ agent }) });
    updateChatSummary(result.chat);
    if (state.active?.id === chat.id) { state.active = result.chat; state.stream = null; state.liveTools.clear(); }
  } catch (error) { toast(error.message); }
  finally { state.switchingChat = null; activeModelPicker.key = null; renderActive(); }
});
setInterval(tickCountdown, 1000);

boot().catch((error) => toast(error.message));
