import { ChatSidebar } from "./chat-sidebar.js";
import { GoogleLogin } from "./google-login.js";
import { AgentAccountSettings } from "./agent-accounts.js";
import { closeSidePanel } from "./side-panels.js";
import { WorkspaceSettings } from "./workspace-settings.js";
import { ModelPicker, claudeCatalogMatchesChat } from "./model-picker.js";
import { ChatControls } from "./chat-controls.js";
import { latestCompletedAnswer } from "./completed-answer.js";
import { renderContent } from "./message-content.js";
import { ToolActivity, groupTools } from "./tool-activity.js";
import { UsagePanel } from "./usage-panel.js";
import { SlashComposer } from "./slash-composer.js";
import { firstChatCommand, newChatCommands } from "./new-chat-commands.js";
import { McpSettings } from "./mcp-settings.js";
import { MessageHistory } from "./message-history.js";
import { MessageNavigator } from "./message-navigator.js";
import { MessageFollow } from "./message-follow.js";
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
import { RuntimeWake } from "./runtime-wake.js";
import { agentAccountLabel } from "./agent-account-options.js";
import { ChatRepositoryPicker } from "./chat-repository-picker.js";
import { CompaniesPage } from "./companies.js";
import { CompanySettings } from "./company-settings.js";
import { CompanyPluginSettings } from "./company-plugins.js";
import { workingStatus, canInterruptWithEscape } from "./working-status.js";
import { StartupProgress } from "./startup-progress.js";
import { SavedPromptPicker } from "./saved-prompts.js";
import { MessageSearch } from "./message-search.js";
import { companyForChat } from "./company-scope.js";

const state = {
  config: null,
  chats: [],
  active: null,
  stream: null,
  liveTools: new Map(),
  queueActions: new Map(),
  optimisticQueueSends: new Map(),
  eventSource: null,
  deletingChats: new Set(),
};

const $ = (selector) => document.querySelector(selector);
const elements = {
  sidebar: $("#sidebar"),
  chatList: $("#chat-list"),
  welcome: $("#new-chat-page"),
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
  newForm: $("#new-chat-form"),
  agentSelect: $("#agent-select"),
  dialogSecurity: $("#dialog-security"),
  loginDialog: $("#login-dialog"),
};
const startupProgress = new StartupProgress({ container: elements.detail.parentElement, detail: elements.detail });

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

function reconcileOptimisticQueueSend(chat, message = null) {
  const action = chat && state.optimisticQueueSends.get(chat.id);
  if (!action) return;
  const delivered = candidate => action.message && candidate?.role === "user" && candidate.text === action.message.text && candidate.createdAt >= action.message.createdAt;
  if (chat.queueError || delivered(message) || chat.messages?.some(delivered)) state.optimisticQueueSends.delete(chat.id);
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
  if (role === "assistant" && (message.meta?.commentary || message.meta?.segmentedTurn)) wrapper.classList.add("commentary");
  wrapper.dataset.messageId = message.id || "stream";
  wrapper.append(node("div", "message-avatar", role === "assistant" ? glyph(message.agent || state.active?.agent) : role === "user" ? "YOU" : "!"));
  const body = node("div", "message-body");
  body.append(node("div", "message-label", role === "assistant" ? agentLabel(message.agent || state.active?.agent) : role));
  const text = node("div", "message-text");
  renderContent(text, message.text || message.meta?.finalAnswer?.text || "", { onPreview: preview => documentPreview.open({ ...preview, messageId: message.id }) });
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
function renderMessages() {
  renderWorkingStatus();
  if (!state.active) return;
  const changedChat = messageWindow.chatId !== state.active.id;
  // Search and message navigation focus the article itself. Keep that exact
  // anchor through live rerenders, without capturing nested links/buttons or
  // stealing focus from the composer (tool controls restore their own focus).
  const focusedMessage = !changedChat && document.activeElement?.matches(".message") && elements.messages.contains(document.activeElement)
    ? { chatId: state.active.id, messageId: document.activeElement.dataset.messageId } : null;
  const render = messageFollow.begin({ reset: changedChat });
  const oldTop = elements.messages.getBoundingClientRect().top;
  const anchor = [...elements.messages.querySelectorAll(".message")].find(n => n.getBoundingClientRect().bottom > oldTop + 10);
  const anchorId = anchor?.dataset.messageId, anchorOffset = anchor ? anchor.getBoundingClientRect().top - oldTop : 0;
  toolActivity.captureExpanded();
  elements.messages.replaceChildren();
  const persisted = (state.active.messages || []).filter(message => !message.meta?.renderingSample && !(message.meta?.segmentedTurn && !message.text?.trim() && !message.meta?.finalAnswer?.text));
  const optimistic = state.optimisticQueueSends.get(state.active.id);
  if (optimistic?.message && !persisted.some(message => message.role === "user" && message.text === optimistic.message.text && message.createdAt >= optimistic.message.createdAt)) persisted.push(optimistic.message);
  if (!persisted.length && !state.stream && !state.liveTools.size) {
    messageWindow.update(state.active.id, []);
    toolActivity.update(state.active.id, new Map());
    elements.messages.append(node("div", "messages-empty", "Wake the environment to use its browser or files.\nSend a message when you want the agent to work."));
  } else {
    const { rows, groups } = groupTools(persisted, [...state.liveTools.values()]);
    toolActivity.update(state.active.id, groups);
    const visible = messageWindow.update(state.active.id, rows);
    const pager = (label, action) => { const button = node("button", "message-page-button", label); button.type = "button"; button.onclick = action; return button; };
    if (messageWindow.start) elements.messages.append(pager(`Load earlier messages · ${messageWindow.start} above`, () => { messageNavigator.readingHistory = true; messageWindow.move(-1); renderMessages(); }));
    for (const message of visible) elements.messages.append(message.kind === "tool_group" ? toolActivity.button(message.key) : renderMessage(message));
    if (messageWindow.end < rows.length) {
      elements.messages.append(pager(`Load newer messages · ${rows.length - messageWindow.end} below`, () => { messageWindow.move(1); renderMessages(); }));
    } else if (state.stream?.text.trim()) elements.messages.append(renderMessage({ id: state.stream.id, role: "assistant", text: state.stream.text }, true));
  }
  toolActivity.restoreInlineFocus();
  messageNavigator.update();
  if (focusedMessage?.chatId === state.active.id && document.activeElement === document.body) {
    const retained = [...elements.messages.querySelectorAll(".message")].find(element => element.dataset.messageId === focusedMessage.messageId);
    if (retained) { retained.tabIndex = -1; retained.focus({ preventScroll: true }); }
  }
  if (!render.follow && anchorId) {
    const retained = [...elements.messages.querySelectorAll(".message")].find(n => n.dataset.messageId === anchorId);
    if (retained) elements.messages.scrollTop += retained.getBoundingClientRect().top - elements.messages.getBoundingClientRect().top - anchorOffset;
  }
  messageFollow.end(render);
}

function renderApproval() {
  const request = state.active?.pendingRequest;
  const key = request ? `${state.active.id}:${request.requestId}` : null;
  const target = { chatId: state.active?.id, requestId: request?.requestId };
  renderAgentRequest(elements.approval, request, key, payload => resolveRequest(payload, target));
}

function renderActive() {
  const chat = state.active;
  reconcileOptimisticQueueSend(chat);
  savedPrompts.sync();
  $("#companies-page").hidden = state.page !== "companies";
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
  elements.welcome.hidden = Boolean(chat) || state.page === "companies";
  elements.conversation.hidden = !chat;
  elements.actions.hidden = !chat;
  runtimeWake.render(chat);
  renderStartupProgress();
  if (state.page === "companies") {
    elements.title.textContent = "Companies"; elements.meta.textContent = "";
    closeSidePanel("diff"); return;
  }
  if (!chat) {
    chatControls.renderAttachments();
    closeSidePanel("diff"); toolActivity.update(null, new Map());
    elements.messages.replaceChildren();
    messageFollow.observe(); $("#message-jump-latest").hidden = true;
    elements.title.textContent = "New chat";
    elements.meta.textContent = "";
    const recent = state.chats.filter(item => !item.archived).slice(0, 5);
    $("#recent-chats").replaceChildren(...recent.map(item => {
      const button = node("button", "recent-chat", item.title); button.type = "button";
      const repository = item.repositories?.[0]?.fullName;
      if (repository) button.append(node("small", "", repository));
      button.onclick = () => selectChat(item.id); return button;
    }));
    return;
  }
  elements.title.textContent = chat.title;
  $("#organize-chat-button").textContent = "Rename / organize";
  const runtimeLabel = chat.runtimeMetadata?.instanceId ? ` · ${chat.runtimeMetadata.instanceId}` : "";
  const account = workspaceSettings.accounts?.find(item => item.id === chat.agentAccountId);
  elements.meta.textContent = `${agentLabel(chat.agent)}${account ? ` · ${account.name}` : ""}${runtimeLabel} · ${chat.workspace}`;
  const suspensionStatus = chat.suspension?.status;
  elements.status.textContent = suspensionStatus === "hibernating" ? "hibernating"
    : suspensionStatus === "hibernated" && chat.status === "starting" ? "resuming"
    : suspensionStatus === "hibernated" ? "hibernated"
    : suspensionStatus === "failed" && chat.status === "error" ? "hibernation failed"
    : chat.status === "idle" && chat.idleKeepAwakeReason ? "Ready" : chat.status;
  elements.detail.textContent = chat.statusDetail || "";
  elements.statusDot.className = `status-dot ${chat.status}`;
  const stopButton = $("#stop-button");
  stopButton.hidden = !["starting", "running", "idle", "waiting"].includes(chat.status);
  stopButton.disabled = false;
  const resizeButton = $("#resize-worker-button");
  resizeButton.hidden = state.config.workerBackend !== "ec2";
  const environment = workspaceSettings.environments?.find(item => item.id === chat.environmentId);
  const machineType = chat.workerResize?.status === "failed" ? chat.runtimeMetadata?.instanceType || environment?.instanceType || workspaceSettings.defaultInstanceType
    : chat.workerInstanceType || chat.runtimeMetadata?.instanceType || environment?.instanceType || workspaceSettings.defaultInstanceType;
  resizeButton.textContent = chat.workerResize?.status === "resizing" || chat.workerResize?.status === "queued" ? `resizing → ${chat.workerResize.instanceType}`
    : chat.workerResize?.status === "failed" ? `${machineType || "machine"} · retry⌄` : `${machineType || "machine size"}⌄`;
  $("#delete-button").disabled = false;
  $("#delete-button").removeAttribute("aria-busy");
  const busy = ["running", "starting"].includes(chat.status);
  renderWorkingStatus();
  // Runtime transitions never lock the composer. Submitting while the agent is
  // busy is an ordinary queue operation; the controller owns serialization.
  elements.send.disabled = false;
  elements.input.disabled = false;
  elements.send.type = "submit";
  elements.send.setAttribute("aria-label", busy ? "Queue message" : "Send message");
  elements.send.title = busy ? "Queue message" : "Send message";
  elements.send.querySelector("path").setAttribute("d", "m5 12 7-7 7 7M12 5v14");
  $("#interrupt-button").hidden = !busy;
  $("#interrupt-button").disabled = false;
  $("#queue-message").hidden = !busy; $("#queue-message").disabled = false;
  renderKeyboardHints();
  elements.input.placeholder = chat.workflowState === "archived" ? "Send to unarchive and continue…" : "Ask your agent to build, inspect, or fix something…";
  const namedAccounts = state.config.features?.agentAccounts && chat.agent !== "mock";
  if (namedAccounts) {
    const accounts = workspaceSettings.accounts?.filter(item => item.status === "connected") || [];
    elements.agentPicker.replaceChildren(...accounts.map(item => {
      const option = node("option", "", agentAccountLabel(item)); option.value = item.id; return option;
    }));
    if (!accounts.some(item => item.id === chat.agentAccountId)) {
      const option = node("option", "", account ? `${agentAccountLabel(account)} · reconnect` : "Choose an agent account");
      option.value = chat.agentAccountId || ""; option.disabled = true; elements.agentPicker.prepend(option);
    }
  } else { elements.agentPicker.replaceChildren(); for (const agent of state.config.agents.filter(item => item.enabled)) {
    const option = node("option", "", agent.id === "claude" ? "Claude" : agent.label); option.value = agent.id; elements.agentPicker.append(option);
  } }
  if (!namedAccounts && ![...elements.agentPicker.options].some(option => option.value === chat.agent)) {
    const option = node("option", "", agentLabel(chat.agent)); option.value = chat.agent; option.disabled = true; elements.agentPicker.append(option);
  }
  elements.agentPicker.value = namedAccounts ? chat.agentAccountId || "" : chat.agent;
  elements.agentPicker.classList.toggle("account-select", namedAccounts);
  const noAgent = [...elements.agentPicker.options].every(option => option.disabled);
  elements.agentPicker.disabled = noAgent;
  elements.agentPicker.title = noAgent ? "Connect an agent in Agent accounts" : "Switch agent · conversation and workspace are retained";
  const accountButton = $("#chat-agent-account");
  accountButton.hidden = !state.config.features?.agentAccounts || chat.agent === "mock";
  accountButton.textContent = "⚙"; accountButton.setAttribute("aria-label", "Manage chat agent accounts");
  accountButton.disabled = false;
  activeModelPicker.setAgent(state.config.features?.agentAccounts && ["codex", "claude"].includes(chat.agent) && (!account || account.status !== "connected") ? null : chat.agent, chat);
  renderMessages();
  renderApproval();
  tickCountdown();
  chatControls.render(chat);
  chatRepositories.render(chat);
  usagePanel.render();
  renderQueue();
}

function renderQueue() {
  const root = $("#message-queue"), chat = state.active; root.replaceChildren();
  const optimistic = chat && state.optimisticQueueSends.get(chat.id);
  const queuedMessages = (chat?.queuedMessages || []).filter(item => !optimistic?.ids.has(item.id));
  if (!queuedMessages.length) return;
  root.append(node("strong", "", `${chat.queuePaused ? "Paused queue" : "Queued messages"} · ${queuedMessages.length}`));
  const pending = state.queueActions.get(chat.id);
  const edit = async body => {
    if (state.queueActions.has(chat.id)) return;
    if (body.sendNowId) {
      // The click is the user's handoff point. Move the whole ordinary queue
      // into the transcript immediately while the controller interrupts the
      // native turn in the background. Live events replace this optimistic
      // message with the durable one; an admission error restores the queue.
      const priority = chat.queuedMessages.find(item => item.id === body.sendNowId);
      const ordered = priority ? [priority, ...chat.queuedMessages.filter(item => item.id !== priority.id)] : [...chat.queuedMessages];
      const ordinary = ordered.filter(item => !item.githubEventId && !item.nativeApprovalId);
      const text = ordinary.map(item => item.text).join("\n\n---\n\n");
      const action = {
        ids: new Set(chat.queuedMessages.map(item => item.id)),
        message: text ? { id: `send-now-${Date.now()}`, role: "user", kind: "message", text, createdAt: new Date().toISOString(), meta: { authorship: "user", optimisticSendNow: true } } : null,
      };
      state.optimisticQueueSends.set(chat.id, action); renderQueue(); renderMessages();
      void api(`/api/chats/${chat.id}/queue`, { method: "PATCH", body: JSON.stringify(body) }).catch(error => {
        if (state.optimisticQueueSends.get(chat.id) === action) state.optimisticQueueSends.delete(chat.id);
        if (state.active?.id === chat.id) { renderQueue(); renderMessages(); }
        toast(error.message);
      });
      return;
    }
    state.queueActions.set(chat.id, body); renderQueue();
    try {
      const result = await api(`/api/chats/${chat.id}/queue`, { method: "PATCH", body: JSON.stringify(body) });
      if (state.active?.id === chat.id && (result.chat.revision || 0) >= (state.active.revision || 0)) { state.active = { ...state.active, ...result.chat }; renderActive(); }
    } catch (error) { toast(error.message); }
    finally { state.queueActions.delete(chat.id); if (state.active?.id === chat.id) renderQueue(); }
  };
  if (chat.queuePaused) { const resume = node("button", "secondary-button", "Resume queue"); resume.type = "button"; resume.disabled = Boolean(pending); resume.onclick = () => edit({ resume: true }); root.append(resume); }
  for (const item of queuedMessages) {
    const row = node("div", "queue-row"), remove = node("button", "small-icon", "×"), sendNow = node("button", "queue-send-now", "Send all now");
    row.dataset.queueId = item.id;
    const preview = node("span", "queue-text", item.text); preview.title = item.text;
    sendNow.type = remove.type = "button";
    sendNow.disabled = remove.disabled = Boolean(pending);
    sendNow.title = "Interrupt the current turn, send this message first, then send the rest of the queue";
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

async function selectChat(id, { closeSidebar = true, messageId = null } = {}) {
  const selection = state.selection = (state.selection || 0) + 1;
  if (state.active?.id && state.active.id !== id) { state.chatDrafts ||= new Map(); state.chatDrafts.set(state.active.id, elements.input.value); }
  await activeModelPicker.saving?.catch(() => {});
  if (state.selection !== selection) return;
  state.eventSource?.close();
  state.stream = null;
  state.liveTools.clear();
  try {
    const { chat } = await api(`/api/chats/${id}`);
    if (state.selection !== selection) return;
    vimComposer.beforeSelect();
    const switchingChat = state.active?.id !== id;
    state.page = null; state.active = chat;
    messageHistory.select(chat.id);
    // History saves the previous chat's input before selecting its own entry.
    // Restore externally retained first-message drafts only after that selection.
    if (switchingChat && state.chatDrafts?.has(id)) { elements.input.value = state.chatDrafts.get(id); resizeInput(); }
    slashComposer.close();
    history.replaceState(null, "", `#chat=${id}`);
    renderChats();
    renderActive();
    if (closeSidebar) elements.sidebar.classList.remove("open");
    connectEvents(id);
    requestAnimationFrame(() => {
      if (state.selection !== selection || state.active?.id !== id) return;
      if (messageId) {
        messageNavigator.readingHistory = true;
        if (messageWindow.show(messageId)) renderMessages();
        const target = [...elements.messages.querySelectorAll(".message")].find(element => element.dataset.messageId === messageId);
        if (target) { target.tabIndex = -1; target.focus({ preventScroll: true }); target.scrollIntoView({ block: "center" }); }
        else toast("This message is no longer available.");
      } else elements.messages.scrollTop = elements.messages.scrollHeight;
    });
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
      reconcileOptimisticQueueSend(state.active);
      updateChatSummary(event.chat);
      renderActive();
      if (commandsChanged) slashComposer.refresh(chatId);
    } else if (event.type === "message") {
      if (event.message.meta?.commentary && state.stream?.id === event.message.meta.streamId) state.stream.text = "";
      if (event.message.role === "user") state.active.messages = state.active.messages.filter(message => message.id !== `initial-${chatId}` || message.text !== event.message.text);
      if (event.message.kind === "tool" && event.message.meta?.itemId) state.liveTools.delete(event.message.meta.itemId);
      const index = state.active.messages.findIndex((message) => message.id === event.message.id);
      if (index >= 0) state.active.messages[index] = event.message;
      else state.active.messages.push(event.message);
      reconcileOptimisticQueueSend(state.active, event.message);
      renderMessages();
    } else if (event.type === "turn_started") {
      state.liveTools.clear();
      state.stream = { id: event.messageId, text: "" };
      renderMessages();
    } else if (event.type === "assistant_delta") {
      if (!state.stream) state.stream = { id: "stream", text: "" };
      state.stream.text += event.delta || "";
      renderMessages();
    } else if (event.type === "tool") {
      if (event.state === "running") state.liveTools.set(event.itemId, event);
      else state.liveTools.delete(event.itemId);
      renderMessages();
    } else if (event.type === "turn_completed") {
      state.liveTools.clear();
      state.stream = null;
      if (!state.active.messages.some((message) => message.id === event.message.id)) state.active.messages.push(event.message);
      renderMessages();
    } else if (event.type === "turn_interrupted" || event.type === "runtime_stopped") {
      state.liveTools.clear(); state.stream = null;
      renderMessages();
    } else if (event.type === "turn_failed") {
      state.liveTools.clear();
      state.stream = null;
      if (!state.active.messages.some((message) => message.id === event.message.id)) state.active.messages.push(event.message);
      renderMessages();
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

async function openNewChat({ closeSidebar = true, project } = {}) {
  if (!state.newChatReady) { state.pendingNewChat = { closeSidebar, project }; return; }
  if (state.creatingChat || state.openingNewChat) return;
  const selection = state.selection = (state.selection || 0) + 1;
  if (state.active) { state.chatDrafts ||= new Map(); state.chatDrafts.set(state.active.id, elements.input.value); }
  state.page = null; state.active = null; state.eventSource?.close(); state.stream = null; state.liveTools.clear();
  history.replaceState(null, "", "#new"); renderChats(); renderActive();
  if (closeSidebar) elements.sidebar.classList.remove("open");
  $("#create-chat-error").textContent = "";
  state.openingNewChat = true; $("#new-chat-status").textContent = "";
  try { await workspaceSettings.openNew(project, { validWhile: () => state.selection === selection }); renderSecurityHint(); if (state.selection === selection) $("#initial-prompt").focus(); }
  catch (error) { $("#create-chat-error").textContent = error.message; }
  finally { state.openingNewChat = false; $("#new-chat-status").textContent = ""; }
}

async function openCompanies() {
  if (!state.newChatReady || state.creatingChat) return;
  state.selection = (state.selection || 0) + 1;
  if (state.active) { state.chatDrafts ||= new Map(); state.chatDrafts.set(state.active.id, elements.input.value); }
  state.page = "companies"; state.active = null; state.eventSource?.close(); state.stream = null; state.liveTools.clear();
  history.replaceState(null, "", "#companies"); elements.sidebar.classList.remove("open"); renderChats(); renderActive();
  await companiesPage.load();
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
  if (state.creatingChat || state.openingNewChat || state.active) return;
  let initialPrompt = $("#initial-prompt").value.trim();
  if (!initialPrompt && !chatControls.attachments().length && !chatControls.uploads.has(chatControls.draftKey())) { $("#initial-prompt").focus(); return; }
  let initialCommand;
  newSlashComposer.close();
  const attachmentDraftKey = chatControls.draftKey();
  state.creatingChat = true;
  const selection = state.selection;
  $("#initial-prompt").value = ""; $("#initial-prompt").style.height = "auto";
  $("#create-chat-error").textContent = "";
  try {
    await chatControls.waitForUploads(attachmentDraftKey);
    if (!initialPrompt) {
      if (!(chatControls.drafts.get(attachmentDraftKey) || []).length) throw new Error("Add a message or a valid file before sending.");
      initialPrompt = "Please inspect the attached files.";
    }
    await workspaceSettings.modelPicker.saving;
    if (state.selection !== selection || state.active) {
      if (!$("#initial-prompt").value) $("#initial-prompt").value = initialPrompt;
      toast("Nothing was sent. Your message and files are kept in the new-chat draft.");
      return;
    }
    if (attachmentDraftKey !== chatControls.newDraftKey()) throw new Error("The company changed. Your files are kept in their original company's draft.");
    const payload = workspaceSettings.payload();
    // Any leading slash is command syntax. Validate against the selected
    // account's effective pre-chat catalog before creating a conversation.
    if (initialPrompt.trim().startsWith("/")) {
      const query = new URLSearchParams({ agent: payload.agent });
      if (payload.agentAccountId) query.set("agentAccountId", payload.agentAccountId);
      const companyId = selectedNewChatCompany(); if (companyId) query.set("companyId", companyId);
      const catalog = await api(`/api/new-chat/commands?${query}`);
      if (state.selection !== selection || state.active) throw new Error("The chat selection changed while its command catalog was loading. Your command was not sent.");
      initialCommand = firstChatCommand(initialPrompt, payload.agent, catalog.commands);
    } else initialCommand = null;
    const { chat } = await api("/api/chats", { method: "POST", body: JSON.stringify(payload) });
    // The permission mode belongs to this chat draft. Never silently inherit
    // Auto or Plan when the user starts a separate conversation.
    workspaceSettings.resetNewChatMode();
    updateChatSummary(chat);
    // Keep the saved chat and its draft if selection or the first send fails.
    // Retrying must never create a second chat or silently lose the prompt.
    state.chatDrafts ||= new Map(); state.chatDrafts.set(chat.id, initialPrompt);
    state.initialMessageChat = chat.id;
    chatControls.moveNewAttachments(attachmentDraftKey, chat.id);
    void workspaceSettings.remember();
    if (state.selection !== selection) {
      state.initialMessageChat = null;
      toast(initialCommand ? "Chat created. Your command is kept in its draft; open it to continue." : "Chat created. Your message and files are kept in its draft; open it to send.");
      return;
    }
    await selectChat(chat.id);
    const firstSendSelection = state.selection;
    if (state.active?.id !== chat.id) { state.initialMessageChat = null; return; }
    let initialAttachments;
    try { initialAttachments = await chatControls.prepareAttachments(chat.id); }
    catch (error) {
      state.initialMessageChat = null;
      if (state.active?.id === chat.id) renderActive();
      toast(`Files could not be uploaded. Your message and files are kept in the new chat; retry Send. ${error.message}`);
      return;
    }
    if (state.active?.id !== chat.id || state.selection !== firstSendSelection) {
      state.initialMessageChat = null;
      toast("Your message and files are kept in the created chat's draft; open it to send.");
      return;
    }
    if (initialCommand) {
      state.initialMessageChat = null;
      if (state.active?.id === chat.id) {
        renderActive();
        elements.input.value = initialPrompt; resizeInput();
        await sendMessage(event);
        if (state.active?.id === chat.id) {
          if (elements.input.value.trim()) state.chatDrafts.set(chat.id, elements.input.value);
          else state.chatDrafts.delete(chat.id);
        }
      } else toast("Chat created. Your command is kept in its draft; open it to continue.");
      return;
    }
    const pendingId = `initial-${chat.id}`;
    if (state.active?.id === chat.id) {
      state.active.messages.push({ id: pendingId, role: "user", kind: "text", text: initialPrompt, attachments: initialAttachments, createdAt: new Date().toISOString() });
      elements.input.value = ""; renderMessages(); elements.detail.textContent = "Preparing workspace and sending your message…";
    }
    try {
      await api(`/api/chats/${chat.id}/messages`, { method: "POST", body: JSON.stringify({ text: initialPrompt, attachments: initialAttachments.map(file => file.id) }) });
      chatControls.clearAttachments(chat.id, initialAttachments.map(file => file.id));
      state.chatDrafts.delete(chat.id);
    } catch (error) {
      if (state.active?.id === chat.id) { elements.input.value = initialPrompt + (elements.input.value ? `\n\n${elements.input.value}` : ""); state.chatDrafts.set(chat.id, elements.input.value); resizeInput(); }
      toast(`First message was not confirmed. Your draft is kept in the new chat. ${error.message}`);
    } finally {
      if (state.initialMessageChat === chat.id) state.initialMessageChat = null;
      if (state.active?.id === chat.id) {
        state.active.messages = state.active.messages.filter(message => message.id !== pendingId); renderActive(); elements.input.focus();
      }
    }
  } catch (error) { $("#initial-prompt").value = initialPrompt; $("#create-chat-error").textContent = error.message; }
  finally {
    state.creatingChat = false;
    workspaceSettings.updateCreateAvailability();
    chatControls.renderAttachments();
  }
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
  if (state.active.workflowState === "archived") {
    const id = state.active.id;
    try {
      const { chat } = await api(`/api/chats/${id}`, { method: "PATCH", body: JSON.stringify({ archived: false }) });
      updateChatSummary(chat);
      if (state.active?.id === id) state.active = { ...state.active, ...chat };
    } catch (error) { toast(error.message); return; }
  }
  const waitingChat = state.active.id;
  if (chatControls.uploads.has(waitingChat)) {
    state.waitingForUploads = true;
    try { await chatControls.waitForUploads(waitingChat); } catch (error) { toast(error.message); return; } finally { state.waitingForUploads = false; }
    if (state.active?.id !== waitingChat) return;
  }
  let files = chatControls.attachments();
  if (files.some(file => file.local)) {
    state.waitingForUploads = true;
    try { files = await chatControls.prepareAttachments(waitingChat); }
    catch (error) { toast(error.message); return; }
    finally { state.waitingForUploads = false; }
    if (state.active?.id !== waitingChat) return;
  }
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
    const selection = state.selection;
    try { if (await runWebCommand(text)) { if (state.selection === selection && state.active?.id === chatId && elements.input.value.trim() === text) { elements.input.value = ""; resizeInput(); } return; } }
    catch (error) { toast(error.message); return; } // Failed controls keep the typed command.
  }
  const queued = ["starting", "running", "stopping"].includes(state.active.status) || state.active.queuedMessages?.length
    || state.initialMessageChat === chatId || runtimeWake.isWaiting(chatId);
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
  if (text === "/copy") {
    const answer = latestCompletedAnswer(state.active.messages);
    if (answer === null) throw new Error("No completed assistant response to copy yet");
    const selection = state.selection;
    await chatControls.copy(answer, "Latest response copied", { validWhile: () => state.selection === selection && state.active?.id === chatId });
    return true;
  }
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
  $("#new-chat-button").disabled = false; $("#new-chat-button").title = "New chat";
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
  $("#new-chat-fields").disabled = false;
  $("#new-chat-button").disabled = false; $("#new-chat-button").title = "New chat";
  $("#isolation-label").textContent = state.config.workerBackend === "ec2"
    ? "One EC2 worker per chat"
    : state.config.processIsolation === "namespace" ? "Private PID namespaces" : "Process isolation disabled";
  renderChats();
  // A user can open the mobile drawer while startup settings are loading.
  // Automatic initial selection must not undo that explicit interaction.
  const linkedChat = state.chats.find(chat => location.hash === `#chat=${chat.id}`), pendingNewChat = state.pendingNewChat;
  state.pendingNewChat = null;
  if (pendingNewChat) await openNewChat(pendingNewChat);
  else if (location.hash === "#companies") await openCompanies();
  else if (linkedChat) await selectChat(linkedChat.id, { closeSidebar: false });
  else await openNewChat({ closeSidebar: false });
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
elements.newForm.addEventListener("submit", createChat);
$("#initial-prompt").addEventListener("keydown", event => {
  if (newSlashComposer.keydown(event)) return;
  if (event.key === "Enter" && !event.repeat && !event.shiftKey && !event.isComposing && event.keyCode !== 229 && !event.ctrlKey && !event.metaKey && !event.altKey) {
    event.preventDefault(); if (!$("#create-chat-button").disabled) elements.newForm.requestSubmit($("#create-chat-button"));
  }
});
$("#initial-prompt").addEventListener("input", event => { event.target.style.height = "auto"; event.target.style.height = `${Math.min(170, event.target.scrollHeight)}px`; });
elements.agentSelect.addEventListener("change", renderSecurityHint);
$("#composer").addEventListener("submit", sendMessage);
const interruptingChats = new Set();
async function interruptAgent() {
  const id = state.active?.id;
  if (!id || interruptingChats.has(id)) return;
  interruptingChats.add(id);
  try {
    const { chat } = await api(`/api/chats/${id}/interrupt`, { method: "POST", body: "{}" });
    if (chat) { updateChatSummary(chat); if (state.active?.id === id && (chat.revision || 0) >= (state.active.revision || 0)) state.active = chat; }
  } catch (error) { toast(`Could not interrupt the agent: ${error.message}`); }
  finally { interruptingChats.delete(id); if (state.active?.id === id) renderActive(); }
}
$("#interrupt-button").addEventListener("click", () => void interruptAgent());
const workerSizeDialog = $("#worker-size-dialog"), workerSizeSelect = $("#worker-instance-type");
const renderWorkerSizeDescription = () => {
  const instance = workspaceSettings.instances?.find(item => item.id === workerSizeSelect.value);
  const region = workspaceSettings.instanceRegion === workspaceSettings.instancePricingRegion ? workspaceSettings.instanceRegion || "configured region" : `${workspaceSettings.instancePricingRegion} reference price`;
  $("#worker-instance-description").textContent = instance ? `${instance.vcpu} vCPU · ${instance.memoryGiB} GiB RAM · $${instance.usdPerHour.toFixed(4)}/hour · ${region}${instance.burstable ? " · burstable CPU" : " · sustained CPU"}` : "";
};
$("#resize-worker-button").addEventListener("click", () => {
  const chat = state.active, instances = workspaceSettings.instances || [];
  if (!chat || !instances.length) { toast("Machine resizing is unavailable for this environment"); return; }
  workerSizeSelect.replaceChildren(...instances.map(instance => {
    const item = node("option", "", `${instance.id} · ${instance.vcpu} vCPU · ${instance.memoryGiB} GiB · $${instance.usdPerHour.toFixed(4)}/hour${instance.recommended ? " · Recommended" : instance.burstable ? " · Burstable" : ""}`);
    item.value = instance.id; return item;
  }));
  const environment = workspaceSettings.environments?.find(item => item.id === chat.environmentId);
  workerSizeSelect.value = chat.workerInstanceType || chat.runtimeMetadata?.instanceType || environment?.instanceType || workspaceSettings.defaultInstanceType || instances[0].id;
  $("#worker-size-error").textContent = ""; renderWorkerSizeDescription(); workerSizeDialog.showModal();
});
workerSizeSelect.addEventListener("change", renderWorkerSizeDescription);
$("#worker-size-form").addEventListener("submit", event => {
  event.preventDefault();
  const chat = state.active, instanceType = workerSizeSelect.value;
  if (!chat || !instanceType) return;
  const previous = chat;
  state.active = { ...chat, workerInstanceType: instanceType, workerResize: { status: "resizing", instanceType, requestedAt: new Date().toISOString() } };
  workerSizeDialog.close(); renderActive();
  void api(`/api/chats/${chat.id}/worker-size`, { method: "PATCH", body: JSON.stringify({ instanceType }) }).then(({ chat: updated }) => {
    if (state.active?.id === updated.id && (updated.revision || 0) >= (state.active.revision || 0)) { state.active = { ...state.active, ...updated }; renderActive(); }
  }).catch(error => {
    if (state.active?.id === previous.id) { state.active = previous; renderActive(); }
    toast(`Could not resize worker: ${error.message}`);
  });
});
function renderWorkingStatus() {
  const text = workingStatus(state.active, state.liveTools);
  $("#working-status").textContent = text;
  $("#working-status").hidden = !text;
}
function renderStartupProgress() {
  startupProgress.update(state.deletingChats.has(state.active?.id) ? null : state.active);
}
setInterval(() => { if (!document.hidden) { renderWorkingStatus(); renderStartupProgress(); } }, 1000);
document.addEventListener("keydown", event => {
  if (!["running", "starting"].includes(state.active?.status) || !canInterruptWithEscape(event)) return;
  event.preventDefault(); void interruptAgent();
});
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
async function deleteChat(chat, { confirmed = false } = {}) {
  if (chat && state.deletingChats.has(chat.id)) return false;
  if (!chat || !confirmed && !confirm(`Permanently delete “${chat.title}”, its messages, and its workspace files? Any running agent will be stopped. This cannot be undone.`)) return false;
  const id = chat.id;
  // Deletion is immediate from the user's perspective. Worker shutdown and
  // workspace cleanup continue in the request without trapping the UI in a
  // modal or a synthetic "deleting" chat state.
  state.deletingChats.add(id);
  await forgetChat(id);
  void api(`/api/chats/${id}`, { method: "DELETE" }).then(() => {
    state.deletingChats.delete(id);
    toast("Chat and workspace permanently deleted.");
  }).catch(async error => {
    state.deletingChats.delete(id);
    toast(`${error.message} The chat was restored; retry deletion.`);
    await sidebar.refresh().catch(() => {});
  });
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
const sidebar = new ChatSidebar({ state, api, select: selectChat, remove: deleteChat, toast, agentLabel, newProject: project => openNewChat({ project }),
  updated: chat => {
    updateChatSummary(chat);
    if (state.active?.id === chat.id) { state.active = { ...state.active, ...chat }; renderActive(); }
  },
});
const workspaceSettings = new WorkspaceSettings({ state, api, toast });
const chatRepositories = new ChatRepositoryPicker({ root: $("#chat-workspace-strip"), api, getChat: () => state.active,
  getEnvironments: () => workspaceSettings.environments, manageEnvironment: id => workspaceSettings.openEnvironments(id),
  updated: chat => { updateChatSummary(chat); if (state.active?.id === chat.id) { state.active = { ...state.active, ...chat }; renderActive(); } },
});
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
const companiesPage = new CompaniesPage({ api, toast, state, navigate: () => companySettings.open() });
const toolActivity = new ToolActivity();
const usagePanel = new UsagePanel({ state, api, toast });
const chatPresence = new ChatPresence({ api });
const documentPreview = new DocumentPreview();
const sideChat = new SideChatPanel({ api, getChat: () => state.active, toast, onPreview: preview => documentPreview.open(preview) });
const agentThreads = new AgentThreadsPanel({ api, getChat: () => state.active, toast, onPreview: preview => documentPreview.open(preview) });
const appPreview = new AppPreviewDialog({ api, getChat: () => state.active, getBackend: () => state.active?.runtimeMetadata?.backend || state.config?.workerBackend });
$("#open-app-preview").onclick = () => appPreview.open();
const sharedBrowser = new SharedBrowserPanel({ api, getBackend: () => state.active?.runtimeMetadata?.backend || state.config?.workerBackend, openApp: options => appPreview.open(options) });
const runtimeWake = new RuntimeWake({ button: $("#wake-worker"), api, getChat: () => state.active,
  changed: () => renderActive(),
  unavailable: id => state.deletingChats.has(id) || state.switchingChat === id,
  updated: chat => {
    if (!chat || state.active?.id !== chat.id || (chat.revision || 0) < (state.active.revision || 0)) return;
    updateChatSummary(chat); state.active = { ...state.active, ...chat }; renderActive();
  },
  ready: id => { if (sharedBrowser.chatId === id && !sharedBrowser.panel.hidden && !sharedBrowser.socket) sharedBrowser.connect(); },
  notify: message => toast(message, { outsideDialog: true }),
});
const browserConnectionSettings = new BrowserConnectionSettings({ api, state, toast, browser: sharedBrowser,
  accountChanged: async () => {
    savedPrompts.invalidate();
    messageSearch.invalidate();
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
const companyPluginSettings = new CompanyPluginSettings({ api });
const companySettings = new CompanySettings({ api, state, workspace: workspaceSettings, mcps: mcpSettings, browsers: browserConnectionSettings, plugins: companyPluginSettings });
const savedPrompts = new SavedPromptPicker({ api, toast, context: () => {
  const selection = state.active || { repositories: workspaceSettings.selected }, companyId = companyForChat(selection);
  const repository = selection.repositories?.[0]?.fullName;
  const project = companyId && repository ? { companyId, repository } : null;
  const company = companyId || workspaceSettings.selectedEnvironment()?.companies?.[0] || "";
  return { key: JSON.stringify([browserConnectionSettings.identityVersion, state.selection, state.active?.id || "new", company, repository || ""]), project,
    input: state.page === "companies" || state.creatingChat ? null : state.active ? elements.input : $("#initial-prompt") };
} });
const chatControls = new ChatControls({ state, api, toast,
  newDraftScope: () => workspaceSettings.selectedEnvironment()?.companies?.[0] || workspaceSettings.selectionCompany || "unassigned",
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
  $(".composer-hint").textContent = `${send ? `${send} to ${busy ? "queue" : "send"}` : "Use the send/queue button"}${busy ? " · Stop interrupts and sends the next queued message" : ""}${newline ? ` · ${newline} for a new line` : ""}`;
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
function selectedNewChatCompany() {
  return companyForChat({ repositories: workspaceSettings.selected }) || workspaceSettings.selectedEnvironment()?.companies?.[0] || workspaceSettings.selectionCompany || "";
}
const newSlashComposer = new SlashComposer({ state, api, input: $("#initial-prompt"), prefix: "new-slash", trigger: null,
  context: () => state.active ? null : { id: "new", agent: $("#agent-select").value, agentAccountId: $("#new-agent-account").value, companyId: selectedNewChatCompany() },
  caption: chat => `${{ codex: "Codex", claude: "Claude", mock: "Mock agent" }[chat.agent] || "Choose an agent"} · new chat · selected account`,
  catalog: chat => chat.agent ? api(`/api/new-chat/commands?agent=${encodeURIComponent(chat.agent)}${chat.agentAccountId ? `&agentAccountId=${encodeURIComponent(chat.agentAccountId)}` : ""}${chat.companyId ? `&companyId=${encodeURIComponent(chat.companyId)}` : ""}`) : Promise.resolve(newChatCommands(null)),
});
for (const id of ["#agent-select", "#new-agent-account"]) $(id).addEventListener("change", () => newSlashComposer.refresh("new"));
window.addEventListener("relay-new-chat-selection-changed", () => newSlashComposer.refresh("new"));
window.addEventListener("relay-company-plugins-changed", () => newSlashComposer.refresh("new"));
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
const messageSearch = new MessageSearch({ api, toast,
  context: () => JSON.stringify([browserConnectionSettings.identityVersion, state.selection]),
  select: (id, messageId) => selectChat(id, { messageId }),
});
const messageNavigator = new MessageNavigator({ state, scroller: elements.messages, root: $("#message-navigator"), ensureVisible: id => { if (messageWindow.show(id)) renderMessages(); } });
const messageFollow = new MessageFollow({ scroller: elements.messages,
  atLatest: () => messageWindow.tail, reading: () => messageNavigator.readingHistory,
  setReading: value => { messageNavigator.readingHistory = value; },
  onChange: () => { $("#message-jump-latest").hidden = !state.active || messageFollow.following(); },
  onScroll: ({ nearBottom }) => {
    if (!messageWindow.rows?.length) return;
    if (elements.messages.scrollTop < 80 && messageWindow.start > 0) { messageNavigator.readingHistory = true; messageWindow.move(-1); renderMessages(); }
    else if (nearBottom && messageWindow.end < messageWindow.rows.length) { messageWindow.move(1); renderMessages(); }
  },
});
$("#message-jump-latest").onclick = () => { messageWindow.latest(); messageFollow.resume(); renderMessages(); };
const activeModelPicker = new ModelPicker({ root: $("#composer-model-controls"), api,
  onCatalogReady: context => { if (claudeCatalogMatchesChat(context, state.active)) slashComposer.refresh(context.chatId); },
  onChange: async settings => {
  if (!state.active) return;
  const id = state.active.id;
  const { chat } = await api(`/api/chats/${id}/model`, { method: "PATCH", body: JSON.stringify(settings) });
  updateChatSummary(chat);
  if (state.active?.id === id) state.active = { ...state.active, ...chat };
} });
let requestedAgentSwitch = null;
let agentSwitchRunning = false;
elements.agentPicker.addEventListener("change", async () => {
  const chat = state.active; if (!chat) return;
  const account = state.config.features?.agentAccounts && chat.agent !== "mock" ? workspaceSettings.accounts?.find(item => item.id === elements.agentPicker.value && item.status === "connected") : null;
  requestedAgentSwitch = { chatId: chat.id, agent: account?.provider || elements.agentPicker.value, agentAccountId: account?.id || null };
  if (agentSwitchRunning) return;
  agentSwitchRunning = true;
  try {
    while (requestedAgentSwitch) {
      const requested = requestedAgentSwitch; requestedAgentSwitch = null;
      const current = state.chats.find(item => item.id === requested.chatId) || (state.active?.id === requested.chatId ? state.active : null);
      if (!current || requested.agent === current.agent && requested.agentAccountId === (current.agentAccountId || null)) continue;
      state.switchingChat = requested.chatId;
      try {
        await activeModelPicker.saving;
        const result = await api(`/api/chats/${requested.chatId}/agent`, { method: "PATCH", body: JSON.stringify({ agent: requested.agent, ...(requested.agentAccountId ? { agentAccountId: requested.agentAccountId } : {}) }) });
        updateChatSummary(result.chat);
        if (state.active?.id === requested.chatId) { state.active = result.chat; state.stream = null; state.liveTools.clear(); }
      } catch (error) { toast(error.message); }
    }
  } finally { agentSwitchRunning = false; state.switchingChat = null; activeModelPicker.key = null; renderActive(); }
});
setInterval(tickCountdown, 1000);

boot().catch((error) => toast(error.message));
