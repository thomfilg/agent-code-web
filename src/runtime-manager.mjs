import { EventEmitter } from "node:events";
import { clampText, errorMessage, newId, nowIso, redact } from "./utils.mjs";
import { prepareWorkspace, prepareRepositories } from "./workspace.mjs";
import { prepareSoftware, captureWorker } from "./software.mjs";
import { CodexAdapter } from "./adapters/codex.mjs";
import { ClaudeAdapter } from "./adapters/claude.mjs";
import { MockAdapter } from "./adapters/mock.mjs";
import { runtimeWorkflowPatch, workflowPatch } from "../public/chat-organization.js";
import { responsePrompt, extractResponse, ResponseStream } from "./response-protocol.mjs";
import { PullRequestMonitor, inspectBranches, inspectWorkspaceStatus } from "./pull-requests.mjs";
import { handoffPrompt } from "./agent-handoff.mjs";
import { snapshotChanges } from "./workspace-changes.mjs";
import { mergeUsage } from "./session-info.mjs";
import { legacyClaudeContext } from "./legacy-usage.mjs";
import { renderingSample } from "./rendering-sample.mjs";
import { messageCommand } from "./message-command.mjs";
import { ChatPresence } from "./chat-presence.mjs";
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

const ADAPTERS = {
  codex: CodexAdapter,
  claude: ClaudeAdapter,
  mock: MockAdapter,
};

export class RuntimeManager extends EventEmitter {
  #runtimes = new Map();
  #queued = new Set();
  #eventIds = new Map();
  #events = new Map();
  #lifecycleVersions = new Map();
  #switching = new Set();
  #draining = new Map();
  #submissions = new Map();
  #sendingNow = new Map();
  #queueClaims = new Map();
  #executors = new Map();
  #forking = new Map();
  #workspaceIdleTimers = new Map();

  async enqueue(chatId, rawText, attachmentIds = []) {
    const text = clampText(rawText, 100_000, "message");
    if (!this.store.get(chatId)) throw Object.assign(new Error("Chat not found"), { statusCode: 404 });
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
    if (this.#sendingNow.has(chatId)) throw Object.assign(new Error("A queued message is being sent; please wait"), { statusCode: 409 });
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
    if (pending || this.#switching.has(chatId) || chat.status === "stopping") throw Object.assign(new Error("This chat is already changing; please wait"), { statusCode: 409 });
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
        if (adapter) await (adapter.interrupt ? adapter.interrupt() : adapter.stop());
      } catch (error) { turn.cancelled = false; throw error; }
      await turn.done;
      this.#emit(chatId, { type: "turn_interrupted" });
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

  constructor({ store, config, broker, gatewayOrigin, workerBackend = null, adapterFactory = null, github = null, environments = null, models = null, attachments = null, mcps = null, commands = null }) {
    super();
    this.store = store;
    this.config = config;
    this.presence = new ChatPresence({ onChange: chatId => this.refreshActivity(chatId) });
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
    this.environments = environments;
    this.models = models;
    this.attachments = attachments;
    this.mcps = mcps;
    if (this.environments) this.environments.onSaved = environment => {
      for (const chat of this.store.list()) if (chat.environmentId === environment.id) this.mcps?.restrictChat(chat.id, scopeAllows(environment, companyForChat(chat)) ? environment.mcpIds || [] : []);
    };
    this.commands = commands;
    this.pullRequests = new PullRequestMonitor({ store, github, publish: chat => this.publishChat(chat) });
    this.agentThreads = new NativeAgentSnapshots(store, (chatId, snapshot) => this.#emit(chatId, { type: "agent_threads_updated", ...snapshot }, false));
    this.approvals = new CodexApprovals(store, config);
    this.feedback = new CodexFeedback(store, config);
    this.logout = new CodexLogout(store, config);
    this.sideChats = new SideChats({
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
      const runtime = this.#runtimes.get(chatId) || await this.#start(chatId);
      if (version !== (this.#lifecycleVersions.get(chatId) || 0)) throw new Error("Side chat cancelled because the worker stopped");
      if (!runtime.adapter.forkSide) throw new Error("This worker does not support temporary side chats");
      clearTimeout(runtime.idleTimer); runtime.idleTimer = null;
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
      const runtime = this.#runtimes.get(chatId) || await this.#start(chatId);
      if (version !== (this.#lifecycleVersions.get(chatId) || 0)) throw new Error("Agent action cancelled because the worker stopped");
      const agents = runtime.adapter.agents;
      if (!agents) throw new Error("This worker does not support native agent navigation");
      if (action === "messages" && (runtime.adapter.plugins?.changing || runtime.adapter.plugins?.needsRefresh)) throw Object.assign(new Error("Refresh /plugins to finish reconciling the plugin change before sending to an agent"), { statusCode: 409 });
      if (action === "messages" && (runtime.adapter.hookControls?.changing || runtime.adapter.hookControls?.needsRefresh)) throw Object.assign(new Error("Refresh /hooks to finish reconciling the hook change before sending to an agent"), { statusCode: 409 });
      if (action === "messages" && (runtime.adapter.featureControls?.changing || runtime.adapter.featureControls?.needsRefresh)) throw Object.assign(new Error("Refresh /experimental to finish reconciling the feature change before sending to an agent"), { statusCode: 409 });
      if (action === "messages" && (runtime.adapter.memoryControls?.changing || runtime.adapter.memoryControls?.needsRefresh)) throw Object.assign(new Error("Refresh /memories to finish reconciling the memory change before sending to an agent"), { statusCode: 409 });
      if (action === "messages") await this.#assertImportReady(chatId);
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
      const current = this.store.get(chatId);
      if (version !== (this.#lifecycleVersions.get(chatId) || 0) || !current || current.agent !== chat.agent || companyForChat(current) !== companyForChat(chat) || current.ownerId !== chat.ownerId) throw Object.assign(new Error("The app request was cancelled because the chat changed or stopped"), { statusCode: 409 });
      return current;
    };
    try {
      const runtime = this.#runtimes.get(chatId) || await this.#start(chatId);
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

  async nativeLogout(chatId, action = "status", input = {}, guard = () => {}) {
    guard(); const chat = this.store.get(chatId);
    if (!chat) throw Object.assign(new Error("Chat not found"), { statusCode: 404 });
    if (chat.agent !== "codex") throw new Error("Native sign-out requires Codex");
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
      if (version !== (this.#lifecycleVersions.get(chatId) || 0) || !current || current.archived || current.agent !== chat.agent || current.ownerId !== chat.ownerId || current.environmentId !== chat.environmentId || companyForChat(current) !== companyForChat(chat) || mutation && current.agentSessionId !== input.threadId) throw Object.assign(new Error("The import request was cancelled because the chat changed or stopped"), { statusCode: 409 });
    };
    try {
      const runtime = this.#runtimes.get(chatId) || await this.#start(chatId); check();
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
      if (source.environmentId) await this.environments.runtime(source.environmentId, source); guard();
      imported = await runtime.adapter.forkImportedSession(input.operationId, input.sessionId, guard); guard();
      validateSessionBundle(imported.bundle);
      const chat = await this.store.create({ title: selected.title.slice(0, 120), ownerId: source.ownerId, agent: "codex", source: source.source, repositories: source.repositories,
        environmentId: source.environmentId, environmentName: source.environmentName, model: source.model, effort: source.effort, modelSelectionSet: source.modelSelectionSet, autoTitle: false }, async target => {
        targetId = target.id;
        await snapshotWorkspace({ executor: runtime.executor, source: runtime.executor?.workspace || source.workspace, destination: target.workspace, signal: action.controller.signal }); guard();
        const images = await copyImportedImages(imported.messages, runtime.executor?.workspace || source.workspace, target.workspace, guard);
        const attached = await this.attachments.importTranscript(target.id, images.messages); guard();
        await this.store.records.put("native-fork", target.id, { chatId: target.id, bundle: imported.bundle, paths: attached.paths, authMode: this.config.codex.authMode, initialized: false }); guard();
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
      if (version !== (this.#lifecycleVersions.get(chatId) || 0) || !current || current.archived || current.agent !== chat.agent || current.ownerId !== chat.ownerId || companyForChat(current) !== companyForChat(chat) || (mutation && current.agentSessionId !== input.threadId)) throw Object.assign(new Error(`The ${kind} request was cancelled because the chat changed or stopped`), { statusCode: 409 });
    };
    try {
      const runtime = this.#runtimes.get(chatId) || await this.#start(chatId); check();
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
    const chat = this.store.get(chatId), runtime = this.#runtimes.get(chatId);
    if (!chat || !runtime || chat.archived) throw new Error("The side chat's worker is not available");
    const files = this.attachments ? await this.attachments.resolve(chatId, attachmentIds) : [];
    const settings = this.models ? await this.models.turnSettings(chat) : {};
    const materialized = files.length ? await this.attachments.materialize(chat, runtime.executor, files) : [];
    const workspace = runtime.executor?.workspace || chat.workspace;
    const attached = attachmentPrompt(materialized, workspace);
    const prompt = first ? handoffPrompt({ ...chat, messages: [...chat.messages, {}] }, text + attached) : text + attached;
    return { prompt, settings: { ...settings, ...contextForTurn(files, workspace), appReferences: appReferencesForTurn(chat, files, companyForChat(chat)), mode: chat.mode || "accept_edits", images: materialized.filter(file => /^image\/(png|jpeg|webp|gif)$/.test(file.mime)).map(file => file.path) } };
  }

  availableAgents() {
    return [
      {
        id: "codex",
        label: "Codex",
        enabled: this.config.codex.authMode === "host" || Boolean(this.config.codex.providerKey),
        authMode: this.config.codex.authMode,
      },
      {
        id: "claude",
        label: "Claude Code",
        enabled: this.config.claude.authMode === "host" || Boolean(this.config.claude.providerKey),
        authMode: this.config.claude.authMode,
      },
      ...(this.config.enableMock ? [{ id: "mock", label: "Mock agent", enabled: true, authMode: "none" }] : []),
    ];
  }

  isBusy(chatId) { return this.#sendingNow.has(chatId) || this.#switching.has(chatId) || this.#queued.has(chatId) || Boolean(this.#runtimes.get(chatId)?.busy) || this.#importPending(chatId); }
  publishChat(chat) { if (chat) this.#emit(chat.id, { type: "chat_updated", chat }); }

  // A viewer may wake the worker without starting an LLM turn. Share this lease
  // with agent startup so opening Chrome cannot create a second EC2 instance.
  async browserExecutor(chatId) {
    const chat = this.store.get(chatId);
    if (!chat) throw Object.assign(new Error("Chat not found"), { statusCode: 404 });
    if (this.#executors.has(chatId)) return this.#executors.get(chatId);
    const version = this.#lifecycleVersions.get(chatId) || 0;
    const pending = (async () => {
      if (chat.environmentId) await this.environments.runtime(chat.environmentId, chat);
      if (chat.repositories?.length && !chat.workspaceReady) {
        await prepareRepositories({ destination: chat.workspace, repositories: chat.repositories, getToken: repository => this.github.tokenForRepository(repository, chat),
          onProgress: detail => this.#setStatus(chatId, "starting", detail, null) });
        await this.store.update(chatId, { workspaceReady: true });
      }
      const executor = await this.workerBackend.acquire(this.store.get(chatId));
      if ((this.#lifecycleVersions.get(chatId) || 0) !== version) throw Object.assign(new Error("Worker startup cancelled"), { name: "AbortError" });
      if (executor?.metadata) await this.store.update(chatId, { runtimeMetadata: executor.metadata });
      return executor;
    })();
    this.#executors.set(chatId, pending);
    try { return await pending; } catch (error) { if (this.#executors.get(chatId) === pending) this.#executors.delete(chatId); throw error; }
  }

  async browserIdle(chatId) {
    // A browser-only wake must release its EC2 lease too. Otherwise the cloud
    // watchdog can stop the VM behind a cached executor, breaking the next open.
    if (!this.#runtimes.has(chatId) && !this.isBusy(chatId) && !this.workspacePresence.has(chatId) && !this.browsers?.entries.has(chatId) && this.store.get(chatId)) await this.stop(chatId, "idle-timeout");
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
    return { active: this.presence.has(chatId), expiresInMs: this.presence.ttlMs };
  }

  async refreshActivity(chatId) {
    const runtime = this.#runtimes.get(chatId);
    if (runtime && !runtime.busy && this.store.get(chatId)?.status === "idle") await this.#scheduleIdleStop(chatId, runtime);
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

  async switchAgent(chatId, agent) {
    const chat = this.store.get(chatId);
    if (!chat) throw Object.assign(new Error("Chat not found"), { statusCode: 404 });
    if (!this.availableAgents().some(item => item.id === agent && item.enabled)) throw new Error("Choose an enabled agent");
    if (this.isBusy(chatId) || chat.status === "stopping") throw Object.assign(new Error("Stop the working agent before switching"), { statusCode: 409 });
    if (agent === chat.agent) return chat;
    this.#switching.add(chatId);
    try {
      const settings = this.models ? await this.models.creationSettings(agent) : { model: this.config[agent]?.model || null, effort: this.config[agent]?.effort || null };
      await this.stop(chatId, "agent-switch");
      const updated = await this.store.update(chatId, current => ({ agent, ...settings, modelSelectionSet: true,
        agentSessionId: null, needsAgentHandoff: true, pendingRequest: null, awaitingUser: false,
        nativeForkSessionId: null, forkGoalPending: false, forkContextPending: false, goal: null,
        usage: null, usageAccount: null, rateLimits: null, sessionDetails: null, connectors: null, slashCommands: [], commandCatalog: [],
        messages: current.messages.map(message => ["assistant", "tool"].includes(message.role) ? { ...message, agent: message.agent || current.agent } : message),
        statusDetail: `Switched to ${agent === "claude" ? "Claude Code" : agent === "codex" ? "Codex" : "Mock"}. Conversation and workspace retained.`,
        ...workflowPatch({ ...current, awaitingUser: false, pendingRequest: null }),
      }));
      this.publishChat(updated);
      return updated;
    } finally { this.#switching.delete(chatId); }
  }

  async setModel(chatId, input) {
    if (this.#switching.has(chatId)) throw Object.assign(new Error("Wait for the agent switch to finish"), { statusCode: 409 });
    const chat = this.store.get(chatId);
    if (!chat) throw Object.assign(new Error("Chat not found"), { statusCode: 404 });
    const settings = await this.models.validate(chat.agent, input);
    if (this.#switching.has(chatId) || this.store.get(chatId)?.agent !== chat.agent) throw Object.assign(new Error("The agent changed; select its model again"), { statusCode: 409 });
    const updated = await this.store.update(chatId, { ...settings, modelSelectionSet: true });
    this.publishChat(updated); return updated;
  }

  async setMode(chatId, mode) {
    if (!["auto", "accept_edits", "plan"].includes(mode)) throw new Error("Choose Auto, Accept edits, or Plan");
    const updated = await this.store.update(chatId, { mode });
    if (!updated) throw Object.assign(new Error("Chat not found"), { statusCode: 404 });
    this.publishChat(updated); return updated;
  }

  async addRepository(chatId, selection) {
    const chat = this.store.get(chatId);
    if (!chat) throw Object.assign(new Error("Chat not found"), { statusCode: 404 });
    if (this.isBusy(chatId) || chat.status === "stopping") throw Object.assign(new Error("Stop the working agent before adding a repository"), { statusCode: 409 });
    if (chat.source) throw new Error("Adding repositories is supported for picker-based or scratch chats, not legacy single-repository clones");
    if ((chat.repositories?.length || 0) >= 100) throw new Error("A chat supports up to 100 repositories");
    this.#switching.add(chatId);
    try {
      const [repository] = await this.github.resolveSelections([selection], { company: companyForChat(chat) || undefined });
      if (chat.repositories?.some(repo => repo.fullName.toLowerCase() === repository.fullName.toLowerCase())) throw new Error("This repository is already in the chat");
      if (chat.environmentId) await this.environments.runtime(chat.environmentId, { ...chat, repositories: [...(chat.repositories || []), repository] });
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
      agent: chat.agent, model: chat.model, authMode: this.config[chat.agent]?.authMode || "none", account: chat.usageAccount || null, snapshot: !awake, recordedAt: chat.usage?.recordedAt || null,
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
    const allowed = this.availableAgents().filter((agent) => agent.enabled).map((agent) => agent.id);
    const agent = input.agent || allowed[0];
    if (!allowed.includes(agent)) throw new Error(`agent is not enabled: ${agent}`);
    const title = input.title ? clampText(input.title, 120, "title") : agent === "mock" ? "New mock conversation" : "New conversation";
    const source = typeof input.source === "string" ? input.source.trim() : this.config.workspaceSource;
    const workspaceIdentity = { repositories: input.repositories || [], source: input.repositories?.length ? "" : source };
    const environment = input.environmentId ? await this.environments?.runtime(input.environmentId, workspaceIdentity) : null;
    if (environment?.archived) throw new Error("Choose an environment that is not archived");
    if (environment && environment.backend !== this.config.workerBackend) throw new Error(`This server uses ${this.config.workerBackend} workers. Select an environment with that backend.`);
    const repositories = input.repositories ? await this.github.resolveSelections(input.repositories) : [];
    const modelSettings = this.models ? await this.models.creationSettings(agent, input) : {};
    const chat = await this.store.create({ title, agent, ownerId, ...modelSettings, modelSelectionSet: Object.hasOwn(input, "model") || Object.hasOwn(input, "effort"), source: repositories.length ? "" : source, repositories,
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
      if (source.environmentId) await this.environments.runtime(source.environmentId, source);
      signal.throwIfAborted();
      action.workspaceOnly = !source.agentSessionId && !source.nativeForkSessionId;
      runtime = action.workspaceOnly ? { executor: await this.browserExecutor(source.id) } : this.#runtimes.get(source.id) || await this.#start(source.id);
      signal.throwIfAborted();
      if (!action.workspaceOnly && !runtime.adapter.forkSession) throw new Error("This worker does not support persistent native forks");
      clearTimeout(runtime.idleTimer); runtime.idleTimer = null;
      await this.refreshActivity(source.id);
      const copy = await this.store.create({ title, ownerId: source.ownerId || ownerId, agent: source.agent, model: source.model, effort: source.effort, modelSelectionSet: source.modelSelectionSet,
        source: source.source, repositories: source.repositories, environmentId: source.environmentId, environmentName: source.environmentName, autoTitle: false }, async target => {
        targetId = target.id;
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
        await this.store.records.put("native-fork", target.id, { chatId: target.id, bundle, paths: attached.paths, authMode: this.config.codex.authMode, initialized: !bundle });
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
    const text = clampText(rawText, 100_000, "message");
    const chat = this.store.get(chatId);
    if (!chat) throw Object.assign(new Error("chat not found"), { statusCode: 404 });
    const commandAction = approval ? { type: "approvalRetry", approval,
      prompt: "I confirmed the specific denied action recorded by the native approval immediately before this message. Retry that exact action once in the same context, using the current permission policy. Do not broaden the operation, change permissions, or treat this as permission for other actions. If the action is no longer appropriate or still denied, explain and stop this retry." } : messageCommand(chat.agent, text);
    if (chat.workflowState === "archived") throw Object.assign(new Error("Unarchive this chat before sending a message"), { statusCode: 409 });
    if (this.#switching.has(chatId) || this.#queued.has(chatId) || this.#runtimes.get(chatId)?.busy || (this.#sendingNow.has(chatId) && this.#sendingNow.get(chatId) !== queueAction)) {
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
      if (chat.environmentId) await this.environments.runtime(chat.environmentId, chat);
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
    await this.#setStatus(chatId, "running", "Agent is working", null);
    this.#emit(chatId, { type: "turn_started", messageId: assistantMessageId });

    try {
      if (turn.cancelled) return;
      if (commandAction?.type === "compact") {
        if (!runtime.adapter.compact) throw new Error("This worker does not expose native compaction. Update its Codex CLI.");
        await this.#setStatus(chatId, "running", "Compacting context", null);
        await runtime.adapter.compact(); await runtime.eventQueue;
        if (turn.cancelled || runtime.generation !== generation) return;
        const message = await this.store.appendMessage(chatId, { role: "system", kind: "notice", text: "Context compacted." });
        this.#emit(chatId, { type: "turn_completed", message }); return;
      }
      if (commandAction?.type === "plan") this.publishChat(await this.store.update(chatId, { mode: "plan" }));
      if (["settings", "fast"].includes(commandAction?.type)) {
        const current = this.store.get(chatId);
        const fastContext = Object.hasOwn(current, "serviceTier") ? current : { ...current, serviceTier: runtime.adapter.settings?.serviceTier };
        const settings = commandAction.type === "fast" ? await this.models.fastSettings(fastContext, commandAction.action) : commandAction.settings;
        if (Object.hasOwn(settings, "mode")) await this.setMode(chatId, settings.mode);
        else await this.setModel(chatId, { model: current.model || null, effort: Object.hasOwn(settings, "model") ? null : current.effort || null, ...settings });
        const message = await this.store.appendMessage(chatId, { role: "system", kind: "notice", text: Object.entries(settings).map(([key, value]) => `${key}: ${value || "default"}`).join(" · ") });
        this.#emit(chatId, { type: "turn_completed", message }); return;
      }
      if (commandAction?.type === "goal") {
        if (commandAction.action !== "get") await this.store.update(chatId, { forkGoalPending: false });
        if (!runtime.adapter.goalAction) throw new Error("This Codex worker does not expose goal controls. Update its CLI to a version with thread/goal support.");
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
      const settings = this.models ? await this.models.turnSettings(this.store.get(chatId)) : {};
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
      const send = () => runtime.adapter.send(claude ? raw : metadata ? responsePrompt(prompt, automaticTitle) : prompt, {
        ...settings, ...explicitContext, appReferences: appReferencesForTurn(currentChat, files, companyForChat(currentChat)), ...(skill ? { skills: [skill] } : {}),
        ...(commandAction?.type === "review" ? { reviewTarget: commandAction.target } : {}),
        ...(commandAction?.type === "goal" ? { goalDirective: commandAction } : currentChat.forkGoalPending && currentChat.mode !== "plan" && commandAction?.type !== "review" ? { goalDirective: { action: "resume", fork: true } } : {}),
        ...(claude ? { systemPrompt: responsePrompt("", automaticTitle) + (currentChat.needsAgentHandoff ? handoffPrompt(currentChat, "") : "") + browserPrompt } : {}),
        mode: currentChat.mode || "accept_edits", images: materialized.filter(file => /^image\/(png|jpeg|webp|gif)$/.test(file.mime)).map(file => file.path) });
      const result = commandAction?.approval ? await this.approvals.retry(chatId, commandAction.approval, runtime.adapter, send, () => {
        if (turn.cancelled || runtime.generation !== generation || this.#runtimes.get(chatId) !== runtime) throw Object.assign(new Error("Approval retry cancelled because the chat stopped"), { name: "AbortError" });
        runtime.adapter.assertInputReady?.();
      }) : await send();
      if (turn.cancelled || runtime.generation !== generation) return;
      runtime.titleStream?.flush();
      await runtime.eventQueue;
      if (!result.turnsHandled) {
      const output = metadata ? extractResponse(result.text || "", automaticTitle) : { text: result.text || "", title: null, awaitingUser: false };
      if (output.title) await this.#agentEvent(chatId, { type: "title", title: output.title });
      await this.store.update(chatId, { awaitingUser: output.awaitingUser, needsAgentHandoff: false });
      const message = await this.store.appendMessage(chatId, {
        id: assistantMessageId,
        role: "assistant",
        agent: this.store.get(chatId).agent,
        kind: "message",
        text: output.text,
      });
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
      runtime.titleStream = null;
      if (runtime.generation === generation && this.#runtimes.get(chatId) === runtime) {
        runtime.busy = false;
        await this.#scheduleIdleStop(chatId, runtime);
        this.pullRequests.refresh(chatId).catch(() => {});
      }
    }
  }

  async stop(chatId, reason = "manual") {
    const chat = this.store.get(chatId);
    if (!chat) throw Object.assign(new Error("chat not found"), { statusCode: 404 });
    this.#lifecycleVersions.set(chatId, (this.#lifecycleVersions.get(chatId) || 0) + 1);
    this.workspacePresence.remove(chatId);
    clearTimeout(this.#workspaceIdleTimers.get(chatId)); this.#workspaceIdleTimers.delete(chatId);
    this.#forking.get(chatId)?.controller.abort(Object.assign(new Error("Fork cancelled because the source chat stopped"), { name: "AbortError", statusCode: 409 }));
    this.mcps?.revokeChat(chatId);
    this.publishChat(await this.store.update(chatId, { queuePaused: true, ...(reason === "manual" ? { forkGoalPending: false } : {}) }));
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
      await runtime.eventQueue; // Flush final context/usage before worker storage disappears.
      await this.agentThreads.flush(chatId).catch(error => this.#emit(chatId, { type: "runtime_log", text: `Agent snapshot could not be saved: ${errorMessage(error)}` }));
    }
    else await this.sideChats.close(chatId).catch(error => this.#emit(chatId, { type: "runtime_log", text: `Side stop warning: ${errorMessage(error)}` }));
    await this.browsers?.stop(chatId);
    const executor = this.#executors.get(chatId);
    if (executor) await executor.catch(() => {});
    this.#executors.delete(chatId);
    try {
      const observed = chat.agent !== "mock" ? await this.workerBackend.sleep(chat) : null;
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
      const runtime = this.#runtimes.get(chatId) || await this.#start(chatId);
      if (version !== (this.#lifecycleVersions.get(chatId) || 0)) throw new Error("Goal action cancelled because the chat was stopped");
      if (!runtime.adapter.goalAction) throw new Error("This worker does not support goal controls");
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
    this.presence.clear();
    this.workspacePresence.clear();
    for (const timer of this.#workspaceIdleTimers.values()) clearTimeout(timer);
    this.#workspaceIdleTimers.clear();
    await this.pullRequests.stop();
    await Promise.allSettled([...new Set([...this.#runtimes.keys(), ...this.#executors.keys()])].map((chatId) => this.stop(chatId, "shutdown")));
    await this.browsers?.shutdown();
  }

  async #start(chatId) {
    const chat = this.store.get(chatId);
    const version = this.#lifecycleVersions.get(chatId) || 0;
    const checkCancelled = () => { if ((this.#lifecycleVersions.get(chatId) || 0) !== version) throw Object.assign(new Error("Worker startup cancelled"), { name: "AbortError" }); };
    await this.#setStatus(chatId, "starting", "Starting isolated agent runtime", null);
    let runtime;
    let executor;
    let forkRecord;
    let savedAgentThreads;
    let forkContext = "";
    const hooks = {
      onAgentThreads: snapshot => {
        void this.agentThreads.update(chatId, snapshot)?.catch(error => this.#emit(chatId, { type: "runtime_log", text: `Agent snapshot: ${errorMessage(error)}` }));
        void this.refreshActivity(chatId);
      },
      onEvent: (event) => {
        if (event.type === "native_approval_denied") {
          if (this.#runtimes.get(chatId) !== runtime) return runtime.eventQueue;
          const observed = { ...chat, agentSessionId: runtime.adapter.threadId }, binding = this.approvals.binding(observed);
          runtime.eventQueue = runtime.eventQueue.then(() => this.approvals.capture(chatId, event.report, binding))
            .catch(() => this.#emit(chatId, { type: "runtime_log", text: "A native denial could not be safely retained for /approve. No approval was granted." }));
          return runtime.eventQueue;
        }
        if (event.type === "goal_turn_completed") runtime.titleStream?.flush();
        if (event.type === "goal_turn_started") runtime.titleStream = new ResponseStream(delta => { runtime.eventQueue = runtime.eventQueue.then(() => this.#agentEvent(chatId, delta)); }, this.store.get(chatId)?.autoTitle);
        if (event.type === "assistant_delta" && runtime.titleStream) { runtime.titleStream.delta(event.delta || ""); return runtime.eventQueue; }
        runtime.eventQueue = runtime.eventQueue.then(() => this.#agentEvent(chatId, event));
        return runtime.eventQueue;
      },
      onRequest: (request) => {
        runtime.eventQueue = runtime.eventQueue.then(() => this.#agentRequest(chatId, request));
        return runtime.eventQueue;
      },
      onSessionId: async (agentSessionId) => {
        await this.store.update(chatId, { agentSessionId });
      },
      onForkRestored: async () => {
        if (forkRecord && !forkRecord.initialized) await this.store.records.put("native-fork", chatId, { ...forkRecord, initialized: true });
      },
      onInputStarted: async ({ forkGoal }) => {
        const current = this.store.get(chatId);
        if (current?.forkContextPending || forkGoal && current?.forkGoalPending) await this.store.update(chatId, { forkContextPending: false, ...(forkGoal ? { forkGoalPending: false } : {}) });
      },
      onLog: (text) => this.#emit(chatId, { type: "runtime_log", text }),
      onFatal: (error) => this.#fatal(chatId, error).catch((fatalError) => console.error("runtime fatal handler:", errorMessage(fatalError))),
    };
    const Adapter = ADAPTERS[chat.agent];
    if (!Adapter) throw new Error(`unsupported agent: ${chat.agent}`);
    try {
      checkCancelled();
      savedAgentThreads = chat.agent === "codex" ? await this.agentThreads.get(chatId) : null;
      if (chat.nativeForkSessionId || chat.forkedFromChatId && chat.forkContextPending) {
        forkRecord = await this.store.records?.get("native-fork", chatId);
        if (!forkRecord || chat.agent !== "codex" || forkRecord.chatId !== chatId || forkRecord.authMode !== this.config.codex.authMode || chat.nativeForkSessionId && (forkRecord.bundle?.threadId !== chat.agentSessionId || chat.nativeForkSessionId !== chat.agentSessionId)) throw new Error("This fork's private native history or original authentication mode is unavailable");
        if (chat.nativeForkSessionId) validateSessionBundle(forkRecord.bundle, chat.agentSessionId);
      }
      executor = chat.agent === "mock" ? null : await this.browserExecutor(chatId);
      if (executor?.metadata) await this.store.update(chatId, { runtimeMetadata: executor.metadata });
      checkCancelled();
      if (executor && chat.environmentId) {
        const environment = await this.environments.runtime(chat.environmentId, chat);
        if (environment.backend !== this.config.workerBackend) throw new Error("The environment backend changed. Use the original worker backend to resume this chat.");
        await prepareSoftware(executor, environment, detail => this.#setStatus(chatId, "starting", detail, null));
        executor.environmentVariables = { ...environment.variables, ...executor.capabilityVariables };
        executor.mcpServers = await this.mcps?.runtime(chatId, environment.mcpIds || [], executor.gatewayOrigin || this.gatewayOrigin, chat) || {};
        if (environment.setupScript) {
          await this.#setStatus(chatId, "starting", "Running environment setup script", null);
          try {
            await captureWorker(executor, "/bin/bash", ["-e", "-c", environment.setupScript], { cwd: executor.workspace,
              env: { ...executor.environmentVariables, PATH: executor.environmentPath || process.env.PATH, HOME: executor.runtimeHome, LANG: "C.UTF-8", CI: "1" } });
          } catch { throw new Error("Environment setup script failed. Review the script and its agent-readable variables. Protected variables are not available to setup scripts."); }
        }
      }
      if (executor && this.browsers) executor.mcpServers = { ...executor.mcpServers, ...this.browsers.runtime(chatId, executor.gatewayOrigin || this.gatewayOrigin) };
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
      this.mcps?.revokeChat(chatId);
      await this.browsers?.stop(chatId);
      this.#executors.delete(chatId);
      if (executor) await this.workerBackend.sleep(chat).catch(() => {});
      if (error.name !== "AbortError") await this.#setStatus(chatId, "error", errorMessage(error), null);
      throw error;
    }
    const adapter = this.adapterFactory
      ? this.adapterFactory({ chat, hooks, executor, restoreFork: forkRecord && !forkRecord.initialized ? forkRecord.bundle : null, savedAgentThreads })
      : new Adapter({ chat, store: this.store, config: this.config, broker: this.broker, gatewayOrigin: this.gatewayOrigin, executor, hooks, restoreFork: forkRecord && !forkRecord.initialized ? forkRecord.bundle : null, savedAgentThreads });
    runtime = { adapter, executor, forkContext, busy: false, idleTimer: null, generation: 0, eventQueue: Promise.resolve() };
    this.#runtimes.set(chatId, runtime);
    try {
      await adapter.start();
      checkCancelled();
      await this.#setStatus(chatId, "idle", "Runtime ready", null);
      this.#emit(chatId, { type: "runtime_started", agent: chat.agent });
      return runtime;
    } catch (error) {
      this.#runtimes.delete(chatId);
      this.mcps?.revokeChat(chatId);
      await this.browsers?.stop(chatId);
      this.#executors.delete(chatId);
      await adapter.stop().catch(() => {});
      if (chat.agent !== "mock") await this.workerBackend.sleep(chat).catch(() => {});
      if (error.name !== "AbortError") await this.#setStatus(chatId, "error", errorMessage(error), null);
      throw error;
    }
  }

  async #scheduleIdleStop(chatId, runtime) {
    clearTimeout(runtime.idleTimer); runtime.idleTimer = null;
    if (this.#runtimes.get(chatId) !== runtime || runtime.busy) return;
    const reason = this.#importPending(chatId) ? "import" : this.#forking.has(chatId) ? "fork" : runtime.adapter.agents?.busy() ? "agents" : this.sideChats.busy(chatId) ? "side" : this.browsers?.hasViewers(chatId) ? "browser" : this.workspacePresence.has(chatId) ? "workspace" : this.presence.has(chatId) ? "tab" : null;
    const chat = this.store.get(chatId);
    if (reason) {
      if (chat?.idleKeepAwakeReason !== reason || chat?.idleDeadlineAt || chat?.status !== "idle") {
        const updated = await this.store.update(chatId, current => ({ ...runtimeWorkflowPatch(current, "idle"), status: "idle", statusDetail: reason === "import" ? "Sleep paused until the import is reconciled" : reason === "fork" ? "Creating an independent fork" : reason === "agents" ? "Sleep paused while child agents are working" : reason === "side" ? "Sleep paused while the side chat is working" : reason === "browser" ? "Sleep paused while you're using Chrome" : reason === "workspace" ? "Sleep paused while the workspace viewer is open" : "Sleep paused while this chat tab is visible", idleDeadlineAt: null, idleKeepAwakeReason: reason }));
        if (updated) this.publishChat(updated);
      }
      return;
    }
    const deadline = new Date(Date.now() + this.config.idleTimeoutMs).toISOString();
    await this.#setStatus(chatId, "idle", "Waiting for another message", deadline);
    runtime.idleTimer = setTimeout(() => {
      if (this.#importPending(chatId) || this.#forking.has(chatId) || runtime.adapter.agents?.busy() || this.sideChats.busy(chatId) || this.browsers?.hasViewers(chatId) || this.workspacePresence.has(chatId) || this.presence.has(chatId)) { void this.#scheduleIdleStop(chatId, runtime); return; }
      if (this.#runtimes.get(chatId) !== runtime || runtime.busy) return;
      this.stop(chatId, "idle-timeout").catch((error) => this.#fatal(chatId, error));
    }, this.config.idleTimeoutMs);
    runtime.idleTimer.unref?.();
  }

  async #setStatus(chatId, status, statusDetail, idleDeadlineAt) {
    const chat = await this.store.update(chatId, current => ({
      ...runtimeWorkflowPatch(current, status),
      status,
      statusDetail,
      idleDeadlineAt,
      idleKeepAwakeReason: null,
      lastActivityAt: nowIso(),
    }));
    if (chat) this.#emit(chatId, { type: "chat_updated", chat });
  }

  async #agentEvent(chatId, event) {
    if (event.type === "session_details") {
      if (event.details?.agent === this.store.get(chatId)?.agent) this.publishChat(await this.store.update(chatId, { sessionDetails: event.details }));
      return;
    }
    if (event.type === "goal") { this.publishChat(await this.store.update(chatId, { goal: event.goal })); return; }
    if (event.type === "goal_turn_started") {
      const runtime = this.#runtimes.get(chatId); if (!runtime) return;
      runtime.assistantMessageId = newId("msg");
      this.#emit(chatId, { type: "turn_started", messageId: runtime.assistantMessageId }); return;
    }
    if (event.type === "goal_turn_completed") {
      const chat = this.store.get(chatId), runtime = this.#runtimes.get(chatId); if (!chat || !runtime) return;
      const output = extractResponse(event.text || "", chat.autoTitle);
      if (output.title) await this.#agentEvent(chatId, { type: "title", title: output.title });
      await this.store.update(chatId, { awaitingUser: output.awaitingUser, needsAgentHandoff: false });
      const message = await this.store.appendMessage(chatId, { id: runtime.assistantMessageId, role: "assistant", agent: chat.agent, kind: "message", text: output.text });
      this.#emit(chatId, { type: "turn_completed", message }); return;
    }
    if (event.type === "native_account_updated") {
      this.commands?.invalidate(chatId);
      this.publishChat(await this.store.update(chatId, { usageAccount: null, rateLimits: null })); return;
    }
    if (event.type === "command_catalog") { this.publishChat(await this.store.update(chatId, { commandCatalog: event.commands })); return; }
    if (["usage", "context_usage", "rate_limits", "workspace_diff", "session_capabilities"].includes(event.type)) {
      this.publishChat(await this.store.update(chatId, chat => {
        if (event.type === "usage") return { usage: mergeUsage(chat.usage, event.usage) };
        if (event.type === "context_usage") return { usage: { ...chat.usage, ...event.usage } };
        if (event.type === "rate_limits") return { rateLimits: event.merge ? [...new Map([...(chat.rateLimits || []), ...event.rateLimits].map(limit => [limit.id, limit])).values()] : event.rateLimits };
        return event.type === "workspace_diff" ? { workspaceDiff: event.diff } : { connectors: event.connectors, slashCommands: event.slashCommands };
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
    if (event.type === "tool" && event.state === "completed") {
      const message = await this.store.appendMessage(chatId, {
        role: "tool",
        kind: "tool",
        text: event.title,
        meta: event,
      });
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

  async #fatal(chatId, error) {
    this.#forking.get(chatId)?.controller.abort(error);
    this.workspacePresence.remove(chatId);
    clearTimeout(this.#workspaceIdleTimers.get(chatId)); this.#workspaceIdleTimers.delete(chatId);
    const runtime = this.#runtimes.get(chatId);
    if (!runtime) return;
    runtime.generation += 1;
    if (runtime.idleTimer) clearTimeout(runtime.idleTimer);
    this.#runtimes.delete(chatId);
    await this.sideChats.close(chatId).catch(() => {});
    this.broker.revokeChat(chatId);
    this.mcps?.revokeChat(chatId);
    await runtime.adapter.stop().catch(() => {});
    await this.agentThreads.flush(chatId).catch(error => this.#emit(chatId, { type: "runtime_log", text: `Agent snapshot could not be saved: ${errorMessage(error)}` }));
    await this.browsers?.stop(chatId);
    this.#executors.delete(chatId);
    const chat = this.store.get(chatId);
    if (chat && chat.agent !== "mock") await this.workerBackend.sleep(chat).then(observed => this.config.workerBackend === "ec2" && runtime.adapter.confirmImportWorkerStopped?.(observed)).catch(() => {});
    await this.#setStatus(chatId, "error", errorMessage(error), null);
    this.#emit(chatId, { type: "runtime_error", text: errorMessage(error) });
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
