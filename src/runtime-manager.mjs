import { EventEmitter } from "node:events";
import { clampText, errorMessage, newId, nowIso, redact } from "./utils.mjs";
import { prepareWorkspace, prepareRepositories } from "./workspace.mjs";
import { prepareSoftware, captureWorker } from "./software.mjs";
import { CodexAdapter } from "./adapters/codex.mjs";
import { ClaudeAdapter } from "./adapters/claude.mjs";
import { MockAdapter } from "./adapters/mock.mjs";
import { runtimeWorkflowPatch, workflowPatch } from "../public/chat-organization.js";
import { responsePrompt, extractResponse, ResponseStream } from "./response-protocol.mjs";
import { provisionalTitlePatch } from "./title-protocol.mjs";
import { PullRequestMonitor, inspectBranches, inspectWorkspaceStatus } from "./pull-requests.mjs";
import { handoffPrompt } from "./agent-handoff.mjs";
import { snapshotChanges } from "./workspace-changes.mjs";
import { mergeUsage } from "./session-info.mjs";
import { legacyClaudeContext } from "./legacy-usage.mjs";
import { renderingSample } from "./rendering-sample.mjs";
import { messageCommand } from "./message-command.mjs";
import { ChatPresence } from "./chat-presence.mjs";
import { PreviewActivity } from "./preview-activity.mjs";
import { publicRequest, responseFor } from "./agent-requests.mjs";
import { SideChats } from "./side-chats.mjs";
import { NativeAgentSnapshots } from "./native-agent-snapshots.mjs";
import { companyForChat, scopeAllows } from "../public/company-scope.js";
import { snapshotWorkspace } from "./workspace-snapshot.mjs";
import { validateSessionBundle } from "./codex-session-bundle.mjs";
import { readWorkspaceFiles, workspaceContext, contextForTurn, attachmentPrompt } from "./workspace-files.mjs";
import { appReferencesForTurn } from "./codex-apps.mjs";
import { copyImportedImages, importedHistoryWarnings } from "./codex-import-chat.mjs";
import { CodexApprovals } from "./codex-approvals.mjs";
import { CodexFeedback } from "./codex-feedback.mjs";
import { CodexLogout } from "./codex-logout.mjs";
import { desktopBinding, desktopInfo } from "./desktop-handoff.mjs";
import { CLAUDE_PERMISSION_MODES, claudeConfigRequest } from "./claude-settings.mjs";
import { claudeFastRequest, claudeFastScope, claudeFastCredential } from "./claude-fast.mjs";
import { claudeMcpRequest, CLAUDE_MCP_PRIVATE_ERROR } from "./claude-mcp.mjs";
import { claudePluginReloadRequest, CLAUDE_PLUGIN_PRIVATE_ERROR } from "./claude-plugins.mjs";
import { claudeDebugRequest, CLAUDE_DEBUG_PRIVATE_ERROR } from "./claude-debug.mjs";
import { githubWorkerMcpConfig } from "./github-worker-mcp.mjs";
import { runtimeMcpSecrets } from "./worker-capabilities.mjs";
import { HIBERNATION_UNAVAILABLE, hibernationAdmission, hibernationUnavailableError } from "./worker-suspension.mjs";
import { startupStage, failRunningStartup } from "./startup-progress.mjs";

const ADAPTERS = {
  codex: CodexAdapter,
  claude: ClaudeAdapter,
  mock: MockAdapter,
};

function remainingAssistantText(runtime, text) {
  const published = (runtime.assistantText || "").slice(0, runtime.assistantPublishedLength || 0);
  return published && text.startsWith(published.trimEnd()) ? text.slice(published.length).replace(/^\n+/, "") : text;
}
const runtimeAccountBinding = chat => JSON.stringify([chat.ownerId || null, chat.agent, chat.agentAccountId || null]);

export class RuntimeManager extends EventEmitter {
  #runtimes = new Map();
  #queued = new Set();
  #eventIds = new Map();
  #events = new Map();
  #lifecycleVersions = new Map();
  #previewStops = new Map();
  #previewBlocked = new Set();
  #switching = new Set();
  #draining = new Map();
  #submissions = new Map();
  #interruptions = new Map();
  #sendingNow = new Map();
  #queueClaims = new Map();
  #executors = new Map();
  #startupControllers = new Map();
  #forking = new Map();
  #workspaceIdleTimers = new Map();
  #workerWakes = new Map();
  #awakeWorkers = new Set();
  #workerIdleTimers = new Map();
  #modeChanges = new Map();

  #assertNativeAccount(chatId, expectedRuntime = null) {
    const chat = this.store.get(chatId);
    if (!chat) throw Object.assign(new Error("Chat not found"), { statusCode: 404 });
    if (chat.agentAccountId && ["codex", "claude"].includes(chat.agent)) this.agentAccounts.assertConnected(chat.ownerId, chat.agentAccountId, chat.agent);
    const runtime = this.#runtimes.get(chatId);
    if (expectedRuntime && runtime !== expectedRuntime) throw Object.assign(new Error("The native worker stopped or changed before this action could run."), { statusCode: 409 });
    if (runtime?.revoked) throw Object.assign(new Error("This worker has been stopped or revoked. Retry stopping it before resuming."), { statusCode: 409 });
    if (runtime && runtime.accountBinding !== runtimeAccountBinding(chat)) throw Object.assign(new Error("The selected agent account changed; reconnect this worker before continuing."), { statusCode: 409 });
  }

  async #nativeRuntime(chatId) {
    this.#assertNativeAccount(chatId);
    const runtime = this.#runtimes.get(chatId) || await this.#start(chatId);
    this.#assertNativeAccount(chatId, runtime);
    return runtime;
  }

  async enqueue(chatId, rawText, attachmentIds = []) {
    const text = clampText(rawText, 100_000, "message");
    if (!this.store.get(chatId)) throw Object.assign(new Error("Chat not found"), { statusCode: 404 });
    this.#checkClaudeConfiguration(this.store.get(chatId), text, attachmentIds);
    if (this.attachments) await this.attachments.resolve(chatId, attachmentIds);
    const item = { id: newId("queued"), text, attachmentIds, createdAt: nowIso() };
    const chat = await this.store.update(chatId, current => {
      if (current.archived) throw new Error("Unarchive this chat before queueing messages");
      if ((current.queuedMessages || []).length >= 20) throw new Error("Queue holds at most 20 messages");
      return { queuedMessages: [...(current.queuedMessages || []), item] };
    });
    this.publishChat(chat);
    const adapter = this.#runtimes.get(chatId)?.adapter;
    if (adapter?.goal?.status === "active") await adapter.goalAction("pause");
    void this.#drainQueue(chatId);
    return chat;
  }

  async editQueue(chatId, { removeId, resume = false, sendNowId } = {}) {
    if (sendNowId !== undefined) {
      if (removeId !== undefined || resume) throw new Error("Choose one queue action at a time");
      return this.sendQueuedNow(chatId, sendNowId);
    }
    if (this.#sendingNow.has(chatId) || this.#interruptions.has(chatId)) throw Object.assign(new Error("The agent is changing turns; please wait"), { statusCode: 409 });
    const removed = this.store.get(chatId)?.queuedMessages?.find(item => item.id === removeId);
    if (removed?.nativeApprovalId) {
      if (this.#queueClaims.get(chatId) === removeId) throw Object.assign(new Error("This approval retry is already being sent"), { statusCode: 409 });
      await this.approvals.cancel(chatId, removed.nativeApprovalId);
    }
    const chat = await this.store.update(chatId, current => ({
      queuedMessages: (current.queuedMessages || []).filter(item => item.id !== removeId),
      queuePaused: resume ? false : Boolean(current.queuePaused), queueError: null,
    }));
    if (!chat) throw Object.assign(new Error("Chat not found"), { statusCode: 404 });
    this.publishChat(chat);
    if (resume) void this.#drainQueue(chatId);
    return chat;
  }

  sendQueuedNow(chatId, itemId) {
    const chat = this.store.get(chatId);
    if (!chat) throw Object.assign(new Error("Chat not found"), { statusCode: 404 });
    const pending = this.#sendingNow.get(chatId);
    if (pending?.id === itemId) return pending.promise;
    if (pending || this.#interruptions.has(chatId) || this.#switching.has(chatId) || chat.status === "stopping") throw Object.assign(new Error("This chat is already changing; please wait"), { statusCode: 409 });
    if (chat.archived) throw Object.assign(new Error("Unarchive this chat before sending a message"), { statusCode: 409 });
    const item = typeof itemId === "string" && chat.queuedMessages?.find(entry => entry.id === itemId);
    if (!item) throw Object.assign(new Error("Queued message not found; it may already have been sent"), { statusCode: 404 });
    if (this.#queueClaims.get(chatId) === itemId) throw Object.assign(new Error("This queued message is already being sent"), { statusCode: 409 });
    const action = { id: itemId };
    this.#sendingNow.set(chatId, action);
    action.promise = this.#sendQueuedNow(chatId, item, action).finally(() => {
      this.#sendingNow.delete(chatId);
      void this.#drainQueue(chatId);
    });
    return action.promise;
  }

  async #sendQueuedNow(chatId, item, action) {
    const version = this.#lifecycleVersions.get(chatId) || 0;
    const turn = this.#submissions.get(chatId);
    if (turn) {
      turn.cancelled = true;
      try {
        const adapter = this.#runtimes.get(chatId)?.adapter;
        // Interrupt the provider turn, not the worker/VM or shared Chrome.
        if (adapter) {
          if (!adapter.interrupt) throw new Error("This agent does not support turn interruption");
          await adapter.interrupt();
        }
      } catch (error) { turn.cancelled = false; throw error; }
      await turn.done;
      this.#emit(chatId, { type: "turn_interrupted" });
    } else {
      const runtime = this.#runtimes.get(chatId);
      if (runtime?.adapter.isBackgroundBusy?.()) {
        await runtime.adapter.interrupt();
        await runtime.eventQueue;
        this.#emit(chatId, { type: "turn_interrupted" });
      }
    }
    await this.#draining.get(chatId);
    if (version !== (this.#lifecycleVersions.get(chatId) || 0)) throw Object.assign(new Error("Send now cancelled because the chat was stopped"), { name: "AbortError", statusCode: 409 });
    // Keep the existing paused/running policy and the order of all other items.
    await this.#submitQueued(chatId, item, action);
    return this.store.get(chatId);
  }

  async #submitQueued(chatId, item, action = null) {
    const version = this.#lifecycleVersions.get(chatId) || 0;
    this.#queueClaims.set(chatId, item.id);
    let approval;
    try {
      approval = item.nativeApprovalId ? await this.approvals.claim(chatId, item.nativeApprovalId) : null;
      if (version !== (this.#lifecycleVersions.get(chatId) || 0)) throw Object.assign(new Error("Queued message cancelled because the chat stopped"), { name: "AbortError" });
      const submitted = await this.#submit(chatId, item.text, item.attachmentIds, action, approval);
      this.publishChat(await this.store.update(chatId, current => ({ queuedMessages: (current.queuedMessages || []).filter(entry => entry.id !== item.id) })));
      return submitted;
    } catch (error) {
      if (approval) await this.approvals.cancel(chatId, approval.id).catch(() => {});
      throw error;
    } finally { this.#queueClaims.delete(chatId); }
  }

  #drainQueue(chatId) {
    if (this.#draining.has(chatId)) return this.#draining.get(chatId);
    const draining = this.#runQueue(chatId).finally(() => this.#draining.delete(chatId));
    this.#draining.set(chatId, draining);
    return draining;
  }

  async #runQueue(chatId) {
    try {
      while (true) {
        const chat = this.store.get(chatId);
        if (!chat || chat.queuePaused || chat.archived || this.isBusy(chatId) || chat.status === "stopping" || !chat.queuedMessages?.length) break;
        const item = chat.queuedMessages[0];
        const submitted = await this.#submitQueued(chatId, item);
        await submitted.completion;
      }
    } catch (error) {
      if (error.name !== "AbortError" || !this.#sendingNow.has(chatId)) this.publishChat(await this.store.update(chatId, { queuePaused: true, queueError: error.name === "AbortError" ? null : errorMessage(error) }));
    }
  }

  constructor({ store, config, broker, gatewayOrigin, workerBackend = null, adapterFactory = null, github = null, githubWorkers = null, environments = null, models = null, attachments = null, mcps = null, commands = null, resources = null, agentAccounts = null }) {
    super();
    this.store = store;
    this.config = config;
    this.presence = new ChatPresence({ onChange: chatId => this.refreshActivity(chatId) });
    this.previewActivity = new PreviewActivity({ generation: chatId => this.previewGeneration(chatId), acquire: chatId => this.browserExecutor(chatId),
      onChange: async chatId => {
        const version = this.previewGeneration(chatId);
        clearTimeout(this.#workspaceIdleTimers.get(chatId)); this.#workspaceIdleTimers.delete(chatId);
        await this.refreshActivity(chatId);
        if (version !== this.previewGeneration(chatId) || this.previewActivity.closed) return;
        if (!this.previewActivity.has(chatId) && !this.workspacePresence.has(chatId)) {
          const timer = setTimeout(() => { this.#workspaceIdleTimers.delete(chatId); if (this.#executors.has(chatId)) void this.browserIdle(chatId).catch(() => {}); }, this.config.idleTimeoutMs);
          timer.unref?.(); this.#workspaceIdleTimers.set(chatId, timer);
        }
      } });
    this.workspacePresence = new ChatPresence({ onChange: async chatId => {
      const version = this.#lifecycleVersions.get(chatId) || 0;
      clearTimeout(this.#workspaceIdleTimers.get(chatId)); this.#workspaceIdleTimers.delete(chatId);
      await this.refreshActivity(chatId);
      if (version !== (this.#lifecycleVersions.get(chatId) || 0)) return;
      if (!this.workspacePresence.has(chatId)) {
        const timer = setTimeout(() => { this.#workspaceIdleTimers.delete(chatId); if (this.#executors.has(chatId)) void this.browserIdle(chatId).catch(() => {}); }, this.config.idleTimeoutMs);
        timer.unref?.(); this.#workspaceIdleTimers.set(chatId, timer);
      }
    } });
    this.broker = broker;
    this.gatewayOrigin = gatewayOrigin;
    this.workerBackend = workerBackend || {
      acquire: async () => null,
      sleep: async () => {},
      destroy: async () => {},
    };
    this.adapterFactory = adapterFactory;
    this.github = github;
    this.githubWorkers = githubWorkers;
    this.agentAccounts = agentAccounts;
    this.environments = environments;
    this.models = models;
    this.attachments = attachments;
    this.mcps = mcps;
    this.resources = resources;
    if (this.environments) this.environments.onSaved = async environment => {
      for (const chat of this.store.list()) if (chat.environmentId === environment.id) {
        const company = companyForChat(chat);
        this.mcps?.restrictChat(chat.id, scopeAllows(environment, company) ? this.mcps?.companies ? await this.mcps.forCompany(company) : environment.mcpIds || [] : []);
      }
    };
    this.commands = commands;
    this.pullRequests = new PullRequestMonitor({ store, github: resources?.githubForMonitor() || github, publish: chat => this.publishChat(chat) });
    this.agentThreads = new NativeAgentSnapshots(store, (chatId, snapshot) => this.#emit(chatId, { type: "agent_threads_updated", ...snapshot }, false));
    this.approvals = new CodexApprovals(store, config);
    this.feedback = new CodexFeedback(store, config);
    this.logout = new CodexLogout(store, config);
    this.sideChats = new SideChats({
      authorize: chatId => this.#assertNativeAccount(chatId),
      fork: (chatId, hooks) => this.#forkSide(chatId, hooks),
      prepare: (chatId, text, ids, first) => this.#prepareSide(chatId, text, ids, first),
      publish: (chatId, snapshot) => this.#emit(chatId, { type: "side_chat_updated", ...snapshot }, false),
      activity: chatId => this.refreshActivity(chatId),
    });
  }

  async #forkSide(chatId, hooks) {
    const chat = this.store.get(chatId);
    if (!chat) throw Object.assign(new Error("Chat not found"), { statusCode: 404 });
    if (chat.agent !== "codex") throw new Error("Temporary side chats require Codex");
    if (chat.archived) throw new Error("Unarchive this chat before opening a side chat");
    if (this.#switching.has(chatId) || ["starting", "stopping"].includes(chat.status)) throw Object.assign(new Error("Wait for the current worker change to finish"), { statusCode: 409 });
    this.#switching.add(chatId);
    const version = this.#lifecycleVersions.get(chatId) || 0;
    try {
      const runtime = await this.#nativeRuntime(chatId);
      if (version !== (this.#lifecycleVersions.get(chatId) || 0)) throw new Error("Side chat cancelled because the worker stopped");
      if (!runtime.adapter.forkSide) throw new Error("This worker does not support temporary side chats");
      clearTimeout(runtime.idleTimer); runtime.idleTimer = null;
      this.#assertNativeAccount(chatId, runtime);
      return await runtime.adapter.forkSide(hooks);
    } finally { this.#switching.delete(chatId); void this.#drainQueue(chatId); }
  }

  async agentThreadAction(chatId, action, input = {}) {
    const chat = this.store.get(chatId);
    if (!chat) throw Object.assign(new Error("Chat not found"), { statusCode: 404 });
    if (chat.agent !== "codex") throw new Error("Native agent threads require Codex");
    if (chat.archived) throw new Error("Unarchive this chat before connecting to its agents");
    if (!["refresh", "select", "messages", "stop", "respond"].includes(action)) throw new Error("Unknown agent action");
    if (action !== "refresh" && (!input.rootThreadId || input.rootThreadId !== chat.agentSessionId)) throw Object.assign(new Error("The chat's native session changed; reopen the agent picker"), { statusCode: 409 });
    if (this.#switching.has(chatId) || ["starting", "stopping"].includes(chat.status)) throw Object.assign(new Error("Wait for the current worker change to finish"), { statusCode: 409 });
    this.#switching.add(chatId);
    const version = this.#lifecycleVersions.get(chatId) || 0;
    try {
      const runtime = await this.#nativeRuntime(chatId);
      if (version !== (this.#lifecycleVersions.get(chatId) || 0)) throw new Error("Agent action cancelled because the worker stopped");
      const agents = runtime.adapter.agents;
      if (!agents) throw new Error("This worker does not support native agent navigation");
      if (action === "messages" && (runtime.adapter.plugins?.changing || runtime.adapter.plugins?.needsRefresh)) throw Object.assign(new Error("Refresh /plugins to finish reconciling the plugin change before sending to an agent"), { statusCode: 409 });
      if (action === "messages" && (runtime.adapter.hookControls?.changing || runtime.adapter.hookControls?.needsRefresh)) throw Object.assign(new Error("Refresh /hooks to finish reconciling the hook change before sending to an agent"), { statusCode: 409 });
      if (action === "messages" && (runtime.adapter.featureControls?.changing || runtime.adapter.featureControls?.needsRefresh)) throw Object.assign(new Error("Refresh /experimental to finish reconciling the feature change before sending to an agent"), { statusCode: 409 });
      if (action === "messages" && (runtime.adapter.memoryControls?.changing || runtime.adapter.memoryControls?.needsRefresh)) throw Object.assign(new Error("Refresh /memories to finish reconciling the memory change before sending to an agent"), { statusCode: 409 });
      if (action === "messages") await this.#assertImportReady(chatId);
      this.#assertNativeAccount(chatId, runtime);
      if (action !== "refresh" && input.rootThreadId !== this.store.get(chatId)?.agentSessionId) throw Object.assign(new Error("The native session changed; reopen the agent picker"), { statusCode: 409 });
      clearTimeout(runtime.idleTimer); runtime.idleTimer = null;
      if (action === "refresh") return await agents.refresh();
      if (action === "select") return await agents.select(input.threadId, input.cursor);
      if (action === "messages") return await agents.send(input.threadId, input, chat.mode || "accept_edits");
      if (action === "stop") return await agents.interrupt(input.threadId);
      return await agents.respond(input.threadId, input.requestId, input);
    } finally { this.#switching.delete(chatId); await this.refreshActivity(chatId); void this.#drainQueue(chatId); }
  }

  async nativeApps(chatId, input = {}, guard = () => {}) {
    guard();
    const chat = this.store.get(chatId);
    if (!chat) throw Object.assign(new Error("Chat not found"), { statusCode: 404 });
    if (chat.agent !== "codex") throw new Error("Native apps require Codex");
    if (chat.archived) throw new Error("Unarchive this chat before choosing an app");
    if (this.#switching.has(chatId) || ["starting", "stopping"].includes(chat.status)) throw Object.assign(new Error("Wait for the worker change to finish"), { statusCode: 409 });
    this.#switching.add(chatId);
    const version = this.#lifecycleVersions.get(chatId) || 0;
    const check = () => {
      guard();
      this.#assertNativeAccount(chatId);
      const current = this.store.get(chatId);
      if (version !== (this.#lifecycleVersions.get(chatId) || 0) || !current || current.agent !== chat.agent || companyForChat(current) !== companyForChat(chat) || current.ownerId !== chat.ownerId) throw Object.assign(new Error("The app request was cancelled because the chat changed or stopped"), { statusCode: 409 });
      return current;
    };
    try {
      const runtime = await this.#nativeRuntime(chatId);
      check();
      if (!runtime.adapter.apps) throw new Error("This worker does not support native apps; update its Codex CLI");
      clearTimeout(runtime.idleTimer); runtime.idleTimer = null;
      if (!Object.hasOwn(input, "appId")) {
        const result = await runtime.adapter.apps.list();
        if (check().agentSessionId !== result.threadId) throw Object.assign(new Error("The native session changed; reopen the app picker"), { statusCode: 409 });
        return result;
      }
      const app = await runtime.adapter.apps.select(input.appId, input.threadId), current = check();
      if (current.agentSessionId !== app.threadId) throw Object.assign(new Error("The native session changed; reopen the app picker"), { statusCode: 409 });
      const attachment = await this.attachments.selectApp(chatId, { id: app.id, name: app.name, token: app.token, threadId: app.threadId, company: companyForChat(current), ownerId: current.ownerId || null });
      check();
      return { attachment, token: app.token };
    } finally { this.#switching.delete(chatId); await this.refreshActivity(chatId); void this.#drainQueue(chatId); }
  }

  nativePlugins(chatId, input = {}, guard = () => {}) { return this.#nativeSettings(chatId, "plugin", input, guard); }
  nativeHooks(chatId, input = {}, guard = () => {}) { return this.#nativeSettings(chatId, "hook", input, guard); }
  nativeFeatures(chatId, input = {}, guard = () => {}) { return this.#nativeSettings(chatId, "feature", input, guard); }
  nativeMemories(chatId, input = {}, guard = () => {}) { return this.#nativeSettings(chatId, "memory", input, guard); }

  async desktopHandoff(chatId, guard = () => {}) {
    guard(); const chat = this.store.get(chatId);
    if (!chat) throw Object.assign(new Error("Chat not found"), { statusCode: 404 });
    if (chat.agent !== "codex") throw new Error("Desktop handoff requires a Codex chat");
    const binding = desktopBinding(chat, this.config), version = this.#lifecycleVersions.get(chatId) || 0;
    const check = () => {
      guard(); const current = this.store.get(chatId);
      if (!current || desktopBinding(current, this.config) !== binding || version !== (this.#lifecycleVersions.get(chatId) || 0)) throw Object.assign(new Error("The chat changed or stopped. Refresh the desktop handoff."), { statusCode: 409 });
    };
    const runtime = this.#runtimes.get(chatId);
    let snapshot = null, checkedNow = false;
    if (runtime?.adapter.desktopSession && !["starting", "stopping"].includes(chat.status)) {
      snapshot = await runtime.adapter.desktopSession(check); check();
      checkedNow = true;
      if (this.store.records) {
        await this.store.records.put("desktop-handoff", chatId, { binding, snapshot });
        try { check(); } catch (error) {
          if (!this.store.get(chatId)) await this.store.records.delete("desktop-handoff", chatId);
          throw error;
        }
      }
    } else if (this.store.records) {
      const saved = await this.store.records.get("desktop-handoff", chatId); check();
      if (saved?.binding === binding) snapshot = saved.snapshot;
    }
    check();
    return desktopInfo(chat, snapshot, { awake: checkedNow, busy: this.isBusy(chatId) || this.sideChats.busy(chatId) || Boolean(runtime?.adapter.nativeSettingsBusy?.()) });
  }

  async nativeWorkspaceTrust(chatId, action, input = {}, guard = () => {}, actor = "shared") {
    await guard(); const chat = this.store.get(chatId);
    if (!chat) throw Object.assign(Error("Chat not found"), { statusCode: 404 });
    if (chat.agent !== "claude" || chat.archived || !["inspect", "confirm"].includes(action)) throw Error("Workspace trust requires an unarchived Claude chat and a valid action.");
    if (this.config.claude.authMode !== "gateway" && !chat.agentAccountId) throw Object.assign(Error("Workspace trust requires this chat's private Claude profile. Shared host profiles remain locked; no worker was started."), { statusCode: 409 });
    if (["starting", "stopping"].includes(chat.status) || this.isBusy(chatId) || this.sideChats.busy(chatId)) throw Object.assign(Error("Wait for this chat and its agents to be idle before reviewing workspace trust."), { statusCode: 409 });
    this.#switching.add(chatId);
    const version = this.#lifecycleVersions.get(chatId) || 0;
    const scope = value => JSON.stringify([value.ownerId, value.environmentId, value.workspace, value.repositories, companyForChat(value), value.agentAccountId || null]), initialScope = scope(chat);
    const check = async () => {
      await guard(); const current = this.store.get(chatId);
      this.#assertNativeAccount(chatId);
      if (!current || current.archived || current.agent !== "claude" || this.config.claude.authMode !== "gateway" && !current.agentAccountId || scope(current) !== initialScope || version !== (this.#lifecycleVersions.get(chatId) || 0)) throw Object.assign(Error("Workspace trust review is no longer current because the chat changed or stopped. If you submitted confirmation, trust may already have been saved; inspect again."), { statusCode: 409 });
    };
    let reviewedRuntime;
    try {
      await check(); let runtime = this.#runtimes.get(chatId);
      if (!runtime && action === "inspect") runtime = await this.#start(chatId);
      await check();
      if (!runtime) throw Object.assign(Error("The reviewed worker stopped. Inspect the workspace again."), { statusCode: 409 });
      if (!runtime.adapter.workspaceTrust) throw Error("Update this Claude worker to support workspace trust review.");
      reviewedRuntime = runtime; runtime.trustReviewing = true;
      clearTimeout(runtime.idleTimer); runtime.idleTimer = null;
      const binding = JSON.stringify([actor, version, initialScope, runtime.executor?.workspace || chat.workspace, runtime.executor?.runtimeHome || this.store.runtimeHome(chatId)]);
      this.#assertNativeAccount(chatId, runtime);
      const result = await runtime.adapter.workspaceTrust(action, input, binding, check); await check(); return result;
    } finally { if (reviewedRuntime) reviewedRuntime.trustReviewing = false; this.#switching.delete(chatId); await this.refreshActivity(chatId); void this.#drainQueue(chatId); }
  }

  async nativeLogout(chatId, action = "status", input = {}, guard = () => {}) {
    guard(); const chat = this.store.get(chatId);
    if (!chat) throw Object.assign(new Error("Chat not found"), { statusCode: 404 });
    if (chat.agent !== "codex") throw new Error("Native sign-out requires Codex");
    if (chat.agentAccountId) return { reviews: [], threadId: chat.agentSessionId || null, privateProfile: true, canLogout: false, gateway: false, busy: false,
      review: null, account: null, storage: "ephemeral", reason: "Disconnect this named account in Agent accounts. That stops its chats and removes the controller's saved credentials; a worker-only sign-out would reconnect on the next turn." };
    if (action === "status") { const result = await this.logout.status(chatId); guard(); return result; }
    if (!["inspect", "confirm"].includes(action) || chat.archived) throw new Error("Choose a sign-out action in an unarchived Codex chat");
    if (action === "confirm") { const prior = await this.logout.existing(chatId, input); guard(); if (prior) return prior; }
    if (this.config.codex.authMode !== "gateway") return { threadId: chat.agentSessionId || null, privateProfile: false, canLogout: false, gateway: false, busy: false,
      review: null, account: null, storage: null, reason: "Shared host sign-out is locked until company/profile isolation is complete. No worker was started and no credentials were accessed." };
    if (this.#switching.has(chatId) || ["starting", "stopping"].includes(chat.status)) throw Object.assign(new Error("Wait for the current worker operation to finish"), { statusCode: 409 });
    if (action === "confirm" && (this.isBusy(chatId) || this.sideChats.busy(chatId))) throw Object.assign(new Error("Wait for this chat and its agents to be idle before signing out"), { statusCode: 409 });
    this.#switching.add(chatId); const version = this.#lifecycleVersions.get(chatId) || 0;
    const scope = value => JSON.stringify([value.ownerId, value.environmentId, value.workspace, value.repositories, companyForChat(value)]), initialScope = scope(chat);
    const check = () => { guard(); const current = this.store.get(chatId); if (!current || current.archived || current.agent !== "codex" || scope(current) !== initialScope || version !== (this.#lifecycleVersions.get(chatId) || 0)) throw Object.assign(new Error("Native sign-out was cancelled because the chat changed or stopped"), { statusCode: 409 }); };
    let adapter;
    try {
      check(); let runtime = this.#runtimes.get(chatId);
      if (!runtime && action === "inspect") runtime = await this.#start(chatId);
      check(); if (!runtime) throw Object.assign(new Error("The reviewed worker stopped. Inspect the native account again."), { statusCode: 409 });
      adapter = runtime.adapter;
      if (!adapter.logoutSnapshot || !adapter.performLogout) throw new Error("Update this Codex worker to support scoped native sign-out");
      clearTimeout(runtime.idleTimer); runtime.idleTimer = null;
      if (action === "inspect") return await this.logout.inspect(chatId, adapter, check);
      adapter.logoutChanging = true;
      const result = await this.logout.confirm(chatId, input, adapter, check, async () => {
        check(); this.publishChat(await this.store.update(chatId, () => { check(); return { queuePaused: true }; })); check();
      });
      check(); return result;
    } finally {
      if (adapter) adapter.logoutChanging = false;
      this.commands?.invalidate(chatId); this.#switching.delete(chatId); await this.refreshActivity(chatId); void this.#drainQueue(chatId);
    }
  }

  async nativeFeedback(chatId, action = "status", input = {}, guard = () => {}) {
    guard(); const chat = this.store.get(chatId);
    if (!chat) throw Object.assign(new Error("Chat not found"), { statusCode: 404 });
    if (chat.agent !== "codex") throw new Error("Native feedback requires Codex");
    if (action === "status") { const result = await this.feedback.status(chatId); guard(); return result; }
    if (!["policy", "prepare", "send"].includes(action) || chat.archived) throw new Error("Choose a feedback action in an unarchived Codex chat");
    // A duplicate submission can inspect its persisted outcome even while the
    // original HTTP request is awaiting the native acknowledgement.
    if (action === "send") { const prior = await this.feedback.existing(chatId, input); guard(); if (prior) return prior; }
    if (this.#switching.has(chatId) || ["starting", "stopping"].includes(chat.status)) throw Object.assign(new Error("Wait for the current worker operation to finish"), { statusCode: 409 });
    this.#switching.add(chatId);
    const version = this.#lifecycleVersions.get(chatId) || 0;
    const scope = current => JSON.stringify([current.ownerId, current.environmentId, current.workspace, companyForChat(current), current.repositories]);
    const originalScope = scope(chat);
    const check = () => {
      guard(); const current = this.store.get(chatId);
      this.#assertNativeAccount(chatId);
      if (version !== (this.#lifecycleVersions.get(chatId) || 0) || !current || current.archived || current.agent !== "codex" || scope(current) !== originalScope) throw Object.assign(new Error("The feedback request was cancelled because the chat changed or stopped"), { statusCode: 409 });
    };
    try {
      check(); let runtime = this.#runtimes.get(chatId);
      // Preparing explicitly connects an existing chat. Confirming NEVER wakes
      // a replacement worker whose diagnostic contents were not reviewed.
      if (!runtime && action !== "send") runtime = await this.#start(chatId);
      check();
      if (!runtime) throw Object.assign(new Error("The reviewed worker stopped. Prepare a new feedback review."), { statusCode: 409 });
      if (!runtime.adapter.feedbackPolicy || !runtime.adapter.uploadFeedback) throw new Error("Update this Codex worker to support native feedback");
      clearTimeout(runtime.idleTimer); runtime.idleTimer = null;
      const result = action === "policy" ? await runtime.adapter.feedbackPolicy(check) : await this.feedback[action](chatId, input, runtime.adapter, check);
      check(); return result;
    } finally { this.#switching.delete(chatId); await this.refreshActivity(chatId); void this.#drainQueue(chatId); }
  }

  async nativeImports(chatId, action = "list", input = {}, guard = () => {}) {
    guard(); const chat = this.store.get(chatId);
    if (!chat) throw Object.assign(new Error("Chat not found"), { statusCode: 404 });
    if (chat.agent !== "codex" || chat.archived) throw new Error("Native imports require an unarchived Codex chat");
    if (!["list", "status", "refresh", "start", "acknowledge", "open"].includes(action)) throw new Error("Unknown native import action");
    const mutation = ["start", "acknowledge", "open"].includes(action);
    if (this.#switching.has(chatId) || ["starting", "stopping"].includes(chat.status)) throw Object.assign(new Error("Wait for the current worker change to finish"), { statusCode: 409 });
    if (mutation && (input.threadId !== chat.agentSessionId || input.confirm !== true)) throw Object.assign(new Error("Refresh and confirm the import action in this chat"), { statusCode: 409 });
    this.#switching.add(chatId);
    const version = this.#lifecycleVersions.get(chatId) || 0;
    const check = () => {
      guard(); const current = this.store.get(chatId);
      this.#assertNativeAccount(chatId);
      if (version !== (this.#lifecycleVersions.get(chatId) || 0) || !current || current.archived || current.agent !== chat.agent || current.ownerId !== chat.ownerId || current.environmentId !== chat.environmentId || companyForChat(current) !== companyForChat(chat) || mutation && current.agentSessionId !== input.threadId) throw Object.assign(new Error("The import request was cancelled because the chat changed or stopped"), { statusCode: 409 });
    };
    try {
      const runtime = await this.#nativeRuntime(chatId); check();
      const service = runtime.adapter.importControls;
      if (!service) throw new Error("Native import requires encrypted operation storage and a supported Codex worker");
      if (mutation && (runtime.busy || this.sideChats.busy(chatId))) throw Object.assign(new Error("Wait for the agents to be idle before importing"), { statusCode: 409 });
      const other = [["plugins", runtime.adapter.plugins], ["hooks", runtime.adapter.hookControls], ["experimental", runtime.adapter.featureControls], ["memories", runtime.adapter.memoryControls]].find(([, candidate]) => candidate?.changing || candidate?.needsRefresh);
      if (mutation && other) throw Object.assign(new Error(`Refresh /${other[0]} to reconcile the previous change first`), { statusCode: 409 });
      clearTimeout(runtime.idleTimer); runtime.idleTimer = null;
      const result = action === "open" ? { threadId: runtime.adapter.threadId, chat: await this.#openImportedChat(chat, runtime, input, check) }
        : action === "list" ? await service.list(input.source || "claude-code", check) : action === "status" ? service.status() : action === "refresh" ? await service.refresh(check) : await service[action](input, check);
      check();
      if (result.threadId !== this.store.get(chatId)?.agentSessionId) throw Object.assign(new Error("The native session changed; reopen the import picker"), { statusCode: 409 });
      return result;
    } catch (error) {
      // A native request wrapper sanitizes provider errors, but a revoked
      // owner/lifecycle guard must retain its own 404/409 response.
      check(); throw error;
    } finally {
      this.commands?.invalidate(chatId);
      this.#switching.delete(chatId); await this.refreshActivity(chatId); void this.#drainQueue(chatId);
    }
  }

  #importPending(chatId) {
    const service = this.#runtimes.get(chatId)?.adapter.importControls;
    return Boolean(service?.changing || service?.needsRefresh);
  }

  async #openImportedChat(source, runtime, input, check) {
    if (typeof input.operationId !== "string" || typeof input.sessionId !== "string") throw new Error("Choose a conversation from this chat's recorded import results");
    const selected = runtime.adapter.importControls.importedSession(input.operationId, input.sessionId, check);
    const existing = this.store.list().find(chat => chat.importedFromChatId === source.id && chat.importedOperationId === input.operationId && chat.importedSessionId === input.sessionId && chat.ownerId === source.ownerId && companyForChat(chat) === companyForChat(source));
    if (existing) return existing;
    if (!runtime.adapter.forkImportedSession || !this.attachments) throw new Error("This worker cannot open an imported conversation as an independent chat");
    const action = { controller: new AbortController() }; this.#forking.set(source.id, action);
    const guard = () => { action.controller.signal.throwIfAborted(); check(); };
    let imported, targetId;
    try {
      if (source.environmentId) await (await this.servicesFor(source)).environments.runtime(source.environmentId, source); guard();
      imported = await runtime.adapter.forkImportedSession(input.operationId, input.sessionId, guard); guard();
      validateSessionBundle(imported.bundle);
      const chat = await this.store.create({ title: selected.title.slice(0, 120), ownerId: source.ownerId, agent: "codex", agentAccountId: source.agentAccountId, source: source.source, repositories: source.repositories,
        environmentId: source.environmentId, environmentName: source.environmentName, model: source.model, effort: source.effort, modelSelectionSet: source.modelSelectionSet, autoTitle: false }, async target => {
        targetId = target.id;
        guard();
        await snapshotWorkspace({ executor: runtime.executor, source: runtime.executor?.workspace || source.workspace, destination: target.workspace, signal: action.controller.signal }); guard();
        const images = await copyImportedImages(imported.messages, runtime.executor?.workspace || source.workspace, target.workspace, guard);
        const attached = await this.attachments.importTranscript(target.id, images.messages); guard();
        await this.store.records.put("native-fork", target.id, { chatId: target.id, bundle: imported.bundle, paths: attached.paths, authMode: source.agentAccountId ? "account" : this.config.codex.authMode, initialized: false }); guard();
        return { messages: attached.messages, mode: source.mode, serviceTier: source.serviceTier, personality: source.personality, workspaceReady: true,
          nativeForkSessionId: imported.bundle.threadId, agentSessionId: imported.bundle.threadId, forkContextPending: true, forkGoalPending: imported.bundle.goal?.status === "active",
          goal: imported.bundle.goal ? { ...imported.bundle.goal, status: imported.bundle.goal.status === "active" ? "paused" : imported.bundle.goal.status } : null,
          importedFromChatId: source.id, importedOperationId: input.operationId, importedSessionId: input.sessionId, importedSource: imported.source,
          importWarnings: [...importedHistoryWarnings(attached.messages), ...(images.unavailable ? [`${images.unavailable} historical image(s) could not be copied. Inline images and ordinary workspace files are supported; external URLs and files outside the workspace were not fetched.`] : [])],
          statusDetail: "Imported conversation ready · independent workspace. Send a message to continue." };
      });
      try { guard(); } catch (error) { await this.store.remove(chat.id); throw error; }
      runtime.adapter.releaseFork?.(imported.bundle.threadId); this.publishChat(chat); return chat;
    } catch (error) {
      if (targetId) { await this.store.records.delete("native-fork", targetId).catch(() => {}); await this.attachments.removeChat(targetId); }
      if (imported?.bundle) await runtime.adapter.discardFork?.(imported.bundle.threadId).catch(() => {});
      throw error;
    } finally { if (this.#forking.get(source.id) === action) this.#forking.delete(source.id); }
  }

  async #assertImportReady(chatId) {
    if (this.store.get(chatId)?.agent !== "codex") return;
    const saved = !this.#runtimes.has(chatId) ? await this.store.records?.get("native-import", chatId) : null;
    if (this.#importPending(chatId) || saved?.jobs?.some(job => !job.reconciled || ["starting", "running", "uncertain"].includes(job.phase))) throw Object.assign(new Error("Refresh /import to finish reconciling the import before starting agent work"), { statusCode: 409 });
  }

  async #nativeSettings(chatId, kind, input, guard) {
    const label = kind === "memory" ? "memories" : `${kind}s`;
    guard(); const chat = this.store.get(chatId);
    if (!chat) throw Object.assign(new Error("Chat not found"), { statusCode: 404 });
    if (chat.agent !== "codex") throw new Error(`Native ${label} require Codex`);
    if (chat.archived) throw new Error(`Unarchive this chat before managing ${label}`);
    const mutation = Object.hasOwn(input, "action");
    if (this.#switching.has(chatId) || ["starting", "stopping"].includes(chat.status) || (mutation && (this.isBusy(chatId) || this.sideChats.busy(chatId)))) throw Object.assign(new Error(`Wait for this chat and its agents to be idle before changing ${label}`), { statusCode: 409 });
    if (mutation && (input.threadId !== chat.agentSessionId || input.confirm !== true)) throw Object.assign(new Error(`Refresh and confirm the ${kind} action in this chat`), { statusCode: 409 });
    this.#switching.add(chatId);
    const version = this.#lifecycleVersions.get(chatId) || 0;
    const check = () => {
      guard(); const current = this.store.get(chatId);
      this.#assertNativeAccount(chatId);
      if (version !== (this.#lifecycleVersions.get(chatId) || 0) || !current || current.archived || current.agent !== chat.agent || current.ownerId !== chat.ownerId || companyForChat(current) !== companyForChat(chat) || (mutation && current.agentSessionId !== input.threadId)) throw Object.assign(new Error(`The ${kind} request was cancelled because the chat changed or stopped`), { statusCode: 409 });
    };
    try {
      const runtime = await this.#nativeRuntime(chatId); check();
      const service = { plugin: runtime.adapter.plugins, hook: runtime.adapter.hookControls, feature: runtime.adapter.featureControls, memory: runtime.adapter.memoryControls }[kind];
      if (!service) throw new Error(`This worker does not support native ${label}; update its Codex CLI`);
      const other = [["plugins", runtime.adapter.plugins], ["hooks", runtime.adapter.hookControls], ["experimental", runtime.adapter.featureControls], ["memories", runtime.adapter.memoryControls], ["import", runtime.adapter.importControls]].find(([, candidate]) => candidate !== service && candidate?.needsRefresh);
      if (mutation && other) throw Object.assign(new Error(`Refresh /${other[0]} to reconcile the previous change first`), { statusCode: 409 });
      clearTimeout(runtime.idleTimer); runtime.idleTimer = null;
      const result = mutation ? await service.change(input, check) : await service.list(check);
      check();
      if (result.threadId !== this.store.get(chatId)?.agentSessionId) throw Object.assign(new Error(`The native session changed; reopen the ${kind} browser`), { statusCode: 409 });
      return result;
    } finally {
      this.commands?.invalidate(chatId);
      this.#switching.delete(chatId); await this.refreshActivity(chatId); void this.#drainQueue(chatId);
    }
  }

  async #prepareSide(chatId, text, attachmentIds, first) {
    this.#assertNativeAccount(chatId);
    const chat = this.store.get(chatId), runtime = this.#runtimes.get(chatId);
    if (!chat || !runtime || chat.archived) throw new Error("The side chat's worker is not available");
    const files = this.attachments ? await this.attachments.resolve(chatId, attachmentIds) : [];
    const settings = this.models ? await this.models.turnSettings(chat) : {};
    const materialized = files.length ? await this.attachments.materialize(chat, runtime.executor, files) : [];
    this.#assertNativeAccount(chatId, runtime);
    const workspace = runtime.executor?.workspace || chat.workspace;
    const attached = attachmentPrompt(materialized, workspace);
    const prompt = first ? handoffPrompt({ ...chat, messages: [...chat.messages, {}] }, text + attached) : text + attached;
    return { prompt, settings: { ...settings, ...(chat.agent === "claude" ? { ultracode: false } : {}), ...contextForTurn(files, workspace), appReferences: appReferencesForTurn(chat, files, companyForChat(chat)), mode: chat.mode || "accept_edits", images: materialized.filter(file => /^image\/(png|jpeg|webp|gif)$/.test(file.mime)).map(file => file.path) } };
  }

  async servicesFor(chat) { return this.resources ? this.resources.forOwner(chat?.ownerId) : { environments: this.environments, github: this.github, mcps: this.mcps }; }
  revokeChatMcps(chatId) { if (this.resources) this.resources.revokeChat(chatId); else this.mcps?.revokeChat(chatId); }
  availableAgents(ownerId = null) {
    const ownsServerCredentials = !this.resources || this.resources.isLegacy(ownerId);
    return [
      {
        id: "codex",
        label: "Codex",
        enabled: this.config.google?.enabled ? Boolean(this.agentAccounts?.hasConnected(ownerId, "codex")) : ownsServerCredentials && (this.config.codex.authMode === "host" || Boolean(this.config.codex.providerKey)),
        authMode: this.config.google?.enabled ? "account" : this.config.codex.authMode,
      },
      {
        id: "claude",
        label: "Claude Code",
        enabled: this.config.google?.enabled ? Boolean(this.agentAccounts?.hasConnected(ownerId, "claude")) : ownsServerCredentials && (this.config.claude.authMode === "host" || Boolean(this.config.claude.providerKey)),
        authMode: this.config.google?.enabled ? "account" : this.config.claude.authMode,
      },
      ...(this.config.enableMock ? [{ id: "mock", label: "Mock agent", enabled: true, authMode: "none" }] : []),
    ];
  }

  isBusy(chatId) { const runtime = this.#runtimes.get(chatId); return this.#modeChanges.has(chatId) || this.#workerWakes.has(chatId) || this.#sendingNow.has(chatId) || this.#switching.has(chatId) || this.#queued.has(chatId) || Boolean(runtime?.failing || runtime?.busy || runtime?.adapter.isBackgroundBusy?.()) || this.#importPending(chatId); }
  publishChat(chat) { if (chat) this.#emit(chat.id, { type: "chat_updated", chat }); }

  // Admit quickly: a cold EC2 start can outlast the public HTTP timeout. This
  // operation acquires infrastructure only, never an adapter, turn or queue.
  async wake(chatId, guard = () => {}) {
    guard();
    const chat = this.store.get(chatId);
    if (!chat) throw Object.assign(new Error("Chat not found"), { statusCode: 404 });
    if (chat.archived || chat.workflowState === "archived") throw Object.assign(new Error("Unarchive this chat before waking its environment"), { statusCode: 409 });
    const version = this.#lifecycleVersions.get(chatId) || 0;
    if (this.#previewStops.has(chatId) || chat.status === "stopping") throw Object.assign(new Error("Wait for this environment to finish stopping"), { statusCode: 409 });
    const previous = this.#workerWakes.get(chatId);
    if (previous) {
      if (previous.version !== version) throw Object.assign(new Error("The previous wake is being cancelled; try again when stopping finishes"), { statusCode: 409 });
      return previous.admission;
    }
    if (this.#runtimes.has(chatId) || this.#awakeWorkers.has(chatId)) return { chat, completion: Promise.resolve(), accepted: false };
    if (this.isBusy(chatId)) throw Object.assign(new Error("Wait for the current chat operation to finish"), { statusCode: 409 });
    const operation = { version };
    const check = () => {
      guard();
      const current = this.store.get(chatId);
      if (!current || current.archived || (this.#lifecycleVersions.get(chatId) || 0) !== version) throw Object.assign(new Error("Environment wake cancelled"), { name: "AbortError", statusCode: 409 });
    };
    this.#workerWakes.set(chatId, operation);
    operation.admission = (async () => {
      const starting = await this.store.update(chatId, current => {
        check();
        return { ...runtimeWorkflowPatch(current, "starting"), status: "starting", statusDetail: "Waking environment · no message is sent to the agent", idleDeadlineAt: null, idleKeepAwakeReason: null };
      });
      this.publishChat(starting);
      operation.completion = (async () => {
        try {
          check(); await this.browserExecutor(chatId); check();
          this.#awakeWorkers.add(chatId);
        } catch (error) {
          if (error.name !== "AbortError" && (this.#lifecycleVersions.get(chatId) || 0) === version && this.store.get(chatId)) {
            // A failed acquisition may have started a VM. Release that exact
            // chat's lease before allowing a retry, without changing its queue.
            // browserExecutor has drained parallel startup and released its VM.
            if ((this.#lifecycleVersions.get(chatId) || 0) === version) await this.#setStatus(chatId, "error", `Could not wake environment: ${errorMessage(error)}`, null);
          }
          throw error;
        } finally {
          if (this.#workerWakes.get(chatId) === operation) this.#workerWakes.delete(chatId);
        }
        check(); await this.#scheduleWorkerIdle(chatId);
      })();
      operation.completion.catch(() => {}); // Failure is visible in chat status.
      return { chat: starting, completion: operation.completion, accepted: true };
    })().catch(error => { if (this.#workerWakes.get(chatId) === operation) this.#workerWakes.delete(chatId); throw error; });
    return operation.admission;
  }

  async #scheduleWorkerIdle(chatId) {
    clearTimeout(this.#workerIdleTimers.get(chatId)); this.#workerIdleTimers.delete(chatId);
    if (!this.#awakeWorkers.has(chatId) || this.#runtimes.has(chatId) || this.isBusy(chatId)) return;
    const version = this.#lifecycleVersions.get(chatId) || 0;
    const reason = this.browsers?.hasViewers(chatId) ? "browser" : this.previewActivity.has(chatId) ? "preview" : this.workspacePresence.has(chatId) ? "workspace" : this.presence.has(chatId) ? "tab" : null;
    const deadline = reason ? null : new Date(Date.now() + this.config.idleTimeoutMs).toISOString();
    const updated = await this.store.update(chatId, current => {
      if (!this.#awakeWorkers.has(chatId) || this.#runtimes.has(chatId) || this.isBusy(chatId) || (this.#lifecycleVersions.get(chatId) || 0) !== version) return {};
      return { ...runtimeWorkflowPatch(current, "idle"), status: "idle", statusDetail: "Environment ready · no message sent to the agent", idleDeadlineAt: deadline, idleKeepAwakeReason: reason };
    });
    if (!this.#awakeWorkers.has(chatId) || this.#runtimes.has(chatId) || (this.#lifecycleVersions.get(chatId) || 0) !== version) return;
    this.publishChat(updated);
    if (!reason) {
      const timer = setTimeout(() => {
        this.#workerIdleTimers.delete(chatId);
        if (!this.#awakeWorkers.has(chatId) || this.#runtimes.has(chatId) || this.isBusy(chatId)) return;
        if (this.browsers?.hasViewers(chatId) || this.previewActivity.has(chatId) || this.workspacePresence.has(chatId) || this.presence.has(chatId)) { void this.#scheduleWorkerIdle(chatId).catch(() => {}); return; }
        void this.stop(chatId, "idle-timeout").catch(() => {});
      }, this.config.idleTimeoutMs);
      timer.unref?.(); this.#workerIdleTimers.set(chatId, timer);
    }
  }

  // A viewer may wake the worker without starting an LLM turn. Share this lease
  // with agent startup so opening Chrome cannot create a second EC2 instance.
  async #startupStage(chatId, id, status, version) {
    const check = () => { if (!this.store.get(chatId) || this.store.get(chatId).archived || (this.#lifecycleVersions.get(chatId) || 0) !== version) throw Object.assign(new Error("Worker startup cancelled"), { name: "AbortError" }); };
    check();
    await this.store.update(chatId, current => { check(); const startupProgress = startupStage(current.startupProgress, id, status); return { startupProgress,
      ...(current.status === "starting" ? { statusDetail: startupProgress.stages.filter(stage => stage.status === "running").map(stage => stage.label).join(" · ") || "Finalizing startup" } : {}) }; });
    check(); this.publishChat(this.store.get(chatId));
  }

  async #startupTask(chatId, id, version, action) {
    await this.#startupStage(chatId, id, "running", version);
    try { const result = await action(); await this.#startupStage(chatId, id, "completed", version); return result; }
    catch (error) { await this.#startupStage(chatId, id, "failed", version).catch(() => {}); throw error; }
  }

  async browserExecutor(chatId) {
    const runtime = this.#runtimes.get(chatId);
    if (runtime?.failing || runtime?.cleanupFailed) throw Object.assign(new Error("Worker cleanup is incomplete. Retry stopping the environment before resuming."), { statusCode: 409 });
    const chat = this.store.get(chatId);
    if (!chat) throw Object.assign(new Error("Chat not found"), { statusCode: 404 });
    if (chat.archived || this.#previewStops.has(chatId)) throw Object.assign(new Error("This environment is archived or stopping"), { statusCode: 409 });
    if (this.#executors.has(chatId)) return this.#executors.get(chatId);
    if (this.config.idlePolicy === "hibernate" && !hibernationAdmission().available) {
      await this.#suspensionUnavailable(chatId, { admission: true });
      throw hibernationUnavailableError();
    }
    const version = this.#lifecycleVersions.get(chatId) || 0;
    const controller = new AbortController();
    let acquisitionStarted = false, acquisitionMutation;
    this.#startupControllers.set(chatId, controller);
    const check = () => { controller.signal.throwIfAborted(); if (!this.store.get(chatId) || this.store.get(chatId).archived || (this.#lifecycleVersions.get(chatId) || 0) !== version) throw Object.assign(new Error("Worker startup cancelled"), { name: "AbortError" }); };
    const pending = (async () => {
      if (chat.environmentId) await (await this.servicesFor(chat)).environments.runtime(chat.environmentId, chat);
      check();
      await this.store.update(chatId, current => { check(); return { startupProgress: { startedAt: nowIso(), stages: [] } }; });
      check();
      this.publishChat(this.store.get(chatId));
      let failure;
      const protect = promise => promise.catch(error => { failure ||= error; controller.abort(error); throw error; });
      const repositories = protect((async () => {
        if (chat.repositories?.length && !chat.workspaceReady) await this.#startupTask(chatId, "repository", version, async () => {
          await prepareRepositories({ destination: chat.workspace, repositories: chat.repositories,
            getToken: async repository => { check(); const services = await this.servicesFor(chat); check(); return services.github.tokenForRepository(repository, chat); },
            signal: controller.signal, onProgress: () => { check(); } });
          check(); await this.store.update(chatId, current => { check(); return { workspaceReady: true }; });
        });
        check();
      })());
      // Only EC2 understands the upload barrier. Local/custom backends retain
      // their original contract: acquire sees a fully prepared workspace.
      const acquisition = protect((async () => {
        if (this.config.workerBackend !== "ec2") { await repositories; check(); }
        check(); acquisitionStarted = true;
        return this.workerBackend.acquire(this.store.get(chatId), { workspaceReady: repositories, check,
          onMutation: receipt => { acquisitionMutation = receipt; },
          onStage: (id, status) => this.#startupStage(chatId, id, status, version) });
      })());
      const [repoResult, workerResult] = await Promise.allSettled([repositories, acquisition]);
      if (repoResult.status === "rejected" || workerResult.status === "rejected") {
        // Wait for both branches before cleanup: a late AWS launch cannot race
        // behind sleep/delete. This exact pending lease owns failure cleanup;
        // Stop observes workerReleased to avoid stopping it a second time.
        throw failure;
      }
      const executor = workerResult.value;
      check();
      if (executor?.metadata) await this.store.update(chatId, current => { check(); return { runtimeMetadata: executor.metadata }; });
      check();
      await this.store.update(chatId, current => { check(); return { startupProgress: { ...current.startupProgress, finishedAt: nowIso() } }; });
      check(); this.publishChat(this.store.get(chatId));
      return executor;
    })().catch(async error => {
      if (acquisitionStarted && this.#executors.get(chatId) === pending) {
        try {
          if (acquisitionMutation) { await acquisitionMutation.release(); pending.workerReleased = true; }
          else if (this.config.workerBackend !== "ec2") { await this.workerBackend.sleep(chat); pending.workerReleased = true; }
        }
        catch { pending.cleanupFailed = true; throw new Error("Worker startup failed and its machine could not be stopped. Use Stop to retry cleanup before waking it again."); }
      }
      if ((this.#lifecycleVersions.get(chatId) || 0) === version && this.store.get(chatId)) {
        await this.store.update(chatId, current => ({ startupProgress: failRunningStartup(current.startupProgress) }));
        if ((this.#lifecycleVersions.get(chatId) || 0) === version) this.publishChat(this.store.get(chatId));
      }
      throw error;
    });
    this.#executors.set(chatId, pending);
    try { return await pending; } catch (error) { if (this.#executors.get(chatId) === pending && !pending.cleanupFailed) this.#executors.delete(chatId); throw error; }
    finally { if (this.#startupControllers.get(chatId) === controller) this.#startupControllers.delete(chatId); }
  }

  previewGeneration(chatId) { return this.store.get(chatId) && !this.store.get(chatId).archived && !this.#previewStops.has(chatId) && !this.#previewBlocked.has(chatId) ? this.#lifecycleVersions.get(chatId) || 0 : null; }

  async browserIdle(chatId) {
    if (this.#awakeWorkers.has(chatId)) return this.#scheduleWorkerIdle(chatId);
    // A browser-only wake must release its EC2 lease too. Otherwise the cloud
    // watchdog can stop the VM behind a cached executor, breaking the next open.
    if (!this.#runtimes.has(chatId) && !this.isBusy(chatId) && !this.workspacePresence.has(chatId) && !this.previewActivity.has(chatId) && !this.browsers?.entries.has(chatId) && this.store.get(chatId)) await this.stop(chatId, "idle-timeout");
  }

  async workspaceFiles(chatId, action, input = {}) {
    const chat = this.store.get(chatId);
    if (!chat) throw Object.assign(new Error("Chat not found"), { statusCode: 404 });
    if (action === "status") return { connected: this.#executors.has(chatId), remote: this.config.workerBackend === "ec2" };
    if (chat.archived) throw new Error("Unarchive this chat before connecting to its workspace");
    if (action === "presence") {
      if (input.active && !this.#executors.has(chatId)) throw Object.assign(new Error("Workspace is disconnected"), { statusCode: 409 });
      await this.workspacePresence.set(chatId, input.clientId, input.active);
      if (input.active) { const executor = await this.#executors.get(chatId); if (executor?.metadata?.backend === "ec2") await readWorkspaceFiles(chat, executor, { action: "ping" }); }
      return { connected: this.#executors.has(chatId) };
    }
    if (!["connect", "list", "read", "attach"].includes(action)) throw new Error("Unknown workspace action");
    const version = this.#lifecycleVersions.get(chatId) || 0;
    if (action === "connect") {
      // Acquire only the workspace, never start an LLM session. The viewer lease
      // expires after crashes and cannot resurrect a manually stopped worker.
      await this.workspacePresence.set(chatId, input.clientId, true);
      try {
        await this.browserExecutor(chatId);
        if (version !== (this.#lifecycleVersions.get(chatId) || 0)) throw Object.assign(new Error("Workspace connection cancelled because the worker stopped"), { statusCode: 409 });
        if (!this.#runtimes.has(chatId) && this.store.get(chatId)?.status === "starting") await this.#setStatus(chatId, "stopped", "Workspace connected; agent not started", null);
        return { connected: true };
      }
      catch (error) { await this.workspacePresence.set(chatId, input.clientId, false); throw error; }
    }
    if (!this.#executors.has(chatId)) throw Object.assign(new Error("Connect to this chat's workspace first"), { statusCode: 409 });
    const executor = await this.#executors.get(chatId);
    const file = await readWorkspaceFiles(chat, executor, { action: action === "list" ? "list" : "read", path: input.path ?? "", query: input.query ?? "" });
    if (version !== (this.#lifecycleVersions.get(chatId) || 0) || !this.store.get(chatId)) throw Object.assign(new Error("Workspace action cancelled because the chat stopped"), { statusCode: 409 });
    if (action === "attach") {
      if (typeof input.version !== "string" || input.version !== (file.version || file.sha256)) throw Object.assign(new Error("The workspace file changed; reopen it before selecting context"), { statusCode: 409 });
      return { attachment: await this.attachments.uploadWorkspace(chatId, workspaceContext(file, input.selection)) };
    }
    const { data, ...visible } = file; return visible;
  }

  async setPresence(chatId, { clientId, active }) {
    const chat = this.store.get(chatId);
    if (!chat) throw Object.assign(new Error("Chat not found"), { statusCode: 404 });
    await this.presence.set(chatId, clientId, chat.archived ? false : active);
    if (active && this.#awakeWorkers.has(chatId)) {
      const executor = await this.#executors.get(chatId);
      if (executor?.metadata?.backend === "ec2") await readWorkspaceFiles(chat, executor, { action: "ping" });
    }
    return { active: this.presence.has(chatId), expiresInMs: this.presence.ttlMs };
  }

  async refreshActivity(chatId) {
    const runtime = this.#runtimes.get(chatId);
    if (runtime && !runtime.busy && this.store.get(chatId)?.status === "idle") await this.#scheduleIdleStop(chatId, runtime);
    if (!runtime && this.#awakeWorkers.has(chatId)) await this.#scheduleWorkerIdle(chatId);
    this.browsers?.touch(chatId);
  }

  async makePrivate(chatId, ownerId) {
    const chat = this.store.get(chatId);
    if (!chat || chat.ownerId && chat.ownerId !== ownerId) throw Object.assign(new Error("Chat not found"), { statusCode: 404 });
    if (chat.ownerId === ownerId) return chat;
    if (this.isBusy(chatId) || ["starting", "stopping"].includes(chat.status)) throw Object.assign(new Error("Stop the agent before making this chat private"), { statusCode: 409 });
    this.#switching.add(chatId);
    try {
      await this.stop(chatId, "private-browser");
      const updated = await this.store.update(chatId, { ownerId, queuePaused: true });
      this.publishChat(updated); return updated;
    } finally { this.#switching.delete(chatId); }
  }

  async switchAgent(chatId, agent, input = {}) {
    const chat = this.store.get(chatId);
    if (!chat) throw Object.assign(new Error("Chat not found"), { statusCode: 404 });
    if (!this.availableAgents(chat.ownerId).some(item => item.id === agent && item.enabled)) throw new Error("Choose an enabled agent for this user");
    if (this.isBusy(chatId) || chat.status === "stopping") throw Object.assign(new Error("Stop the working agent before switching"), { statusCode: 409 });
    const agentAccountId = ["codex", "claude"].includes(agent) ? input.agentAccountId ?? (agent === chat.agent ? chat.agentAccountId : null) : null;
    if (agentAccountId || this.config.google?.enabled && ["codex", "claude"].includes(agent)) {
      if (!agentAccountId) throw new Error(`Choose a ${agent === "claude" ? "Claude" : "Codex"} account for this chat in Agent accounts`);
      await this.agentAccounts.select(chat.ownerId, agentAccountId, { ...chat, agent });
      await this.agentAccounts.rememberProject(chat.ownerId, { ...chat, agent, agentAccountId });
    }
    if (agent === chat.agent && agentAccountId === (chat.agentAccountId || null)) return chat;
    this.#switching.add(chatId);
    try {
      const settings = this.models ? await this.models.creationSettings(agent, { ownerId: chat.ownerId, agentAccountId }) : { model: this.config[agent]?.model || null, effort: this.config[agent]?.effort || null };
      await this.stop(chatId, "agent-switch");
      const updated = await this.store.update(chatId, current => ({ agent, agentAccountId, ...settings, modelSelectionSet: true,
        ...(agent !== "claude" && ["default", "dont_ask"].includes(current.mode) ? { mode: "plan" } : {}),
        agentSessionId: null, needsAgentHandoff: true, pendingRequest: null, awaitingUser: false, claudeFastMode: false, claudeFastStatus: null, ultracode: false,
        nativeForkSessionId: null, forkGoalPending: false, forkContextPending: false, goal: null,
        usage: null, usageAccount: null, rateLimits: null, sessionDetails: null, taskProgress: null, connectors: null, slashCommands: [], commandCatalog: [],
        messages: current.messages.map(message => ["assistant", "tool"].includes(message.role) ? { ...message, agent: message.agent || current.agent } : message),
        statusDetail: `Switched to ${agent === "claude" ? "Claude Code" : agent === "codex" ? "Codex" : "Mock"}. Conversation and workspace retained.`,
        ...workflowPatch({ ...current, awaitingUser: false, pendingRequest: null }),
      }));
      this.publishChat(updated);
      return updated;
    } finally { this.#switching.delete(chatId); }
  }

  async setModel(chatId, input, guard = () => {}) {
    guard();
    if (this.#switching.has(chatId)) throw Object.assign(new Error("Wait for the agent switch to finish"), { statusCode: 409 });
    const chat = this.store.get(chatId);
    if (!chat) throw Object.assign(new Error("Chat not found"), { statusCode: 404 });
    const selectionVersion = this.#lifecycleVersions.get(chatId) || 0;
    const settings = await this.models.validate(chat.agent, input, chat);
    const check = selected => {
      guard();
      if (this.#switching.has(chatId) || !selected || runtimeAccountBinding(selected) !== runtimeAccountBinding(chat)
        || selected.modelSettingsRevision !== chat.modelSettingsRevision || (this.#lifecycleVersions.get(chatId) || 0) !== selectionVersion) throw Object.assign(new Error("The agent or settings changed; select its model again"), { statusCode: 409 });
    };
    check(this.store.get(chatId));
    const updated = await this.store.update(chatId, current => {
      check(current);
      return { ...settings, modelSelectionSet: true, modelSettingsRevision: (current.modelSettingsRevision || 0) + 1 };
    });
    this.publishChat(updated); return updated;
  }

  async setMode(chatId, mode, { nextTurn = false } = {}) {
    if (this.#switching.has(chatId)) throw Object.assign(new Error("Wait for the agent switch to finish"), { statusCode: 409 });
    const chat = this.store.get(chatId);
    if (!chat) throw Object.assign(new Error("Chat not found"), { statusCode: 404 });
    const allowed = chat.agent === "claude" ? Object.values(CLAUDE_PERMISSION_MODES) : ["auto", "accept_edits", "plan"];
    if (!allowed.includes(mode)) throw new Error("Choose a permission mode supported by this agent");
    if (this.#modeChanges.has(chatId)) throw Object.assign(Error("Wait for the current permission change to finish"), { statusCode: 409 });
    const runtime = this.#runtimes.get(chatId), generation = runtime?.generation;
    if (chat.agent === "claude" && !runtime && this.#queued.has(chatId) && !nextTurn) throw Object.assign(Error("Claude is starting; retry the permission selection when ready."), { statusCode: 409 });
    const version = this.#lifecycleVersions.get(chatId) || 0;
    const check = () => {
      if ((this.#lifecycleVersions.get(chatId) || 0) !== version || this.#runtimes.get(chatId) !== runtime
        || runtime?.generation !== generation || this.#switching.has(chatId) || this.#interruptions.has(chatId)
        || runtimeAccountBinding(this.store.get(chatId) || {}) !== runtimeAccountBinding(chat)) {
        throw Object.assign(Error("The chat changed during the permission update; select the mode again."), { statusCode: 409 });
      }
      if (runtime && chat.agent === "claude") this.#assertNativeAccount(chatId, runtime);
    };
    const pending = { acknowledged: false, latest: null };
    this.#modeChanges.set(chatId, pending);
    try {
      check();
      let applied = false;
      if (chat.agent === "claude" && runtime?.adapter.setPermissionMode) {
        applied = await runtime.adapter.setPermissionMode(mode, check, () => {
          check(); pending.acknowledged = true;
          runtime.permissionEpoch = (runtime.permissionEpoch || 0) + 1;
        });
        if (!applied && runtime.busy && !nextTurn) throw Object.assign(Error("Claude is starting; retry the permission selection when ready."), { statusCode: 409 });
      }
      let updated;
      do {
        updated = await this.store.update(chatId, current => {
          check(); return { mode: pending.latest || mode, modeSettingsRevision: (current.modeSettingsRevision || 0) + 1 };
        });
        check();
      } while (pending.latest && updated.mode !== pending.latest);
      if (applied && runtime.modeState) Object.assign(runtime.modeState, { mode: updated.mode, revision: updated.modeSettingsRevision, conflict: false });
      this.publishChat(updated); return updated;
    } finally { this.#modeChanges.delete(chatId); void this.#drainQueue(chatId); }
  }

  #checkClaudeConfiguration(chat, text, attachments) {
    if (chat.agent !== "claude") return;
    const privateProfile = Boolean(chat.agentAccountId) || this.config.claude.authMode === "gateway";
    if (claudeDebugRequest(text) && !privateProfile) throw Error(CLAUDE_DEBUG_PRIVATE_ERROR);
    if (claudePluginReloadRequest(text)) {
      if (attachments.length) throw Error("/reload-plugins does not accept attachments. Remove them or send them in a separate message.");
      if (!privateProfile) throw Error(CLAUDE_PLUGIN_PRIVATE_ERROR);
    }
    const mcp = claudeMcpRequest(text);
    if (mcp) {
      if (attachments.length) throw new Error("/mcp does not accept attachments. Remove them or send them in a separate message.");
      if (mcp.action && !privateProfile) throw new Error(CLAUDE_MCP_PRIVATE_ERROR);
    }
    if (claudeFastRequest(text)) {
      if (attachments.length) throw new Error("/fast does not accept attachments. Remove them or send them in a separate message.");
      if (!privateProfile) throw new Error("Fast changes require a private Claude profile; shared host profiles remain locked until company/profile isolation is complete.");
    }
    const request = claudeConfigRequest(text);
    if (/^\/effort\s+status$/.test(text.trim()) && attachments.length) throw new Error("/effort status does not accept attachments. Remove them or send them in a separate message.");
    if (!request) return;
    if (attachments.length && request.kind !== "prompt") throw new Error(`${/^\/autocompact(?:\s|$)/.test(text) ? "/autocompact does" : "/config and /settings do"} not accept attachments. Remove them or send them in a separate message.`);
    if (request.mutate && !privateProfile) throw new Error("Native settings changes require a private Claude profile. This worker uses a shared host profile; shared settings writes are locked until company/profile isolation is complete.");
  }

  async #syncClaudeConfiguration(chatId, native, original, guard) {
    if (!native || !Object.keys(native).length) return;
    const catalog = Object.hasOwn(native, "model") && this.models ? await this.models.list("claude") : null;
    guard();
    const scope = chat => JSON.stringify([chat.agent, chat.ownerId, chat.environmentId, chat.workspace, companyForChat(chat)]);
    const conflicts = [];
    const updated = await this.store.update(chatId, current => {
      guard();
      if (scope(current) !== scope(original)) throw new Error("The chat's profile changed while the native command was running. Recheck its settings before continuing.");
      const patch = {};
      if (Object.hasOwn(native, "model")) {
        if (current.model === original.model && current.effort === original.effort && current.modelSettingsRevision === original.modelSettingsRevision) {
          const selected = catalog?.models.find(item => item.id === native.model);
          patch.model = native.model; patch.modelSelectionSet = true; patch.ultracode = false;
          patch.modelSettingsRevision = (current.modelSettingsRevision || 0) + 1;
          patch.effort = current.effort === "auto" || selected?.efforts.includes(current.effort) ? current.effort : "auto";
        } else conflicts.push("model/effort");
      }
      if (Object.hasOwn(native, "mode")) {
        if (current.mode === original.mode && current.modeSettingsRevision === original.modeSettingsRevision) {
          patch.mode = native.mode; patch.modeSettingsRevision = (current.modeSettingsRevision || 0) + 1;
        }
        else conflicts.push("permission mode");
      }
      return patch;
    });
    guard(); this.publishChat(updated);
    if (conflicts.length) {
      const message = await this.store.appendMessage(chatId, { role: "system", kind: "notice", text: `The native command saved its profile settings, but newer web choices for ${conflicts.join(" and ")} were kept for subsequent turns.` });
      this.#emit(chatId, { type: "message", message });
    }
    return Object.hasOwn(native, "mode") && !conflicts.includes("permission mode") ? updated : null;
  }

  async #syncClaudePermissionMode(chatId, mode, state, active) {
    if (!Object.values(CLAUDE_PERMISSION_MODES).includes(mode) || !active()) return;
    const scope = chat => JSON.stringify([chat.agent, chat.ownerId, chat.environmentId, chat.workspace, companyForChat(chat)]);
    const current = this.store.get(chatId);
    if (!current || scope(current) !== scope(state.original) || current.mode === mode) return;
    let changed = false, conflict = false;
    const updated = await this.store.update(chatId, current => {
      if (!active() || scope(current) !== scope(state.original)) return {};
      if (current.mode !== state.mode || current.modeSettingsRevision !== state.revision) { conflict = true; return {}; }
      if (current.mode === mode) return {};
      changed = true;
      return { mode, modeSettingsRevision: (current.modeSettingsRevision || 0) + 1 };
    });
    if (changed && active()) {
      state.mode = updated.mode; state.revision = updated.modeSettingsRevision;
    }
    const latest = this.store.get(chatId);
    if (!active() || !latest || scope(latest) !== scope(state.original)) return;
    if (changed) this.publishChat(updated);
    if (conflict && !state.conflict && active()) {
      state.conflict = true;
      const message = await this.store.appendMessage(chatId, { role: "system", kind: "notice", text: "Claude changed its current permission mode, but your newer web selection was kept for the next turn." });
      this.#emit(chatId, { type: "message", message });
    }
  }

  async #retainClaudeFastConstraint(chatId, value, original) {
    // A provider rejection observed before Stop is still true after Stop.
    // Unlike a positive command acknowledgement, a newer model choice must not
    // erase it. Never transfer it to a changed account/profile or re-enable Fast.
    if (!["disabled", "cooldown"].includes(value.type)) return;
    if (value.type === "disabled" && !["preference", "extra_usage_disabled"].includes(value.reason)) return;
    if (value.type === "cooldown" && (!Number.isSafeInteger(value.until) || !["rate_limit", "overloaded"].includes(value.reason))) return;
    const updated = await this.store.update(chatId, current => {
      if (claudeFastScope(current) !== claudeFastScope(original) || !current.claudeFastMode || current.claudeFastCredential !== value.credential || claudeFastCredential(this.config.claude) !== value.credential) return {};
      const disabled = value.type === "disabled";
      const patch = disabled
        ? { claudeFastMode: false, claudeFastCredential: null, claudeFastCooldown: null, modelSettingsRevision: (current.modelSettingsRevision || 0) + 1 }
        : { claudeFastCooldown: { until: Math.max(current.claudeFastCooldown?.until || 0, value.until), reason: value.reason } };
      patch.claudeFastStatus = { state: disabled ? "off" : "cooldown", ...(disabled ? { disabledReason: value.reason } : {}), checkedAt: new Date().toISOString(),
        ...(current.modelSettingsRevision === original.modelSettingsRevision ? { selectionRevision: patch.modelSettingsRevision ?? current.modelSettingsRevision ?? 0 } : {}) };
      return patch;
    });
    if (updated) this.publishChat(updated);
  }

  async #syncClaudeFast(chatId, result, original, guard) {
    // Already queued at receipt, including the interrupted-turn path. Do not
    // overwrite a saved rejection with the CLI's stale "on" result afterward.
    if (!result.nativeFast || result.fastConstraintObserved) return;
    guard();
    let conflict = false;
    const updated = await this.store.update(chatId, current => {
      guard();
      if (claudeFastScope(current) !== claudeFastScope(original)) throw new Error("The chat's profile changed while Fast was being checked. Retry in the current profile.");
      if (current.modelSettingsRevision !== original.modelSettingsRevision || current.claudeFastMode !== original.claudeFastMode) { conflict = true; return {}; }
      const patch = { claudeFastStatus: { ...result.nativeFast, checkedAt: new Date().toISOString() } };
      if (Object.hasOwn(result, "fastCooldown")) patch.claudeFastCooldown = result.fastCooldown;
      if (typeof result.fastPreference === "boolean") {
        patch.claudeFastMode = result.fastPreference;
        patch.claudeFastScope = claudeFastScope(current);
        patch.claudeFastCredential = result.fastPreference ? result.fastCredential : null;
        patch.modelSettingsRevision = (current.modelSettingsRevision || 0) + 1;
        // Native /fast on promotes unsupported aliases to Opus. Keep that
        // choice on the next print-mode process, without lowering effort.
        if (result.fastPreference && /^opus(?:\[1m\])?$/.test(result.fastModel || "")) { patch.model = result.fastModel; patch.modelSelectionSet = true; if (patch.model !== current.model) patch.ultracode = false; }
      }
      patch.claudeFastStatus.selectionRevision = patch.modelSettingsRevision ?? current.modelSettingsRevision ?? 0;
      return patch;
    });
    guard(); this.publishChat(updated);
    if (conflict && typeof result.fastPreference === "boolean") {
      const message = await this.store.appendMessage(chatId, { role: "system", kind: "notice", text: "Newer model/Fast choices were kept; the completed Fast command did not replace them for subsequent turns." });
      this.#emit(chatId, { type: "message", message });
    }
  }

  async addRepository(chatId, selection) {
    const chat = this.store.get(chatId);
    if (!chat) throw Object.assign(new Error("Chat not found"), { statusCode: 404 });
    if (this.isBusy(chatId) || chat.status === "stopping") throw Object.assign(new Error("Stop the working agent before adding a repository"), { statusCode: 409 });
    if (chat.source) throw new Error("Adding repositories is supported for picker-based or scratch chats, not legacy single-repository clones");
    if ((chat.repositories?.length || 0) >= 100) throw new Error("A chat supports up to 100 repositories");
    this.#switching.add(chatId);
    try {
      const [repository] = await (await this.servicesFor(chat)).github.resolveSelections([selection], { company: companyForChat(chat) || undefined });
      if (chat.repositories?.some(repo => repo.fullName.toLowerCase() === repository.fullName.toLowerCase())) throw new Error("This repository is already in the chat");
      if (chat.agentAccountId) await this.agentAccounts.select(chat.ownerId, chat.agentAccountId, { ...chat, repositories: [...(chat.repositories || []), repository] });
      if (chat.environmentId) await (await this.servicesFor(chat)).environments.runtime(chat.environmentId, { ...chat, repositories: [...(chat.repositories || []), repository] });
      await this.stop(chatId, "repository-added");
      const updated = await this.store.update(chatId, current => ({ repositories: [...(current.repositories || []), repository], workspaceReady: false,
        statusDetail: "Repository added. It will be cloned when you next send a message." }));
      this.publishChat(updated); return updated;
    } finally { this.#switching.delete(chatId); }
  }

  async sessionInfo(chatId) {
    let chat = this.store.get(chatId);
    if (!chat) throw Object.assign(new Error("Chat not found"), { statusCode: 404 });
    const runtime = this.#runtimes.get(chatId);
    const accountEpoch = runtime?.adapter.accountEpoch;
    const identity = `${chat.agent}:${chat.agentSessionId}`;
    let live = runtime?.adapter.inspect ? await runtime.adapter.inspect() : {};
    let legacy = await legacyClaudeContext(chat, this.config);
    // Usage can arrive during inspection: do not return its earlier snapshot.
    await runtime?.eventQueue;
    chat = this.store.get(chatId);
    if (!chat) throw Object.assign(new Error("Chat not found"), { statusCode: 404 });
    if (`${chat.agent}:${chat.agentSessionId}` !== identity) { live = {}; legacy = null; }
    if (runtime?.adapter.accountEpoch !== accountEpoch) { live = { ...live, account: null, rateLimits: null }; }
    if (chat.usage?.version === 2) legacy = null;
    // Persist recovered transcript counters and inspection-only fields in the
    // controller DB, not the disposable worker or the browser's memory cache.
    const different = (value, saved) => value != null && JSON.stringify(value) !== JSON.stringify(saved);
    if (legacy || different(live.rateLimits, chat.rateLimits) || different(live.connectors, chat.connectors) || different(live.account, chat.usageAccount)) {
      chat = await this.store.update(chatId, current => {
        if (`${current.agent}:${current.agentSessionId}` !== identity) return {};
        const accountCurrent = runtime?.adapter.accountEpoch === accountEpoch;
        return { ...(legacy && current.usage?.version !== 2 ? { usage: { ...current.usage, ...legacy, persistedSnapshot: true } } : {}),
          ...(accountCurrent && live.rateLimits ? { rateLimits: live.rateLimits } : {}), ...(live.connectors ? { connectors: live.connectors } : {}),
          ...(accountCurrent && live.account ? { usageAccount: live.account } : {}) };
      });
    }
    const awake = this.#runtimes.get(chatId) === runtime && Boolean(runtime);
    return { usage: chat.usage || null, rateLimits: chat.rateLimits || null, connectors: chat.connectors || null,
      agent: chat.agent, model: chat.model, authMode: chat.agentAccountId ? "account" : this.config[chat.agent]?.authMode || "none", account: chat.usageAccount || null, snapshot: !awake, recordedAt: chat.usage?.recordedAt || null,
      slashCommands: chat.slashCommands || [], canCompact: !chat.archived,
      note: awake ? "Provider-reported usage only. Missing context or subscription limits are unavailable from this CLI/auth mode." : "Worker stopped. Showing the last snapshot saved outside the worker; opening this panel does not wake it." };
  }

  async compact(chatId) {
    const chat = this.store.get(chatId);
    if (!chat) throw Object.assign(new Error("Chat not found"), { statusCode: 404 });
    if (this.isBusy(chatId) || chat.queuedMessages?.length) return this.enqueue(chatId, "/compact");
    const submitted = await this.submit(chatId, "/compact"); await submitted.completion;
    return this.store.get(chatId);
  }

  async inspectCommand(chatId, command, terminate = null) {
    if (!["ps", "debug-config"].includes(command)) throw new Error("Unknown native inspection command");
    if (terminate !== null && (command !== "ps" || typeof terminate !== "string" || !terminate || terminate.length > 256)) throw new Error("Choose a background terminal from this chat");
    const chat = this.store.get(chatId);
    if (!chat) throw Object.assign(new Error("Chat not found"), { statusCode: 404 });
    if (chat.agent !== "codex") throw new Error("This native inspection is for Codex");
    const runtime = this.#runtimes.get(chatId);
    if (!runtime) {
      if (terminate) throw Object.assign(new Error("The worker is stopped; no terminal was changed"), { statusCode: 409 });
      return { title: command === "ps" ? "Background terminals" : "Codex configuration", items: [], awake: false, note: "Worker stopped. This inspection does not start it or send a message to the agent." };
    }
    if (!runtime.adapter.inspectCommand) throw new Error("This worker does not expose native command inspection");
    if (terminate) await runtime.adapter.terminateBackground(terminate);
    const result = await runtime.adapter.inspectCommand(command);
    if (this.#runtimes.get(chatId) !== runtime) throw Object.assign(new Error("The worker changed during inspection; refresh this view"), { statusCode: 409 });
    return { ...result, awake: true };
  }

  async nativeApprovals(chatId, input = null, guard = () => {}) {
    guard();
    if (!input) return this.approvals.list(chatId);
    const version = this.#lifecycleVersions.get(chatId) || 0;
    const check = () => {
      guard();
      if (version !== (this.#lifecycleVersions.get(chatId) || 0) || this.#switching.has(chatId) || this.store.get(chatId)?.status === "stopping") throw Object.assign(new Error("The chat stopped or changed before the retry was queued"), { statusCode: 409 });
    };
    const result = await this.approvals.queue(chatId, input, async (item, scopeCheck) => {
      const chat = await this.store.update(chatId, current => {
        scopeCheck();
        if (current.archived) throw new Error("Unarchive this chat before retrying");
        if (current.queuedMessages?.some(entry => entry.id === item.id)) return {};
        if ((current.queuedMessages || []).length >= 20) throw new Error("Queue holds at most 20 messages");
        return { queuedMessages: [...(current.queuedMessages || []), item] };
      });
      this.publishChat(chat);
    }, check);
    check();
    const adapter = this.#runtimes.get(chatId)?.adapter;
    if (result.state === "queued" && adapter?.goal?.status === "active") await adapter.goalAction("pause");
    void this.#drainQueue(chatId);
    return { ...result, queuePaused: Boolean(this.store.get(chatId)?.queuePaused) };
  }

  async createChat(input = {}, ownerId = null) {
    const allowed = this.availableAgents(ownerId).filter((agent) => agent.enabled).map((agent) => agent.id);
    const agent = input.agent || allowed[0];
    if (!allowed.includes(agent)) throw new Error(`agent is not enabled: ${agent}`);
    const title = input.title ? clampText(input.title, 120, "title") : agent === "mock" ? "New mock conversation" : "New conversation";
    if (this.resources && !this.resources.isLegacy(ownerId) && input.source) throw new Error("Server-local workspace sources are private to the server owner");
    const source = typeof input.source === "string" ? input.source.trim() : this.resources && !this.resources.isLegacy(ownerId) ? "" : this.config.workspaceSource;
    if (input.repositories !== undefined && !Array.isArray(input.repositories)) throw new Error("Repositories must be a list");
    const workspaceIdentity = { ownerId, repositories: input.repositories || [], source: input.repositories?.length ? "" : source };
    const services = await this.servicesFor(workspaceIdentity);
    const agentAccountId = ["codex", "claude"].includes(agent) ? input.agentAccountId || null : null;
    if (agentAccountId || this.config.google?.enabled && ["codex", "claude"].includes(agent)) {
      if (!agentAccountId) throw new Error("Connect and select an agent account before creating a chat");
      await this.agentAccounts.select(ownerId, agentAccountId, { ...workspaceIdentity, agent });
    }
    // Resolve company from the owner's selected GitHub connection, never trust
    // company metadata supplied by the browser or infer it from a GitHub owner.
    const repositories = input.repositories?.length ? await services.github.resolveSelections(input.repositories) : [];
    workspaceIdentity.repositories = repositories;
    const environment = input.environmentId ? await services.environments?.runtime(input.environmentId, workspaceIdentity) : null;
    if (environment?.archived) throw new Error("Choose an environment that is not archived");
    if (environment && environment.backend !== this.config.workerBackend) throw new Error(`This server uses ${this.config.workerBackend} workers. Select an environment with that backend.`);
    const modelSettings = this.models ? await this.models.creationSettings(agent, { ...input, ownerId, agentAccountId }) : {};
    if (agentAccountId) await this.agentAccounts.rememberProject(ownerId, { agent, agentAccountId, repositories });
    const chat = await this.store.create({ title, agent, ownerId, agentAccountId, ...modelSettings, modelSelectionSet: Object.hasOwn(input, "model") || Object.hasOwn(input, "effort"), source: repositories.length ? "" : source, repositories,
      environmentId: environment?.id, environmentName: environment?.name, autoTitle: !input.title });
    try {
      if (repositories.length) {
        const updated = await this.store.update(chat.id, { statusDetail: "Repositories selected. They will be cloned when the agent starts." });
        this.publishChat(updated);
        return updated;
      }
      const prepared = await prepareWorkspace({ destination: chat.workspace, source });
      const updated = await this.store.update(chat.id, {
        source: prepared.source,
        workspaceReady: true,
        statusDetail: prepared.kind === "empty" ? "Empty workspace ready" : `Workspace cloned from ${prepared.source}`,
      });
      this.#emit(chat.id, { type: "chat_updated", chat: updated });
      return updated;
    } catch (error) {
      await this.store.remove(chat.id);
      throw error;
    }
  }

  async copyTranscript(chatId, input = {}, ownerId = null) {
    const source = this.store.get(chatId);
    if (!source) throw Object.assign(new Error("Chat not found"), { statusCode: 404 });
    const title = input.title ? clampText(input.title, 120, "title") : `Copy of ${source.title}`.slice(0, 120);
    // Copy the transcript only. Never reuse a runtime, workspace, credentials,
    // queued prompts, PR automation, or usage counters from the source chat.
    const copy = await this.store.create({ title, ownerId: source.ownerId || ownerId, agent: source.agent, model: source.model, effort: source.effort, modelSelectionSet: source.modelSelectionSet, autoTitle: false });
    try {
      await prepareWorkspace({ destination: copy.workspace, source: "" });
      const messages = source.messages.map(message => ({ ...message, id: newId("msg"),
        ...(["assistant", "tool"].includes(message.role) ? { agent: message.agent || source.agent } : {}),
        ...(message.attachments ? { attachments: message.attachments.map(file => ({ name: file.name, mimeType: file.mimeType, copied: true })) } : {}),
      }));
      const updated = await this.store.update(copy.id, { messages, copiedFromChatId: chatId, needsAgentHandoff: true, workspaceReady: true,
        statusDetail: "Transcript copy · workspace files and agent session are not copied" });
      this.publishChat(updated); return updated;
    } catch (error) { await this.store.remove(copy.id); throw error; }
  }

  forkChat(chatId, input = {}, ownerId = null) {
    const source = this.store.get(chatId);
    if (!source || source.ownerId && source.ownerId !== ownerId) throw Object.assign(new Error("Chat not found"), { statusCode: 404 });
    if (source.agent !== "codex") throw new Error("Persistent native forks currently require Codex");
    if (!this.store.records) throw new Error("Forks require private controller record storage");
    if (source.archived) throw new Error("Unarchive this chat before forking it");
    const requestId = input.requestId;
    if (typeof requestId !== "string" || !/^[A-Za-z0-9_-]{8,100}$/.test(requestId)) throw new Error("A unique fork request ID is required");
    const previous = this.store.list().find(chat => chat.forkedFromChatId === chatId && chat.forkRequestId === requestId && chat.ownerId === (source.ownerId || ownerId));
    if (previous) return Promise.resolve(previous);
    const pending = this.#forking.get(chatId);
    if (pending?.requestId === requestId) return pending.promise;
    if (pending || this.#switching.has(chatId) || this.#queued.has(chatId) && !this.#runtimes.has(chatId) || ["starting", "stopping"].includes(source.status)) throw Object.assign(new Error("Wait for the current worker change to finish"), { statusCode: 409 });
    const title = input.title ? clampText(input.title, 120, "title") : `Fork of ${source.title}`.slice(0, 120);
    const action = { requestId, controller: new AbortController() };
    this.#forking.set(chatId, action); this.#switching.add(chatId);
    action.promise = this.#forkChat(source, title, ownerId, action).finally(() => {
      this.#forking.delete(chatId); this.#switching.delete(chatId);
      void this.refreshActivity(chatId); void this.#drainQueue(chatId);
      if (action.workspaceOnly) void this.browserIdle(chatId).catch(error => this.#emit(chatId, { type: "runtime_log", text: errorMessage(error) }));
    });
    return action.promise;
  }

  async #forkChat(source, title, ownerId, action) {
    const signal = action.controller.signal;
    let runtime, bundle, targetId;
    try {
      if (source.environmentId) await (await this.servicesFor(source)).environments.runtime(source.environmentId, source);
      signal.throwIfAborted();
      action.workspaceOnly = !source.agentSessionId && !source.nativeForkSessionId;
      runtime = action.workspaceOnly ? { executor: await this.browserExecutor(source.id) } : await this.#nativeRuntime(source.id);
      signal.throwIfAborted();
      if (!action.workspaceOnly && !runtime.adapter.forkSession) throw new Error("This worker does not support persistent native forks");
      clearTimeout(runtime.idleTimer); runtime.idleTimer = null;
      await this.refreshActivity(source.id);
      const copy = await this.store.create({ title, ownerId: source.ownerId || ownerId, agent: source.agent, agentAccountId: source.agentAccountId, model: source.model, effort: source.effort, modelSelectionSet: source.modelSelectionSet,
        source: source.source, repositories: source.repositories, environmentId: source.environmentId, environmentName: source.environmentName, autoTitle: false }, async target => {
        targetId = target.id;
        signal.throwIfAborted();
        if (!action.workspaceOnly) this.#assertNativeAccount(source.id, runtime);
        try { bundle = action.workspaceOnly ? null : await runtime.adapter.forkSession(runtime.executor?.workspace || source.workspace); }
        catch (error) {
          // Opening an empty worker can assign an ID without materializing a
          // rollout. There is no transcript/goal to lose in this exact case.
          // Missing history for any populated or imported fork still fails.
          if (!source.nativeForkSessionId && !source.messages.length && !source.goal && /thread\/fork: no rollout found for thread id /.test(error.message)) { action.workspaceOnly = true; bundle = null; }
          else throw error;
        }
        if (bundle) validateSessionBundle(bundle);
        signal.throwIfAborted();
        await snapshotWorkspace({ executor: runtime.executor, source: runtime.executor?.workspace || source.workspace, destination: target.workspace, signal });
        const messages = source.messages.filter(message => !message.meta?.renderingSample).map(message => ({ ...message, id: newId("msg"), ...(["assistant", "tool"].includes(message.role) ? { agent: message.agent || source.agent } : {}) }));
        const attached = this.attachments ? await this.attachments.forkMessages(source.id, target.id, messages) : { messages, paths: [] };
        signal.throwIfAborted();
        await this.store.records.put("native-fork", target.id, { chatId: target.id, bundle, paths: attached.paths, authMode: source.agentAccountId ? "account" : this.config.codex.authMode, initialized: !bundle });
        signal.throwIfAborted();
        return { messages: attached.messages, mode: source.mode, serviceTier: source.serviceTier, personality: source.personality, workspaceReady: true,
          forkedFromChatId: source.id, forkRequestId: action.requestId, nativeForkSessionId: bundle?.threadId || null, agentSessionId: bundle?.threadId || null,
          forkGoalPending: bundle?.goal?.status === "active", forkContextPending: true, needsAgentHandoff: !bundle && messages.length > 0,
          goal: bundle?.goal ? { ...bundle.goal, status: bundle.goal.status === "active" ? "paused" : bundle.goal.status } : null,
          statusDetail: "Fork ready · independent conversation and workspace. Send a message to continue." };
      });
      if (signal.aborted) { await this.store.remove(copy.id); signal.throwIfAborted(); }
      if (bundle) runtime.adapter.releaseFork?.(bundle.threadId);
      this.publishChat(copy); return copy;
    } catch (error) {
      if (targetId) {
        await this.store.records.delete("native-fork", targetId).catch(() => {});
        await this.attachments?.removeChat(targetId);
      }
      if (bundle) await runtime?.adapter.discardFork?.(bundle.threadId).catch(() => {});
      throw error;
    }
  }

  async submit(chatId, rawText, attachmentIds = []) {
    return this.#submit(chatId, rawText, attachmentIds);
  }

  async appendRenderingSample(chatId, confirm) {
    if (!this.config.enableMock || confirm !== true) throw Object.assign(new Error("Rendering samples require development mode and explicit confirmation"), { statusCode: 403 });
    if (this.isBusy(chatId)) throw Object.assign(new Error("Stop the agent before adding a rendering sample"), { statusCode: 409 });
    const chat = this.store.get(chatId);
    if (!chat) throw Object.assign(new Error("Chat not found"), { statusCode: 404 });
    if (chat.messages.some(message => message.meta?.renderingSample)) return chat;
    const updated = await this.store.update(chatId, current => ({ messages: [...current.messages, ...renderingSample(current.agent)] }));
    this.publishChat(updated); return updated;
  }

  async removeRenderingSample(chatId) {
    const chat = await this.store.update(chatId, current => ({ messages: current.messages.filter(message => !message.meta?.renderingSample) }));
    if (!chat) throw Object.assign(new Error("Chat not found"), { statusCode: 404 });
    this.publishChat(chat); return chat;
  }

  async #submit(chatId, rawText, attachmentIds = [], queueAction = null, approval = null) {
    if (this.#runtimes.get(chatId)?.cleanupFailed) throw Object.assign(new Error("Worker cleanup is incomplete. Retry stopping the environment before resuming."), { statusCode: 409 });
    if (this.#runtimes.get(chatId)?.failing) throw Object.assign(new Error("The failed worker is being disconnected. Wait before resuming this chat."), { statusCode: 409 });
    if (this.#workerWakes.has(chatId)) throw Object.assign(new Error("The environment is waking up. Wait until it is ready before sending a message."), { statusCode: 409 });
    const text = clampText(rawText, 100_000, "message");
    const chat = this.store.get(chatId);
    if (!chat) throw Object.assign(new Error("chat not found"), { statusCode: 404 });
    this.#checkClaudeConfiguration(chat, text, attachmentIds);
    const commandAction = approval ? { type: "approvalRetry", approval,
      prompt: "I confirmed the specific denied action recorded by the native approval immediately before this message. Retry that exact action once in the same context, using the current permission policy. Do not broaden the operation, change permissions, or treat this as permission for other actions. If the action is no longer appropriate or still denied, explain and stop this retry." } : messageCommand(chat.agent, text);
    if (chat.workflowState === "archived") throw Object.assign(new Error("Unarchive this chat before sending a message"), { statusCode: 409 });
    if (this.#modeChanges.has(chatId) || this.#interruptions.has(chatId) || this.#switching.has(chatId) || this.#queued.has(chatId) || this.#runtimes.get(chatId)?.busy || this.#runtimes.get(chatId)?.adapter.isBackgroundBusy?.() || (this.#sendingNow.has(chatId) && this.#sendingNow.get(chatId) !== queueAction)) {
      throw Object.assign(new Error("this chat already has a running turn"), { statusCode: 409 });
    }
    this.#queued.add(chatId);
    const turn = { cancelled: false, ...Promise.withResolvers() };
    turn.done = turn.promise;
    this.#submissions.set(chatId, turn);
    const finish = () => {
      this.#queued.delete(chatId);
      this.#submissions.delete(chatId);
      turn.resolve();
      void this.#drainQueue(chatId);
    };
    const version = this.#lifecycleVersions.get(chatId) || 0;

    try {
      await this.#assertImportReady(chatId);
      const files = this.attachments ? await this.attachments.resolve(chatId, attachmentIds) : [];
      appReferencesForTurn(chat, files, companyForChat(chat));
      if (files.length && commandAction && !commandAction.prompt) throw new Error(`/${text.slice(1).split(/\s/)[0]} does not accept attachments. Remove them or send them in a separate message.`);
      if (chat.environmentId) await (await this.servicesFor(chat)).environments.runtime(chat.environmentId, chat);
      let skill = null;
      const slash = /^\/([\w:.-]+)(?:\s|$)/.exec(text);
      if (chat.agent === "codex" && slash && this.commands && !commandAction) {
        const command = (await this.commands.list(chat)).commands.find(item => item.name === slash[1]);
        if (command?.kind === "Skill" && command.path) skill = { name: command.name, path: command.path };
        else if (command?.web) throw new Error(`/${slash[1]} opens a web control. Run it without arguments, or choose it from the / menu.`);
      }
      if (turn.cancelled || version !== (this.#lifecycleVersions.get(chatId) || 0)) throw Object.assign(new Error("Turn cancelled"), { name: "AbortError" });
      await this.store.update(chatId, { awaitingUser: false, pendingRequest: null, ...(!chat.queuedMessages?.length ? { queuePaused: false, queueError: null } : {}) });
      const userMessage = await this.store.appendMessage(chatId, { role: "user", kind: "message", text, ...(files.length ? { attachments: files.map(file => this.attachments.public(file)) } : {}) });
      this.#emit(chatId, { type: "message", message: userMessage });
      if (Object.keys(provisionalTitlePatch(this.store.get(chatId), text, { hasAttachments: files.length > 0 })).length) {
        this.publishChat(await this.store.update(chatId, current => provisionalTitlePatch(current, text, { hasAttachments: files.length > 0 })));
      }
      if (turn.cancelled || version !== (this.#lifecycleVersions.get(chatId) || 0)) { finish(); return { message: userMessage, completion: Promise.resolve() }; }
      const completion = this.#runTurn(chatId, text, files, userMessage.id, skill, turn, commandAction).finally(finish);
      return { message: userMessage, completion };
    } catch (error) {
      finish();
      throw error;
    }
  }

  async send(chatId, rawText) {
    const submitted = await this.submit(chatId, rawText);
    await submitted.completion;
  }

  async #runTurn(chatId, text, files = [], userMessageId = null, skill = null, turn = {}, commandAction = null) {
    let runtime = this.#runtimes.get(chatId);

    if (!runtime) {
      try {
        runtime = await this.#start(chatId);
      } catch (error) {
        if (commandAction?.approval) await this.approvals.cancel(chatId, commandAction.approval.id).catch(() => {});
        if (error.name === "AbortError") return;
        this.publishChat(await this.store.update(chatId, { queuePaused: true, queueError: errorMessage(error) }));
        const message = await this.store.appendMessage(chatId, {
          role: "system",
          kind: "error",
          text: errorMessage(error),
        });
        this.#emit(chatId, { type: "turn_failed", message });
        return;
      }
    }
    runtime.busy = true;
    runtime.generation += 1;
    const generation = runtime.generation;
    if (runtime.idleTimer) clearTimeout(runtime.idleTimer);
    runtime.idleTimer = null;
    const assistantMessageId = newId("msg");
    runtime.assistantMessageId = assistantMessageId;
    runtime.assistantText = "";
    runtime.assistantPublishedLength = 0;
    runtime.toolMessages = new Map();
    await this.store.update(chatId, { taskProgress: null, workingStartedAt: nowIso() });
    await this.#setStatus(chatId, "running", "Agent is working", null);
    this.#emit(chatId, { type: "turn_started", messageId: assistantMessageId });

    try {
      this.#assertNativeAccount(chatId, runtime);
      if (turn.cancelled) return;
      if (commandAction?.type === "compact") {
        if (!runtime.adapter.compact) throw new Error("This worker does not expose native compaction. Update its Codex CLI.");
        await this.#setStatus(chatId, "running", "Compacting context", null);
        if (turn.cancelled || runtime.generation !== generation || this.#runtimes.get(chatId) !== runtime) return;
        this.#assertNativeAccount(chatId, runtime);
        await runtime.adapter.compact(); await runtime.eventQueue;
        if (turn.cancelled || runtime.generation !== generation) return;
        const message = await this.store.appendMessage(chatId, { role: "system", kind: "notice", text: "Context compacted." });
        this.#emit(chatId, { type: "turn_completed", message }); return;
      }
      if (commandAction?.type === "plan") this.publishChat(await this.store.update(chatId, { mode: "plan" }));
      if (["settings", "fast"].includes(commandAction?.type)) {
        const current = this.store.get(chatId);
        const selection = chat => JSON.stringify(chat && { agent: chat.agent, model: chat.model, effort: chat.effort, serviceTier: chat.serviceTier, personality: chat.personality });
        const before = selection(current);
        const check = () => {
          if (turn.cancelled || runtime.generation !== generation || this.#runtimes.get(chatId) !== runtime) throw Object.assign(new Error("Settings command cancelled"), { name: "AbortError" });
          if (selection(this.store.get(chatId)) !== before) throw new Error("The model settings changed while this command was being checked. Run the command again.");
        };
        const fastContext = Object.hasOwn(current, "serviceTier") ? current : { ...current, serviceTier: runtime.adapter.settings?.serviceTier };
        const settings = commandAction.type === "fast" ? await this.models.fastSettings(fastContext, commandAction.action) : commandAction.settings;
        check();
        if (Object.hasOwn(settings, "mode")) await this.setMode(chatId, settings.mode, { nextTurn: true });
        else await this.setModel(chatId, { model: current.model || null, effort: Object.hasOwn(settings, "model") ? null : current.effort || null, ...settings }, check);
        if (turn.cancelled || runtime.generation !== generation) return;
        const message = await this.store.appendMessage(chatId, { role: "system", kind: "notice", text: Object.entries(settings).map(([key, value]) => `${key}: ${value || "default"}`).join(" · ") });
        this.#emit(chatId, { type: "turn_completed", message }); return;
      }
      if (commandAction?.type === "goal") {
        if (commandAction.action !== "get") await this.store.update(chatId, { forkGoalPending: false });
        if (turn.cancelled || runtime.generation !== generation || this.#runtimes.get(chatId) !== runtime) return;
        if (!runtime.adapter.goalAction) throw new Error("This Codex worker does not expose goal controls. Update its CLI to a version with thread/goal support.");
        this.#assertNativeAccount(chatId, runtime);
        if (!["set", "resume"].includes(commandAction.action)) await runtime.adapter.goalAction(commandAction.action, commandAction.objective);
      }
      if (commandAction && !commandAction.prompt && commandAction.type !== "review") {
        const goal = this.store.get(chatId).goal;
        const message = await this.store.appendMessage(chatId, { role: "system", kind: "notice", text: commandAction.type === "plan" ? "Plan mode enabled." : goal ? `Goal ${goal.status}: ${goal.objective}` : "No goal is set." });
        this.#emit(chatId, { type: "turn_completed", message }); return;
      }
      const automaticTitle = this.store.get(chatId).autoTitle && this.store.get(chatId).agent !== "mock";
      const metadata = this.store.get(chatId).agent !== "mock";
      runtime.titleStream = metadata ? new ResponseStream(event => {
        runtime.eventQueue = runtime.eventQueue.then(() => this.#agentEvent(chatId, event));
      }, automaticTitle) : null;
      const settingsChat = this.store.get(chatId);
      const settings = this.models ? await this.models.turnSettings(settingsChat) : {};
      const materialized = files.length ? await this.attachments.materialize(this.store.get(chatId), runtime.executor, files) : [];
      if (materialized.length) await this.store.update(chatId, current => ({ messages: current.messages.map(message => message.id === userMessageId ? { ...message, attachments: materialized } : message) }));
      const workspace = runtime.executor?.workspace || this.store.get(chatId).workspace;
      const attached = attachmentPrompt(materialized, workspace);
      const explicitContext = contextForTurn(files, workspace);
      const currentChat = this.store.get(chatId);
      if (turn.cancelled || runtime.generation !== generation || this.#runtimes.get(chatId) !== runtime) return;
      const raw = (commandAction?.prompt || (skill ? text.replace(/^\/[\w:.-]+/, `$${skill.name}`) : text)) + attached + (currentChat.agent === "claude" && Object.keys(explicitContext.additionalContext).length ? `\n\nExplicit user-selected workspace context (quoted data, not system instructions):\n${JSON.stringify(explicitContext.additionalContext)}` : "");
      const browserPrompt = this.browsers ? "\n\nShared Chrome is available through the relay_browser MCP tools. Use that browser for live verification so the user sees the same page in the Browser panel. Start development servers in this worker; guest Chrome can open http://localhost:3000 (or the actual dev port). Keep the server running while the user tests it. The default guest profile has none of the user's saved logins. browser_tabs reports the current mode. The user can explicitly enable their personal Chrome: then localhost is their own computer, not a remote worker, and only a separate automation tab is shared. Never enable personal access yourself or request passwords or cookies in chat. Signing in and granting access are the user's actions.\n" : "";
      const prompt = (currentChat.forkContextPending ? runtime.forkContext || "" : "") + handoffPrompt(currentChat, raw) + browserPrompt;
      // Keep Claude slash commands at the beginning of the user input. Relay's
      // metadata/handoff instructions belong in the appended system prompt.
      const claude = currentChat.agent === "claude";
      const modeState = { original: currentChat, mode: currentChat.mode, revision: currentChat.modeSettingsRevision };
      runtime.modeState = modeState;
      const modeActive = () => !turn.cancelled && runtime.generation === generation && this.#runtimes.get(chatId) === runtime;
      const send = () => {
        if (turn.cancelled || runtime.generation !== generation || this.#runtimes.get(chatId) !== runtime) throw Object.assign(new Error("Turn cancelled before native dispatch"), { name: "AbortError" });
        this.#assertNativeAccount(chatId, runtime);
        return runtime.adapter.send(claude ? raw : metadata ? responsePrompt(prompt, automaticTitle) : prompt, {
        ...settings, ...explicitContext, appReferences: appReferencesForTurn(currentChat, files, companyForChat(currentChat)), ...(skill ? { skills: [skill] } : {}),
        ...(claude ? { selectionCurrent: () => {
          const selected = this.store.get(chatId);
          return modeActive() && selected && runtimeAccountBinding(selected) === runtimeAccountBinding(settingsChat)
            && selected.modelSettingsRevision === settingsChat.modelSettingsRevision;
        } } : {}),
        ...(commandAction?.type === "review" ? { reviewTarget: commandAction.target } : {}),
        ...(commandAction?.type === "goal" ? { goalDirective: commandAction } : currentChat.forkGoalPending && currentChat.mode !== "plan" && commandAction?.type !== "review" ? { goalDirective: { action: "resume", fork: true } } : {}),
        ...(claude ? { systemPrompt: responsePrompt("", automaticTitle) + (currentChat.needsAgentHandoff ? handoffPrompt(currentChat, "") : "") + browserPrompt,
          onPermissionMode: mode => {
            if (!modeActive()) return runtime.eventQueue;
            const change = this.#modeChanges.get(chatId);
            if (change?.acknowledged) {
              if (Object.values(CLAUDE_PERMISSION_MODES).includes(mode)) change.latest = mode;
              return runtime.eventQueue;
            }
            const permissionEpoch = runtime.permissionEpoch || 0;
            const stillCurrent = () => modeActive() && (runtime.permissionEpoch || 0) === permissionEpoch;
            runtime.eventQueue = runtime.eventQueue.then(() => this.#syncClaudePermissionMode(chatId, mode, modeState, stillCurrent));
            return runtime.eventQueue;
          },
          onFastConstraint: value => {
            if (turn.cancelled || runtime.generation !== generation || this.#runtimes.get(chatId) !== runtime) return;
            runtime.eventQueue = runtime.eventQueue.then(() => this.#retainClaudeFastConstraint(chatId, value, settingsChat));
          } } : {}),
        mode: currentChat.mode || "accept_edits", images: materialized.filter(file => /^image\/(png|jpeg|webp|gif)$/.test(file.mime)).map(file => file.path) });
      };
      const checkConfiguration = () => {
        if (turn.cancelled || runtime.generation !== generation || this.#runtimes.get(chatId) !== runtime) throw Object.assign(new Error("Settings command cancelled"), { name: "AbortError" });
      };
      const syncConfiguration = async native => {
        // Serialize readback with live SDK changes. Our own mode transitions
        // must not look like a newer user choice, and vice versa.
        const task = runtime.eventQueue.then(async () => {
          const updated = await this.#syncClaudeConfiguration(chatId, native, { ...currentChat, mode: modeState.mode, modeSettingsRevision: modeState.revision }, checkConfiguration);
          if (updated) { modeState.mode = updated.mode; modeState.revision = updated.modeSettingsRevision; }
        });
        runtime.eventQueue = task.catch(() => {});
        await task;
      };
      const nativeSend = async () => {
        try { return await send(); }
        catch (error) {
          if (commandAction?.type === "claudeConfig") await syncConfiguration(error.nativeSettings);
          if (claude) await this.#syncClaudeFast(chatId, error, settingsChat, checkConfiguration);
          throw error;
        }
      };
      const result = commandAction?.approval ? await this.approvals.retry(chatId, commandAction.approval, runtime.adapter, nativeSend, () => {
        if (turn.cancelled || runtime.generation !== generation || this.#runtimes.get(chatId) !== runtime) throw Object.assign(new Error("Approval retry cancelled because the chat stopped"), { name: "AbortError" });
        runtime.adapter.assertInputReady?.();
      }) : await nativeSend();
      if (turn.cancelled || runtime.generation !== generation) return;
      runtime.titleStream?.flush();
      await runtime.eventQueue;
      if (turn.cancelled || runtime.generation !== generation || this.#runtimes.get(chatId) !== runtime) return;
      if (commandAction?.type === "claudeConfig") await syncConfiguration(result.nativeSettings);
      if (claude) await this.#syncClaudeFast(chatId, result, settingsChat, checkConfiguration);
      if (claude && /^\/reload-(?:skills|plugins)(?:\s|$)/.test(text)) await this.#refreshCommandCatalog(chatId);
      if (turn.cancelled || runtime.generation !== generation || this.#runtimes.get(chatId) !== runtime) return;
      if (!result.turnsHandled) {
      const output = metadata ? extractResponse(result.text || "", automaticTitle) : { text: result.text || "", title: null, awaitingUser: false };
      if (output.title) await this.#agentEvent(chatId, { type: "title", title: output.title });
      if (turn.cancelled || runtime.generation !== generation || this.#runtimes.get(chatId) !== runtime) return;
      await this.store.update(chatId, { awaitingUser: output.awaitingUser, needsAgentHandoff: false });
      if (turn.cancelled || runtime.generation !== generation || this.#runtimes.get(chatId) !== runtime) return;
      const message = await this.store.appendMessage(chatId, {
        id: assistantMessageId,
        role: "assistant",
        agent: this.store.get(chatId).agent,
        kind: "message",
        text: remainingAssistantText(runtime, output.text),
        ...(runtime.assistantPublishedLength ? { meta: { segmentedTurn: true } } : {}),
      });
      if (turn.cancelled || runtime.generation !== generation || this.#runtimes.get(chatId) !== runtime) return;
      this.#emit(chatId, { type: "turn_completed", message });
      }
      // Inspect only a worker that is already awake. Later GitHub polling uses
      // these saved branch names and never boots an idle EC2 instance.
      const [gitBranches, workspaceStatus] = await Promise.all([
        inspectBranches(this.store.get(chatId), runtime.executor), inspectWorkspaceStatus(this.store.get(chatId), runtime.executor),
      ]);
      const workspaceChanges = runtime.generation === generation ? await snapshotChanges(this.store.get(chatId), runtime.executor) : null;
      if (runtime.generation === generation) await this.store.update(chatId, { gitBranches, workspaceStatus, workspaceChanges });
    } catch (error) {
      if (turn.cancelled || runtime.generation !== generation) return;
      this.publishChat(await this.store.update(chatId, { queuePaused: true, queueError: errorMessage(error) }));
      const message = await this.store.appendMessage(chatId, {
        role: "system",
        kind: "error",
        text: errorMessage(error),
      });
      this.#emit(chatId, { type: "turn_failed", message });
    } finally {
      if (commandAction?.approval) await this.approvals.cancel(chatId, commandAction.approval.id).catch(() => {});
      if (turn.cancelled && runtime.generation === generation && this.#runtimes.get(chatId) === runtime) {
        await runtime.eventQueue;
        const remaining = remainingAssistantText(runtime, runtime.assistantText || "");
        if (remaining && !this.store.get(chatId).messages.some(message => message.id === assistantMessageId)) {
          const message = await this.store.appendMessage(chatId, { id: assistantMessageId, role: "assistant", agent: this.store.get(chatId).agent, kind: "message", text: remaining, meta: { interrupted: true } });
          this.#emit(chatId, { type: "message", message });
        }
      }
      runtime.titleStream = null;
      if (runtime.generation === generation && this.#runtimes.get(chatId) === runtime) {
        runtime.busy = false;
        await this.#scheduleIdleStop(chatId, runtime);
        this.pullRequests.refresh(chatId).catch(() => {});
      }
    }
  }

  interrupt(chatId) {
    if (this.#interruptions.has(chatId)) return this.#interruptions.get(chatId);
    // Use the existing serialized queue handoff: cancel only the active turn
    // and submit the next queued message, keeping the rest in FIFO order.
    if (this.#sendingNow.has(chatId)) return this.#sendingNow.get(chatId).promise;
    const next = this.store.get(chatId)?.queuedMessages?.[0];
    if (next) return this.sendQueuedNow(chatId, next.id);
    const action = this.#interruptTurn(chatId).finally(() => this.#interruptions.delete(chatId));
    this.#interruptions.set(chatId, action);
    return action;
  }

  async #interruptTurn(chatId) {
    const chat = this.store.get(chatId);
    if (!chat) throw Object.assign(new Error("Chat not found"), { statusCode: 404 });
    if (chat.status === "stopping" || this.#sendingNow.has(chatId) || this.#switching.has(chatId)) throw Object.assign(new Error("This chat is already changing; please wait"), { statusCode: 409 });
    const version = this.#lifecycleVersions.get(chatId) || 0;
    const turn = this.#submissions.get(chatId);
    if (turn) turn.cancelled = true;
    this.publishChat(await this.store.update(chatId, { queuePaused: true }));
    const runtime = this.#runtimes.get(chatId);
    try {
      // Equivalent to native Escape: preserve the worker, browser, services,
      // credentials and native session. Never fall back to stop()/VM shutdown.
      if (runtime && (turn || runtime.adapter.isBackgroundBusy?.())) {
        if (!runtime.adapter.interrupt) throw new Error("This agent does not support turn interruption");
        await runtime.adapter.interrupt();
      }
      await turn?.done;
      await runtime?.eventQueue;
      if (version !== (this.#lifecycleVersions.get(chatId) || 0)) return this.store.get(chatId);
      this.publishChat(await this.store.update(chatId, { pendingRequest: null, awaitingUser: false, queuePaused: true }));
      this.#emit(chatId, { type: "turn_interrupted" });
      const active = this.#runtimes.get(chatId);
      if (active) { active.busy = false; await this.#scheduleIdleStop(chatId, active); }
      return this.store.get(chatId);
    } catch (error) {
      if (turn && this.#submissions.get(chatId) === turn) turn.cancelled = false;
      throw error;
    }
  }

  async stop(chatId, reason = "manual") {
    // A fatal exit owns the old runtime until its queued events and visible
    // response have been checkpointed. Do not race its teardown with Stop.
    const failure = this.#runtimes.get(chatId)?.failure;
    if (failure) await failure.catch(() => {});
    const failedRuntime = this.#runtimes.get(chatId);
    if (failedRuntime?.cleanupFailed) {
      if (!failedRuntime.failing) {
        failedRuntime.failure = null;
        void this.#fatal(chatId, failedRuntime.failureCause);
      }
      await failedRuntime.failure;
      if (failedRuntime.cleanupFailed) throw failedRuntime.cleanupError;
    }
    const chat = this.store.get(chatId);
    if (!chat) throw Object.assign(new Error("chat not found"), { statusCode: 404 });
    // An idle request must never enter destructive Stop, even when suspension
    // support or diagnostic persistence fails. Manual/revocation Stop is separate.
    if (reason === "idle-timeout" && this.config.idlePolicy === "hibernate") return this.#suspensionUnavailable(chatId);
    const stoppingExecutor = this.#executors.get(chatId);
    this.#previewStops.set(chatId, (this.#previewStops.get(chatId) || 0) + 1);
    let stopped = false;
    try {
    const stopVersion = (this.#lifecycleVersions.get(chatId) || 0) + 1;
    this.#lifecycleVersions.set(chatId, stopVersion);
    this.#startupControllers.get(chatId)?.abort(Object.assign(new Error("Worker startup cancelled"), { name: "AbortError" }));
    // Storage failure must not leave a warmed native RPC reusable. Keep the
    // reference for retry cleanup, but invalidate admission before any await.
    const stoppingRuntime = this.#runtimes.get(chatId);
    if (stoppingRuntime) stoppingRuntime.revoked = true;
    this.#awakeWorkers.delete(chatId);
    clearTimeout(this.#workerIdleTimers.get(chatId)); this.#workerIdleTimers.delete(chatId);
    this.previewActivity.revokeChat(chatId);
    this.emit("preview-revoke", { chatId, reason });
    this.workspacePresence.remove(chatId);
    clearTimeout(this.#workspaceIdleTimers.get(chatId)); this.#workspaceIdleTimers.delete(chatId);
    this.#forking.get(chatId)?.controller.abort(Object.assign(new Error("Fork cancelled because the source chat stopped"), { name: "AbortError", statusCode: 409 }));
    // Gateway access ends at Stop, not after slow persistence, side-chat or
    // worker shutdown. Native interruption can still checkpoint its journal.
    this.broker.revokeChat(chatId);
    this.githubWorkers?.revokeChat(chatId);
    this.revokeChatMcps(chatId);
    this.publishChat(await this.store.update(chatId, current => ({ queuePaused: true, startupProgress: failRunningStartup(current.startupProgress), ...(reason === "manual" ? { forkGoalPending: false } : {}) })));
    const runtime = this.#runtimes.get(chatId);
    if (this.config.workerBackend === "ec2" && chat.agent !== "mock") {
      await this.#setStatus(chatId, "stopping", "Stopping EC2 worker", null);
    }
    if (runtime) {
      runtime.generation += 1;
      if (runtime.idleTimer) clearTimeout(runtime.idleTimer);
      this.#runtimes.delete(chatId);
      await this.sideChats.close(chatId).catch(error => this.#emit(chatId, { type: "runtime_log", text: `Side stop warning: ${errorMessage(error)}` }));
      await runtime.adapter.stop().catch((error) => this.#emit(chatId, { type: "runtime_log", text: `Adapter stop warning: ${errorMessage(error)}` }));
      await this.#checkpointStoppedAgentThreads(chatId, runtime, stopVersion).catch(error => this.#emit(chatId, { type: "runtime_log", text: `Agent snapshot could not be saved: ${errorMessage(error)}` }));
      await runtime.eventQueue; // Flush final context/usage before worker storage disappears.
      await this.agentThreads.flush(chatId).catch(error => this.#emit(chatId, { type: "runtime_log", text: `Agent snapshot could not be saved: ${errorMessage(error)}` }));
    }
    else await this.sideChats.close(chatId).catch(error => this.#emit(chatId, { type: "runtime_log", text: `Side stop warning: ${errorMessage(error)}` }));
    await this.browsers?.stop(chatId);
    const executor = stoppingExecutor || this.#executors.get(chatId);
    if (executor) await executor.catch(() => {});
    this.#executors.delete(chatId);
    try {
      const observed = chat.agent !== "mock" && !executor?.workerReleased ? await this.workerBackend.sleep(chat) : null;
      if (this.config.workerBackend === "ec2") await runtime?.adapter.confirmImportWorkerStopped?.(observed);
    } catch (error) {
      this.broker.revokeChat(chatId);
      await this.#setStatus(chatId, "error", `Worker stop failed: ${errorMessage(error)}`, null);
      this.#emit(chatId, { type: "runtime_error", text: `Worker stop failed: ${errorMessage(error)}` });
      throw error;
    }
    this.broker.revokeChat(chatId);
    const detail = reason === "idle-timeout" ? "Stopped after idle timeout" : "Stopped manually";
    await this.#setStatus(chatId, "stopped", detail, null);
    this.#emit(chatId, { type: "runtime_stopped", reason });
    stopped = true;
    } finally {
      if (stopped) this.#previewBlocked.delete(chatId); else this.#previewBlocked.add(chatId);
      const pending = this.#previewStops.get(chatId) - 1;
      if (pending) this.#previewStops.set(chatId, pending); else this.#previewStops.delete(chatId);
    }
  }

  async goalAction(chatId, action) {
    if (!["pause", "clear", "resume"].includes(action)) throw new Error("Choose pause, resume or clear");
    const chat = this.store.get(chatId);
    if (!chat) throw Object.assign(new Error("Chat not found"), { statusCode: 404 });
    if (chat.agent !== "codex") throw new Error("These persistent goal controls are for Codex");
    if (action === "resume") {
      if (this.isBusy(chatId) || chat.queuedMessages?.length) return this.enqueue(chatId, "/goal resume");
      await this.submit(chatId, "/goal resume"); return this.store.get(chatId);
    }
    if (this.#switching.has(chatId) || this.#sendingNow.has(chatId) || ["starting", "stopping"].includes(chat.status)) throw Object.assign(new Error("Wait for the current session change to finish"), { statusCode: 409 });
    this.#switching.add(chatId);
    const version = this.#lifecycleVersions.get(chatId) || 0;
    try {
      const runtime = await this.#nativeRuntime(chatId);
      if (version !== (this.#lifecycleVersions.get(chatId) || 0)) throw new Error("Goal action cancelled because the chat was stopped");
      if (!runtime.adapter.goalAction) throw new Error("This worker does not support goal controls");
      this.#assertNativeAccount(chatId, runtime);
      await runtime.adapter.goalAction(action);
      await this.store.update(chatId, { forkGoalPending: false });
      if (!runtime.busy) await this.#scheduleIdleStop(chatId, runtime);
      return this.store.get(chatId);
    } finally { this.#switching.delete(chatId); void this.#drainQueue(chatId); }
  }

  async remove(chatId) {
    const chat = this.store.get(chatId);
    if (!chat) return false;
    await this.stop(chatId, "deleted");
    this.presence.remove(chatId);
    if (chat.agent !== "mock") await this.workerBackend.destroy(chat);
    const removed = await this.store.remove(chatId);
    this.agentThreads.forget(chatId);
    await this.attachments?.removeChat(chatId);
    this.#emit(chatId, { type: "chat_deleted", chatId });
    this.#events.delete(chatId);
    return removed;
  }

  async respond(chatId, requestId, input = {}) {
    this.#assertNativeAccount(chatId);
    const chat = this.store.get(chatId);
    const runtime = this.#runtimes.get(chatId);
    if (!chat || !runtime) throw Object.assign(new Error("chat runtime is not active"), { statusCode: 404 });
    if (chat.pendingRequest?.requestId !== requestId) throw Object.assign(new Error("request is no longer active"), { statusCode: 409 });

    const payload = responseFor(chat.pendingRequest, input);
    await runtime.adapter.respond(requestId, payload);
    const updated = await this.store.update(chatId, current => current.pendingRequest?.requestId === requestId ? { pendingRequest: null, ...workflowPatch({ ...current, pendingRequest: null }) } : {});
    this.publishChat(updated);
    this.#emit(chatId, { type: "request_resolved", requestId });
  }

  eventsSince(chatId, lastId = 0) {
    return (this.#events.get(chatId) || []).filter((event) => event.id > lastId);
  }

  async shutdown() {
    this.githubWorkers?.shutdown();
    this.previewActivity.close();
    this.presence.clear();
    this.workspacePresence.clear();
    for (const timer of this.#workspaceIdleTimers.values()) clearTimeout(timer);
    this.#workspaceIdleTimers.clear();
    await this.pullRequests.stop();
    await Promise.allSettled([...new Set([...this.#runtimes.keys(), ...this.#executors.keys(), ...this.#workerWakes.keys()])].map((chatId) => this.stop(chatId, "shutdown")));
    await Promise.allSettled([...this.#workerWakes.values()].map(operation => operation.completion || operation.admission));
    await this.browsers?.shutdown();
  }

  async #start(chatId) {
    const chat = this.store.get(chatId);
    if (chat?.agentAccountId && ["codex", "claude"].includes(chat.agent)) await this.agentAccounts.select(chat.ownerId, chat.agentAccountId, chat);
    else if (chat?.agent !== "mock" && (this.config.google?.enabled || this.resources && !this.resources.isLegacy(chat?.ownerId))) throw new Error("Connect and select an agent account for this user before starting a worker");
    const version = this.#lifecycleVersions.get(chatId) || 0;
    const checkCancelled = () => { const current = this.store.get(chatId); if (!current || current.archived || runtimeAccountBinding(current) !== runtimeAccountBinding(chat) || (this.#lifecycleVersions.get(chatId) || 0) !== version) throw Object.assign(new Error("Worker startup cancelled"), { name: "AbortError" }); };
    await this.#setStatus(chatId, "starting", "Starting isolated agent runtime", null);
    this.#awakeWorkers.delete(chatId);
    clearTimeout(this.#workerIdleTimers.get(chatId)); this.#workerIdleTimers.delete(chatId);
    let runtime;
    let executor;
    let forkRecord;
    let savedAgentThreads;
    let forkContext = "";
    const hooks = {
      onAgentThreads: snapshot => {
        if (!runtime || runtime.failing || runtime.failed || this.#runtimes.get(chatId) !== runtime) return;
        void this.agentThreads.update(chatId, snapshot)?.catch(error => this.#emit(chatId, { type: "runtime_log", text: `Agent snapshot: ${errorMessage(error)}` }));
        void this.refreshActivity(chatId);
      },
      onEvent: (event) => {
        if (runtime?.failing || runtime?.failed) return Promise.resolve();
        if (event.type === "native_approval_denied") {
          if (this.#runtimes.get(chatId) !== runtime) return runtime.eventQueue;
          const observed = { ...chat, agentSessionId: runtime.adapter.threadId }, binding = this.approvals.binding(observed);
          runtime.eventQueue = runtime.eventQueue.then(() => this.approvals.capture(chatId, event.report, binding))
            .catch(() => this.#emit(chatId, { type: "runtime_log", text: "A native denial could not be safely retained for /approve. No approval was granted." }));
          return runtime.eventQueue;
        }
        if (event.type === "goal_turn_completed" || event.type === "tool" && (runtime.titleStream?.buffer || runtime.titleStream?.title?.buffer)) runtime.titleStream?.flush();
        if (event.type === "goal_turn_started") runtime.titleStream = new ResponseStream(delta => { runtime.eventQueue = runtime.eventQueue.then(() => this.#agentEvent(chatId, delta)); }, this.store.get(chatId)?.autoTitle);
        if (event.type === "assistant_delta" && runtime.titleStream) { runtime.titleStream.delta(event.delta || ""); return runtime.eventQueue; }
        runtime.eventQueue = runtime.eventQueue.then(() => this.#agentEvent(chatId, event));
        return runtime.eventQueue;
      },
      onRequest: (request) => {
        if (runtime?.failing || runtime?.failed) return Promise.resolve();
        runtime.eventQueue = runtime.eventQueue.then(() => this.#agentRequest(chatId, request));
        return runtime.eventQueue;
      },
      onSessionId: async (agentSessionId) => {
        checkCancelled(); await this.store.update(chatId, current => { checkCancelled(); return { agentSessionId }; });
      },
      onForkRestored: async () => {
        if (forkRecord && !forkRecord.initialized) await this.store.records.put("native-fork", chatId, { ...forkRecord, initialized: true });
      },
      onInputStarted: async ({ forkGoal }) => {
        const current = this.store.get(chatId);
        if (current?.forkContextPending || forkGoal && current?.forkGoalPending) await this.store.update(chatId, { forkContextPending: false, ...(forkGoal ? { forkGoalPending: false } : {}) });
      },
      onLog: (text) => this.#emit(chatId, { type: "runtime_log", text }),
      ...(["codex", "claude"].includes(chat.agent) && chat.agentAccountId ? { accountCredentials: async options => {
        const current = this.store.get(chatId);
        if (!current || current.agent !== chat.agent || current.ownerId !== chat.ownerId || current.agentAccountId !== chat.agentAccountId) throw new Error("The selected agent account changed");
        checkCancelled();
        const credentials = await this.agentAccounts.credentials(current.ownerId, current.agentAccountId, current, options);
        checkCancelled(); return credentials;
      } } : {}),
      onFatal: (error) => {
        // A stopped adapter may report a late exit after another runtime has
        // resumed the chat. It cannot revoke or terminate that newer lease.
        if (!runtime || this.#runtimes.get(chatId) !== runtime || (this.#lifecycleVersions.get(chatId) || 0) !== version) return Promise.resolve();
        return this.#fatal(chatId, error).catch((fatalError) => console.error("runtime fatal handler:", errorMessage(fatalError)));
      },
    };
    const Adapter = ADAPTERS[chat.agent];
    if (!Adapter) throw new Error(`unsupported agent: ${chat.agent}`);
    try {
      checkCancelled();
      savedAgentThreads = chat.agent === "codex" ? await this.agentThreads.get(chatId) : null;
      if (chat.nativeForkSessionId || chat.forkedFromChatId && chat.forkContextPending) {
        forkRecord = await this.store.records?.get("native-fork", chatId);
        if (!forkRecord || chat.agent !== "codex" || forkRecord.chatId !== chatId || forkRecord.authMode !== (chat.agentAccountId ? "account" : this.config.codex.authMode) || chat.nativeForkSessionId && (forkRecord.bundle?.threadId !== chat.agentSessionId || chat.nativeForkSessionId !== chat.agentSessionId)) throw new Error("This fork's private native history or original authentication mode is unavailable");
        if (chat.nativeForkSessionId) validateSessionBundle(forkRecord.bundle, chat.agentSessionId);
      }
      executor = chat.agent === "mock" ? null : await this.browserExecutor(chatId);
      if (executor?.metadata) await this.store.update(chatId, { runtimeMetadata: executor.metadata });
      checkCancelled();
      if (executor && chat.environmentId) {
        const environment = await (await this.servicesFor(chat)).environments.runtime(chat.environmentId, chat);
        if (environment.backend !== this.config.workerBackend) throw new Error("The environment backend changed. Use the original worker backend to resume this chat.");
        checkCancelled();
        await this.#startupTask(chatId, "software", version, () => prepareSoftware(executor, environment, async () => { checkCancelled(); }));
        checkCancelled();
        executor.environmentVariables = { ...environment.variables, ...executor.capabilityVariables };
        executor.mcpServers = await (await this.servicesFor(chat)).mcps?.runtime(chatId, environment.mcpIds || [], executor.gatewayOrigin || this.gatewayOrigin, chat) || {};
        if (environment.setupScript) {
          checkCancelled();
          await this.#startupTask(chatId, "setup", version, async () => { try {
            checkCancelled();
            await captureWorker(executor, "/bin/bash", ["-e", "-c", environment.setupScript], { cwd: executor.workspace,
              env: { ...executor.environmentVariables, PATH: executor.environmentPath || process.env.PATH, HOME: executor.runtimeHome, LANG: "C.UTF-8", CI: "1" } });
          } catch { checkCancelled(); throw new Error("Environment setup script failed. Review the script and its agent-readable variables. Protected variables are not available to setup scripts."); } });
        }
      }
      if (executor && !chat.environmentId) {
        const mcps = (await this.servicesFor(chat)).mcps;
        if (mcps?.companies) executor.mcpServers = await mcps.runtime(chatId, await mcps.forCompany(companyForChat(chat)), executor.gatewayOrigin || this.gatewayOrigin, chat);
        checkCancelled();
      }
      if (executor && this.browsers) executor.mcpServers = { ...executor.mcpServers, ...this.browsers.runtime(chatId, executor.gatewayOrigin || this.gatewayOrigin) };
      if (executor && this.githubWorkers) {
        checkCancelled();
        const origin = executor.gatewayOrigin || this.gatewayOrigin;
        const grant = await this.githubWorkers.runtime(chatId, origin, { validWhile: () => {
          const current = this.store.get(chatId);
          return (this.#lifecycleVersions.get(chatId) || 0) === version && Boolean(current) && !current.archived;
        } });
        checkCancelled();
        // Setup runs before issuance. Nothing is written to .git/config, chat
        // records or executor metadata; Git inherits a revocable per-chat grant.
        executor.environmentVariables = { ...executor.environmentVariables, ...grant.environmentVariables };
        executor.capabilitySecrets = new Set([...(executor.capabilitySecrets || []), ...(grant.token ? [grant.token] : [])]);
        if (grant.token) {
          if (executor.mcpServers?.relay_github) throw new Error("The relay_github MCP name is reserved for the selected GitHub connection");
          executor.mcpServers = { ...executor.mcpServers, ...githubWorkerMcpConfig(origin, grant.token) };
        }
      }
      if (executor) executor.capabilitySecrets = runtimeMcpSecrets(executor.mcpServers, executor.gatewayOrigin || this.gatewayOrigin, executor.capabilitySecrets);
      if (forkRecord && chat.forkContextPending) {
        const files = new Map(), mappings = [];
        for (const entry of forkRecord.paths || []) {
          if (!files.has(entry.id)) {
            const records = await this.attachments.resolve(chatId, [entry.id]);
            files.set(entry.id, (await this.attachments.materialize(chat, executor, records))[0]);
          }
          const file = files.get(entry.id);
          mappings.push({ name: file.name, previousPath: entry.previousPath, path: file.path, mime: file.mime });
        }
        forkContext = `This conversation was explicitly forked into an independent workspace: ${JSON.stringify(executor?.workspace || chat.workspace)}. Work in this workspace, not the original conversation's paths. ${mappings.length ? `Historical attachments now have these paths: ${JSON.stringify(mappings)}` : ""}\n\n`;
      }
      checkCancelled();
    } catch (error) {
      if ((this.#lifecycleVersions.get(chatId) || 0) !== version) throw error;
      this.githubWorkers?.revokeChat(chatId);
      this.revokeChatMcps(chatId);
      await this.browsers?.stop(chatId);
      checkCancelled();
      if (!this.#executors.get(chatId)?.cleanupFailed) this.#executors.delete(chatId);
      if (executor) await (this.config.workerBackend === "ec2" ? executor.releaseAcquisition?.() : this.workerBackend.sleep(chat))?.catch(() => {});
      checkCancelled();
      await this.store.update(chatId, current => { checkCancelled(); return { startupProgress: failRunningStartup(current.startupProgress) }; });
      checkCancelled();
      if (error.name !== "AbortError") await this.#setStatus(chatId, "error", errorMessage(error), null);
      throw error;
    }
    let adapter;
    try {
      adapter = this.adapterFactory
        ? this.adapterFactory({ chat, hooks, executor, restoreFork: forkRecord && !forkRecord.initialized ? forkRecord.bundle : null, savedAgentThreads })
        : new Adapter({ chat, store: this.store, config: this.config, broker: this.broker, gatewayOrigin: this.gatewayOrigin, executor, hooks, restoreFork: forkRecord && !forkRecord.initialized ? forkRecord.bundle : null, savedAgentThreads });
      runtime = { adapter, executor, forkContext, accountBinding: runtimeAccountBinding(chat), busy: false, idleTimer: null, generation: 0, eventQueue: Promise.resolve() };
      this.#runtimes.set(chatId, runtime);
      await this.#startupTask(chatId, "agent", version, () => { checkCancelled(); return adapter.start(); });
      checkCancelled();
      await this.store.update(chatId, current => { checkCancelled(); return { startupProgress: { ...current.startupProgress, finishedAt: nowIso() } }; });
      checkCancelled();
      await this.#setStatus(chatId, "idle", "Runtime ready", null);
      // Persistence above can overlap Stop/fatal handling. Only a current,
      // fully ready runtime may restore preview admission after an error.
      checkCancelled();
      const current = this.store.get(chatId);
      if (current && !current.archived && this.#runtimes.get(chatId) === runtime && !this.#previewStops.has(chatId)) {
        this.#previewBlocked.delete(chatId);
      }
      this.#emit(chatId, { type: "runtime_started", agent: chat.agent });
      return runtime;
    } catch (error) {
      if ((this.#lifecycleVersions.get(chatId) || 0) !== version) throw error;
      this.#runtimes.delete(chatId);
      this.githubWorkers?.revokeChat(chatId);
      this.revokeChatMcps(chatId);
      await this.browsers?.stop(chatId);
      checkCancelled();
      this.#executors.delete(chatId);
      await adapter?.stop().catch(() => {});
      checkCancelled();
      if (chat.agent !== "mock") await (this.config.workerBackend === "ec2" ? executor?.releaseAcquisition?.() : this.workerBackend.sleep(chat))?.catch(() => {});
      checkCancelled();
      await this.store.update(chatId, current => { checkCancelled(); return { startupProgress: failRunningStartup(current.startupProgress) }; });
      checkCancelled();
      if (error.name !== "AbortError") await this.#setStatus(chatId, "error", errorMessage(error), null);
      throw error;
    }
  }

  async #scheduleIdleStop(chatId, runtime) {
    clearTimeout(runtime.idleTimer); runtime.idleTimer = null;
    if (this.#runtimes.get(chatId) !== runtime || runtime.failing || runtime.busy || runtime.trustReviewing || runtime.adapter.isBackgroundBusy?.()) return;
    const reason = this.#importPending(chatId) ? "import" : this.#forking.has(chatId) ? "fork" : runtime.adapter.hasScheduledWork?.() ? "schedule" : runtime.adapter.agents?.busy() ? "agents" : this.sideChats.busy(chatId) ? "side" : this.browsers?.hasViewers(chatId) ? "browser" : this.previewActivity.has(chatId) ? "preview" : this.workspacePresence.has(chatId) ? "workspace" : this.presence.has(chatId) ? "tab" : null;
    const chat = this.store.get(chatId);
    if (reason) {
      if (chat?.idleKeepAwakeReason !== reason || chat?.idleDeadlineAt || chat?.status !== "idle") {
        const updated = await this.store.update(chatId, current => ({ ...runtimeWorkflowPatch(current, "idle"), status: "idle", statusDetail: reason === "import" ? "Sleep paused until the import is reconciled" : reason === "fork" ? "Creating an independent fork" : reason === "schedule" ? "Sleep paused while native scheduled tasks are active" : reason === "agents" ? "Sleep paused while child agents are working" : reason === "side" ? "Sleep paused while the side chat is working" : reason === "browser" ? "Sleep paused while you're using Chrome" : reason === "preview" ? "Sleep paused while an app preview is active" : reason === "workspace" ? "Sleep paused while the workspace viewer is open" : "Sleep paused while this chat tab is visible", idleDeadlineAt: null, idleKeepAwakeReason: reason }));
        if (updated) this.publishChat(updated);
      }
      return;
    }
    const deadline = new Date(Date.now() + this.config.idleTimeoutMs).toISOString();
    await this.#setStatus(chatId, "idle", "Waiting for another message", deadline);
    runtime.idleTimer = setTimeout(() => {
      if (this.#importPending(chatId) || this.#forking.has(chatId) || runtime.adapter.hasScheduledWork?.() || runtime.adapter.agents?.busy() || this.sideChats.busy(chatId) || this.browsers?.hasViewers(chatId) || this.previewActivity.has(chatId) || this.workspacePresence.has(chatId) || this.presence.has(chatId)) { void this.#scheduleIdleStop(chatId, runtime); return; }
      if (this.#runtimes.get(chatId) !== runtime || runtime.busy || runtime.trustReviewing || runtime.adapter.isBackgroundBusy?.()) return;
      this.stop(chatId, "idle-timeout").catch((error) => {
        if (this.config.idlePolicy === "hibernate") this.#emit(chatId, { type: "runtime_log", text: "Hibernation unavailable; its diagnostic could not be saved. Worker left running; use Stop explicitly." });
        else this.#fatal(chatId, error);
      });
    }, this.config.idleTimeoutMs);
    runtime.idleTimer.unref?.();
  }

  async #suspensionUnavailable(chatId, { admission = false } = {}) {
    const version = this.#lifecycleVersions.get(chatId) || 0;
    const updated = await this.store.update(chatId, current => {
      if ((this.#lifecycleVersions.get(chatId) || 0) !== version || current.archived || current.status === "stopping") return {};
      if (!admission && (this.isBusy(chatId) || current.status === "running" || this.sideChats.busy(chatId) || this.presence.has(chatId) || this.previewActivity.has(chatId) || this.workspacePresence.has(chatId) || this.browsers?.hasViewers(chatId))) return {};
      return { idleDeadlineAt: null, idleKeepAwakeReason: "hibernation-unavailable", statusDetail: HIBERNATION_UNAVAILABLE,
        suspension: { policy: "hibernate", status: "unavailable", checkedAt: nowIso() } };
    });
    if ((this.#lifecycleVersions.get(chatId) || 0) === version && updated) this.publishChat(updated);
    return updated;
  }

  async #setStatus(chatId, status, statusDetail, idleDeadlineAt) {
    const chat = await this.store.update(chatId, current => ({
      ...runtimeWorkflowPatch(current, status),
      status,
      statusDetail,
      ...(status === "running" && !["running", "starting"].includes(current.status) ? { workingStartedAt: nowIso() } : {}),
      idleDeadlineAt,
      idleKeepAwakeReason: null,
      lastActivityAt: nowIso(),
    }));
    if (chat) this.#emit(chatId, { type: "chat_updated", chat });
  }

  async #agentEvent(chatId, event) {
    if (event.type === "assistant_delta") {
      const runtime = this.#runtimes.get(chatId);
      if (runtime?.busy || runtime?.goalTurnActive) runtime.assistantText = (runtime.assistantText || "") + (event.delta || "");
    }
    if (event.type === "task_progress") {
      const chat = this.store.get(chatId);
      if (event.agent === chat?.agent && event.sessionId === chat?.agentSessionId) this.publishChat(await this.store.update(chatId, { taskProgress: event.progress }));
      return;
    }
    if (event.type === "session_details") {
      if (event.details?.agent === this.store.get(chatId)?.agent) this.publishChat(await this.store.update(chatId, { sessionDetails: event.details }));
      return;
    }
    if (event.type === "goal") { this.publishChat(await this.store.update(chatId, { goal: event.goal })); return; }
    if (event.type === "scheduled_work") { await this.refreshActivity(chatId); return; }
    if (event.type === "background_turn") {
      const runtime = this.#runtimes.get(chatId); if (!runtime || runtime.busy) return;
      if (runtime.adapter.isBackgroundBusy?.()) {
        clearTimeout(runtime.idleTimer); runtime.idleTimer = null;
        await this.#setStatus(chatId, "running", "Native background task is working", null);
      } else {
        await this.#scheduleIdleStop(chatId, runtime);
        void this.#drainQueue(chatId);
      }
      return;
    }
    if (event.type === "background_response") {
      const chat = this.store.get(chatId); if (!chat) return;
      const output = extractResponse(event.text || "", chat.autoTitle);
      if (output.title) await this.#agentEvent(chatId, { type: "title", title: output.title });
      const message = await this.store.appendMessage(chatId, { role: event.failed ? "system" : "assistant", agent: chat.agent, kind: event.failed ? "error" : "message", text: output.text });
      this.#emit(chatId, { type: "message", message }); return;
    }
    if (event.type === "goal_turn_started") {
      const runtime = this.#runtimes.get(chatId); if (!runtime) return;
      runtime.goalTurnActive = true;
      runtime.assistantMessageId = newId("msg");
      runtime.assistantText = ""; runtime.assistantPublishedLength = 0; runtime.toolMessages = new Map();
      this.#emit(chatId, { type: "turn_started", messageId: runtime.assistantMessageId }); return;
    }
    if (event.type === "goal_turn_completed") {
      const chat = this.store.get(chatId), runtime = this.#runtimes.get(chatId); if (!chat || !runtime) return;
      runtime.goalTurnActive = false;
      const output = extractResponse(event.text || "", chat.autoTitle);
      if (output.title) await this.#agentEvent(chatId, { type: "title", title: output.title });
      await this.store.update(chatId, { awaitingUser: output.awaitingUser, needsAgentHandoff: false });
      const message = await this.store.appendMessage(chatId, { id: runtime.assistantMessageId, role: "assistant", agent: chat.agent, kind: "message", text: remainingAssistantText(runtime, output.text), ...(runtime.assistantPublishedLength ? { meta: { segmentedTurn: true } } : {}) });
      this.#emit(chatId, { type: "turn_completed", message }); return;
    }
    if (event.type === "native_account_updated") {
      this.commands?.invalidate(chatId);
      this.publishChat(await this.store.update(chatId, { usageAccount: null, rateLimits: null })); return;
    }
    if (event.type === "command_catalog") { await this.#refreshCommandCatalog(chatId, { commandCatalog: event.commands, slashCommands: event.commands.map(command => command.name) }); return; }
    if (event.type === "session_capabilities") {
      await this.#refreshCommandCatalog(chatId, { ...(event.connectors !== undefined ? { connectors: event.connectors } : {}), ...(event.slashCommands !== undefined ? { slashCommands: event.slashCommands } : {}) }); return;
    }
    if (["usage", "context_usage", "rate_limits", "workspace_diff"].includes(event.type)) {
      this.publishChat(await this.store.update(chatId, chat => {
        if (event.type === "usage") return { usage: mergeUsage(chat.usage, event.usage) };
        if (event.type === "context_usage") return { usage: { ...chat.usage, ...event.usage } };
        if (event.type === "rate_limits") return { rateLimits: event.merge ? [...new Map([...(chat.rateLimits || []), ...event.rateLimits].map(limit => [limit.id, limit])).values()] : event.rateLimits };
        return { workspaceDiff: event.diff };
      })); return;
    }
    if (event.type === "request_resolved") {
      const chat = this.store.get(chatId);
      if (chat?.pendingRequest?.requestId === event.requestId) this.publishChat(await this.store.update(chatId, current => ({ pendingRequest: null, ...workflowPatch({ ...current, pendingRequest: null }) })));
    }
    if (event.type === "title") {
      const chat = this.store.get(chatId);
      if (chat?.autoTitle && chat.title !== event.title) this.publishChat(await this.store.update(chatId, { title: event.title }));
      return;
    }
    if (event.type === "tool") {
      const runtime = this.#runtimes.get(chatId);
      // Commit commentary before its actions. Tool completion updates the
      // original row instead of moving it after later commentary.
      const existing = runtime?.toolMessages?.get(event.itemId);
      if (runtime?.busy && !existing) {
        const commentary = (runtime.assistantText || "").slice(runtime.assistantPublishedLength || 0);
        if (commentary.trim()) {
          const message = await this.store.appendMessage(chatId, { role: "assistant", agent: this.store.get(chatId).agent, kind: "message", text: commentary.replace(/^\n+/, "").trimEnd(), meta: { commentary: true, streamId: runtime.assistantMessageId } });
          runtime.assistantPublishedLength = runtime.assistantText.length;
          this.#emit(chatId, { type: "message", message });
        }
      }
      let message;
      if (existing) {
        const updated = await this.store.update(chatId, chat => ({ messages: chat.messages.map(previous => previous.id === existing ? { ...previous, text: event.title, meta: event } : previous) }));
        message = updated.messages.find(message => message.id === existing);
      } else {
        message = await this.store.appendMessage(chatId, { role: "tool", kind: "tool", text: event.title, meta: event });
        if (runtime && event.itemId) { runtime.toolMessages ||= new Map(); runtime.toolMessages.set(event.itemId, message.id); }
      }
      this.#emit(chatId, { type: "message", message });
    } else if (event.type === "notice") {
      const message = await this.store.appendMessage(chatId, {
        role: "system",
        kind: event.level === "error" ? "error" : "notice",
        text: event.text,
      });
      this.#emit(chatId, { type: "message", message });
    }
    this.#emit(chatId, event);
  }

  async #agentRequest(chatId, request) {
    const pendingRequest = publicRequest(request);
    const updated = await this.store.update(chatId, current => ({ pendingRequest, ...workflowPatch({ ...current, pendingRequest }) }));
    this.publishChat(updated);
    this.#emit(chatId, { type: "request", request: pendingRequest });
  }

  async #checkpointStoppedAgentThreads(chatId, runtime, version) {
    // Generic callbacks from retired adapters are fenced. Pull only this
    // explicitly stopped observer's final, sanitized display snapshot, while
    // the same lifecycle and account still own cleanup.
    const chat = this.store.get(chatId), current = this.#runtimes.get(chatId);
    if (!chat || (this.#lifecycleVersions.get(chatId) || 0) !== version
      || runtime.accountBinding !== runtimeAccountBinding(chat) || current && current !== runtime) return;
    const snapshot = runtime.adapter.agents?.snapshot?.();
    if (snapshot?.awake !== false || snapshot.rootThreadId !== chat.agentSessionId) return;
    await this.agentThreads.update(chatId, snapshot);
  }

  #fatal(chatId, error) {
    const runtime = this.#runtimes.get(chatId);
    if (!runtime) return Promise.resolve();
    if (runtime.failure) return runtime.failure;
    const completion = Promise.withResolvers();
    runtime.failure = completion.promise;
    void this.#failRuntime(chatId, runtime, error).then(completion.resolve, completion.reject);
    return completion.promise;
  }

  async #failRuntime(chatId, runtime, error) {
    runtime.failing = true;
    runtime.revoked = true;
    runtime.failureCause = error;
    this.#previewBlocked.add(chatId);
    this.previewActivity.revokeChat(chatId);
    this.emit("preview-revoke", { chatId, reason: "error" });
    this.githubWorkers?.revokeChat(chatId);
    this.#forking.get(chatId)?.controller.abort(error);
    this.workspacePresence.remove(chatId);
    clearTimeout(this.#workspaceIdleTimers.get(chatId)); this.#workspaceIdleTimers.delete(chatId);
    const failureVersion = (this.#lifecycleVersions.get(chatId) || 0) + 1;
    this.#lifecycleVersions.set(chatId, failureVersion);
    runtime.generation += 1;
    if (runtime.idleTimer) clearTimeout(runtime.idleTimer);
    this.broker.revokeChat(chatId);
    this.revokeChatMcps(chatId);
    let checkpointFailed = false;
    try {
      // Keep the exact runtime available to events accepted before its exit.
      // New native events are fenced above; a late send result is generation-
      // fenced by #runTurn. In particular, do not lose the last visible delta
      // when send's normal completion/finally is skipped on worker failure.
      runtime.titleStream?.flush();
      await runtime.eventQueue;
      this.publishChat(await this.store.update(chatId, { queuePaused: true, queueError: errorMessage(error), pendingRequest: null }));
      const chat = this.store.get(chatId);
      const remaining = remainingAssistantText(runtime, runtime.assistantText || "");
      if (chat && remaining && runtime.assistantMessageId && !chat.messages.some(message => message.id === runtime.assistantMessageId)) {
        const message = await this.store.appendMessage(chatId, { id: runtime.assistantMessageId, role: "assistant", agent: chat.agent, kind: "message", text: remaining, meta: { interrupted: true } });
        this.#emit(chatId, { type: "message", message });
      }
    } catch {
      checkpointFailed = true;
      this.#emit(chatId, { type: "runtime_log", text: "The interrupted response could not be saved. Keep the visible transcript before reloading." });
      // A storage failure must not cause an automatic replay of queued work.
      await this.store.update(chatId, { queuePaused: true, pendingRequest: null }).catch(() => {});
    } finally {
      // Cleanup must still revoke the dead runtime if checkpoint storage fails.
      // Keep admission fenced until all old-worker cleanup finishes.
      runtime.cleanupFailed = true;
      try {
        const cleanupErrors = [];
        await this.sideChats.close(chatId).catch(() => {});
        await runtime.adapter.stop().catch(error => cleanupErrors.push(error));
        await this.#checkpointStoppedAgentThreads(chatId, runtime, failureVersion).catch(error => this.#emit(chatId, { type: "runtime_log", text: `Agent snapshot could not be saved: ${errorMessage(error)}` }));
        await this.agentThreads.flush(chatId).catch(error => this.#emit(chatId, { type: "runtime_log", text: `Agent snapshot could not be saved: ${errorMessage(error)}` }));
        try { await this.browsers?.stop(chatId); } catch (error) { cleanupErrors.push(error); }
        const chat = this.store.get(chatId);
        if (chat && chat.agent !== "mock") await this.workerBackend.sleep(chat).then(observed => this.config.workerBackend === "ec2" && runtime.adapter.confirmImportWorkerStopped?.(observed)).catch(error => cleanupErrors.push(error));
        if (cleanupErrors.length) {
          runtime.cleanupError = Object.assign(new Error("Worker cleanup is incomplete. Retry stopping the environment before resuming."), { statusCode: 409 });
          await this.#setStatus(chatId, "error", runtime.cleanupError.message, null);
          this.#emit(chatId, { type: "runtime_error", text: runtime.cleanupError.message });
          return;
        }
        runtime.cleanupFailed = false;
        this.#executors.delete(chatId);
        const detail = errorMessage(error) + (checkpointFailed ? " · Interrupted response could not be saved." : "");
        await this.#setStatus(chatId, "error", detail, null);
        this.#emit(chatId, { type: "runtime_error", text: detail });
      } finally {
        runtime.failed = true;
        runtime.failing = false;
        if (!runtime.cleanupFailed && this.#runtimes.get(chatId) === runtime) this.#runtimes.delete(chatId);
      }
    }
  }

  async #refreshCommandCatalog(chatId, patch = null) {
    let changed = !patch;
    const chat = await this.store.update(chatId, current => {
      if (patch) changed = ["commandCatalog", "slashCommands"].some(key => Object.hasOwn(patch, key) && JSON.stringify(current[key] || []) !== JSON.stringify(patch[key] || []));
      return { ...patch, ...(changed ? { commandCatalogRevision: (current.commandCatalogRevision || 0) + 1 } : {}) };
    });
    if (changed) this.commands?.invalidate(chatId);
    if (chat) this.publishChat(chat);
  }

  #emit(chatId, event, retain = true) {
    const id = (this.#eventIds.get(chatId) || 0) + 1;
    this.#eventIds.set(chatId, id);
    const complete = { id, chatId, at: nowIso(), ...event };
    const history = this.#events.get(chatId) || [];
    if (retain) history.push(complete);
    if (history.length > 300) history.splice(0, history.length - 300);
    this.#events.set(chatId, history);
    this.emit("event", complete);
  }
}
