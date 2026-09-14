import { EventEmitter } from "node:events";
import { clampText, errorMessage, newId, nowIso, redact } from "./utils.mjs";
import { prepareWorkspace, prepareRepositories } from "./workspace.mjs";
import { prepareSoftware, captureWorker } from "./software.mjs";
import { CodexAdapter } from "./adapters/codex.mjs";
import { ClaudeAdapter } from "./adapters/claude.mjs";
import { MockAdapter } from "./adapters/mock.mjs";
import { runtimeWorkflowPatch, workflowPatch } from "../public/chat-organization.js";
import { responsePrompt, extractResponse, ResponseStream } from "./response-protocol.mjs";
import { PullRequestMonitor, inspectBranches } from "./pull-requests.mjs";
import { handoffPrompt } from "./agent-handoff.mjs";
import { snapshotChanges } from "./workspace-changes.mjs";
import { mergeUsage } from "./session-info.mjs";
import { legacyClaudeContext } from "./legacy-usage.mjs";

const ADAPTERS = {
  codex: CodexAdapter,
  claude: ClaudeAdapter,
  mock: MockAdapter,
};

function publicRequest(request) {
  if (!request) return null;
  const params = request.params || {};
  return {
    requestId: request.requestId,
    method: request.method,
    createdAt: nowIso(),
    prompt: redact(params.reason || params.command || "Agent needs your input"),
    command: params.command ? redact(params.command) : null,
    cwd: params.cwd || null,
    permissions: params.permissions && typeof params.permissions === "object" ? params.permissions : null,
    questions: Array.isArray(params.questions) ? params.questions : null,
  };
}

export class RuntimeManager extends EventEmitter {
  #runtimes = new Map();
  #queued = new Set();
  #eventIds = new Map();
  #events = new Map();
  #lifecycleVersions = new Map();
  #switching = new Set();
  #draining = new Set();

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
    void this.#drainQueue(chatId);
    return chat;
  }

  async editQueue(chatId, { removeId, resume = false } = {}) {
    const chat = await this.store.update(chatId, current => ({
      queuedMessages: (current.queuedMessages || []).filter(item => item.id !== removeId),
      queuePaused: resume ? false : Boolean(current.queuePaused), queueError: null,
    }));
    if (!chat) throw Object.assign(new Error("Chat not found"), { statusCode: 404 });
    this.publishChat(chat);
    if (resume) void this.#drainQueue(chatId);
    return chat;
  }

  async #drainQueue(chatId) {
    if (this.#draining.has(chatId)) return;
    this.#draining.add(chatId);
    try {
      while (true) {
        const chat = this.store.get(chatId);
        if (!chat || chat.queuePaused || chat.archived || this.isBusy(chatId) || chat.status === "stopping" || !chat.queuedMessages?.length) break;
        const item = chat.queuedMessages[0];
        const submitted = await this.submit(chatId, item.text, item.attachmentIds);
        this.publishChat(await this.store.update(chatId, current => ({ queuedMessages: (current.queuedMessages || []).filter(entry => entry.id !== item.id) })));
        await submitted.completion;
      }
    } catch (error) {
      this.publishChat(await this.store.update(chatId, { queuePaused: true, queueError: error.name === "AbortError" ? null : errorMessage(error) }));
    } finally { this.#draining.delete(chatId); }
  }

  constructor({ store, config, broker, gatewayOrigin, workerBackend = null, adapterFactory = null, github = null, environments = null, models = null, attachments = null, mcps = null, commands = null }) {
    super();
    this.store = store;
    this.config = config;
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
    this.commands = commands;
    this.pullRequests = new PullRequestMonitor({ store, github, publish: chat => this.publishChat(chat) });
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

  isBusy(chatId) { return this.#switching.has(chatId) || this.#queued.has(chatId) || Boolean(this.#runtimes.get(chatId)?.busy); }
  publishChat(chat) { if (chat) this.#emit(chat.id, { type: "chat_updated", chat }); }

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
        usage: null, usageAccount: null, rateLimits: null, connectors: null, slashCommands: [], commandCatalog: [],
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
      const [repository] = await this.github.resolveSelections([selection]);
      if (chat.repositories?.some(repo => repo.fullName.toLowerCase() === repository.fullName.toLowerCase())) throw new Error("This repository is already in the chat");
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
    const identity = `${chat.agent}:${chat.agentSessionId}`;
    let live = runtime?.adapter.inspect ? await runtime.adapter.inspect() : {};
    let legacy = await legacyClaudeContext(chat, this.config);
    // Usage can arrive during inspection: do not return its earlier snapshot.
    await runtime?.eventQueue;
    chat = this.store.get(chatId);
    if (!chat) throw Object.assign(new Error("Chat not found"), { statusCode: 404 });
    if (`${chat.agent}:${chat.agentSessionId}` !== identity) { live = {}; legacy = null; }
    if (chat.usage?.version === 2) legacy = null;
    // Persist recovered transcript counters and inspection-only fields in the
    // controller DB, not the disposable worker or the browser's memory cache.
    const different = (value, saved) => value != null && JSON.stringify(value) !== JSON.stringify(saved);
    if (legacy || different(live.rateLimits, chat.rateLimits) || different(live.connectors, chat.connectors) || different(live.account, chat.usageAccount)) {
      chat = await this.store.update(chatId, current => {
        if (`${current.agent}:${current.agentSessionId}` !== identity) return {};
        return { ...(legacy && current.usage?.version !== 2 ? { usage: { ...current.usage, ...legacy, persistedSnapshot: true } } : {}),
          ...(live.rateLimits ? { rateLimits: live.rateLimits } : {}), ...(live.connectors ? { connectors: live.connectors } : {}),
          ...(live.account ? { usageAccount: live.account } : {}) };
      });
    }
    const awake = this.#runtimes.get(chatId) === runtime && Boolean(runtime);
    return { usage: chat.usage || null, rateLimits: chat.rateLimits || null, connectors: chat.connectors || null,
      agent: chat.agent, model: chat.model, authMode: this.config[chat.agent]?.authMode || "none", account: chat.usageAccount || null, snapshot: !awake, recordedAt: chat.usage?.recordedAt || null,
      slashCommands: chat.slashCommands || [], canCompact: Boolean(runtime && this.#runtimes.get(chatId) === runtime && runtime.adapter.compact && !this.isBusy(chatId)),
      note: awake ? "Provider-reported usage only. Missing context or subscription limits are unavailable from this CLI/auth mode." : "Worker stopped. Showing the last snapshot saved outside the worker; opening this panel does not wake it." };
  }

  async compact(chatId) {
    const runtime = this.#runtimes.get(chatId);
    if (!runtime?.adapter.compact || this.isBusy(chatId)) throw Object.assign(new Error("Manual compaction requires an active, idle Codex session. Claude manages compaction internally."), { statusCode: 409 });
    runtime.busy = true; clearTimeout(runtime.idleTimer);
    await this.#setStatus(chatId, "running", "Compacting context", null);
    try { await runtime.adapter.compact(); await runtime.eventQueue; }
    finally { runtime.busy = false; if (this.#runtimes.get(chatId) === runtime) await this.#scheduleIdleStop(chatId, runtime); void this.#drainQueue(chatId); }
  }

  async createChat(input = {}) {
    const allowed = this.availableAgents().filter((agent) => agent.enabled).map((agent) => agent.id);
    const agent = input.agent || allowed[0];
    if (!allowed.includes(agent)) throw new Error(`agent is not enabled: ${agent}`);
    const title = input.title ? clampText(input.title, 120, "title") : agent === "mock" ? "New mock conversation" : "New conversation";
    const source = typeof input.source === "string" ? input.source.trim() : this.config.workspaceSource;
    const environment = input.environmentId ? await this.environments?.runtime(input.environmentId) : null;
    if (environment?.archived) throw new Error("Choose an environment that is not archived");
    if (environment && environment.backend !== this.config.workerBackend) throw new Error(`This server uses ${this.config.workerBackend} workers. Select an environment with that backend.`);
    const repositories = input.repositories ? await this.github.resolveSelections(input.repositories) : [];
    const modelSettings = this.models ? await this.models.creationSettings(agent, input) : {};
    const chat = await this.store.create({ title, agent, ...modelSettings, modelSelectionSet: Object.hasOwn(input, "model") || Object.hasOwn(input, "effort"), source: repositories.length ? "" : source, repositories,
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

  async submit(chatId, rawText, attachmentIds = []) {
    const text = clampText(rawText, 100_000, "message");
    const chat = this.store.get(chatId);
    if (!chat) throw Object.assign(new Error("chat not found"), { statusCode: 404 });
    if (chat.workflowState === "archived") throw Object.assign(new Error("Unarchive this chat before sending a message"), { statusCode: 409 });
    if (this.isBusy(chatId)) {
      throw Object.assign(new Error("this chat already has a running turn"), { statusCode: 409 });
    }
    this.#queued.add(chatId);
    const version = this.#lifecycleVersions.get(chatId) || 0;

    try {
      const files = this.attachments ? await this.attachments.resolve(chatId, attachmentIds) : [];
      let skill = null;
      const slash = /^\/([\w:.-]+)(?:\s|$)/.exec(text);
      if (chat.agent === "codex" && slash && this.commands) {
        const command = (await this.commands.list(chat)).commands.find(item => item.name === slash[1]);
        if (command?.kind === "Skill" && command.path) skill = { name: command.name, path: command.path };
        else if (command) throw new Error(`/${slash[1]} is a native terminal command, not a supported web action yet. Use the corresponding web control or describe your task.`);
      }
      if (version !== (this.#lifecycleVersions.get(chatId) || 0)) throw Object.assign(new Error("Turn cancelled"), { name: "AbortError" });
      await this.store.update(chatId, { awaitingUser: false, pendingRequest: null, ...(!chat.queuedMessages?.length ? { queuePaused: false, queueError: null } : {}) });
      const userMessage = await this.store.appendMessage(chatId, { role: "user", kind: "message", text, ...(files.length ? { attachments: files.map(file => this.attachments.public(file)) } : {}) });
      this.#emit(chatId, { type: "message", message: userMessage });
      if (version !== (this.#lifecycleVersions.get(chatId) || 0)) { this.#queued.delete(chatId); return { message: userMessage, completion: Promise.resolve() }; }
      const completion = this.#runTurn(chatId, text, files, userMessage.id, skill).finally(() => { this.#queued.delete(chatId); void this.#drainQueue(chatId); });
      return { message: userMessage, completion };
    } catch (error) {
      this.#queued.delete(chatId);
      throw error;
    }
  }

  async send(chatId, rawText) {
    const submitted = await this.submit(chatId, rawText);
    await submitted.completion;
  }

  async #runTurn(chatId, text, files = [], userMessageId = null, skill = null) {
    let runtime = this.#runtimes.get(chatId);

    if (!runtime) {
      try {
        runtime = await this.#start(chatId);
      } catch (error) {
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
    await this.#setStatus(chatId, "running", "Agent is working", null);
    this.#emit(chatId, { type: "turn_started", messageId: assistantMessageId });

    try {
      const automaticTitle = this.store.get(chatId).autoTitle && this.store.get(chatId).agent !== "mock";
      const metadata = this.store.get(chatId).agent !== "mock";
      runtime.titleStream = metadata ? new ResponseStream(event => {
        runtime.eventQueue = runtime.eventQueue.then(() => this.#agentEvent(chatId, event));
      }, automaticTitle) : null;
      const settings = this.models ? await this.models.turnSettings(this.store.get(chatId)) : {};
      const materialized = files.length ? await this.attachments.materialize(this.store.get(chatId), runtime.executor, files) : [];
      if (materialized.length) await this.store.update(chatId, current => ({ messages: current.messages.map(message => message.id === userMessageId ? { ...message, attachments: materialized } : message) }));
      const attached = materialized.length ? `\n\nUser attachments (read these files as needed):\n${materialized.map(file => JSON.stringify({ name: file.name, path: file.path, mime: file.mime })).join("\n")}` : "";
      const currentChat = this.store.get(chatId);
      if (runtime.generation !== generation || this.#runtimes.get(chatId) !== runtime) return;
      const raw = (skill ? text.replace(/^\/[\w:.-]+/, `$${skill.name}`) : text) + attached;
      const prompt = handoffPrompt(currentChat, raw);
      // Keep Claude slash commands at the beginning of the user input. Relay's
      // metadata/handoff instructions belong in the appended system prompt.
      const claude = currentChat.agent === "claude";
      const result = await runtime.adapter.send(claude ? raw : metadata ? responsePrompt(prompt, automaticTitle) : prompt, {
        ...settings, ...(skill ? { skills: [skill] } : {}),
        ...(claude ? { systemPrompt: responsePrompt("", automaticTitle) + (currentChat.needsAgentHandoff ? handoffPrompt(currentChat, "") : "") } : {}),
        mode: currentChat.mode || "accept_edits", images: materialized.filter(file => /^image\/(png|jpeg|webp|gif)$/.test(file.mime)).map(file => file.path) });
      if (runtime.generation !== generation) return;
      runtime.titleStream?.flush();
      await runtime.eventQueue;
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
      // Inspect only a worker that is already awake. Later GitHub polling uses
      // these saved branch names and never boots an idle EC2 instance.
      const gitBranches = await inspectBranches(this.store.get(chatId), runtime.executor);
      const workspaceChanges = runtime.generation === generation ? await snapshotChanges(this.store.get(chatId), runtime.executor) : null;
      if (runtime.generation === generation) await this.store.update(chatId, { gitBranches, workspaceChanges });
    } catch (error) {
      if (runtime.generation !== generation) return;
      this.publishChat(await this.store.update(chatId, { queuePaused: true, queueError: errorMessage(error) }));
      const message = await this.store.appendMessage(chatId, {
        role: "system",
        kind: "error",
        text: errorMessage(error),
      });
      this.#emit(chatId, { type: "turn_failed", message });
    } finally {
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
    this.mcps?.revokeChat(chatId);
    this.publishChat(await this.store.update(chatId, { queuePaused: true }));
    const runtime = this.#runtimes.get(chatId);
    if (this.config.workerBackend === "ec2" && chat.agent !== "mock") {
      await this.#setStatus(chatId, "stopping", "Stopping EC2 worker", null);
    }
    if (runtime) {
      runtime.generation += 1;
      if (runtime.idleTimer) clearTimeout(runtime.idleTimer);
      this.#runtimes.delete(chatId);
      await runtime.adapter.stop().catch((error) => this.#emit(chatId, { type: "runtime_log", text: `Adapter stop warning: ${errorMessage(error)}` }));
      await runtime.eventQueue; // Flush final context/usage before worker storage disappears.
    }
    try {
      if (chat.agent !== "mock") await this.workerBackend.sleep(chat);
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

  async remove(chatId) {
    const chat = this.store.get(chatId);
    if (!chat) return false;
    await this.stop(chatId, "deleted");
    if (chat.agent !== "mock") await this.workerBackend.destroy(chat);
    const removed = await this.store.remove(chatId);
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

    let payload;
    if (chat.pendingRequest.method === "item/tool/requestUserInput") {
      if (!input.answers || typeof input.answers !== "object") throw new Error("answers object required");
      payload = { answers: Object.fromEntries(Object.entries(input.answers).map(([key, answer]) => [key, { answers: Array.isArray(answer) ? answer : [String(answer)] }])) };
    } else if (chat.pendingRequest.method === "item/permissions/requestApproval") {
      const decision = input.decision;
      if (!["accept", "acceptForSession", "decline", "cancel"].includes(decision)) {
        throw new Error("decision must be accept, acceptForSession, decline, or cancel");
      }
      payload = decision === "accept" || decision === "acceptForSession"
        ? {
            permissions: chat.pendingRequest.permissions || {},
            scope: decision === "acceptForSession" ? "session" : "turn",
          }
        : { permissions: {} };
    } else {
      const decision = input.decision;
      if (!["accept", "acceptForSession", "decline", "cancel"].includes(decision)) {
        throw new Error("decision must be accept, acceptForSession, decline, or cancel");
      }
      payload = { decision };
    }
    await runtime.adapter.respond(requestId, payload);
    const updated = await this.store.update(chatId, current => ({ pendingRequest: null, ...workflowPatch({ ...current, pendingRequest: null }) }));
    this.publishChat(updated);
    this.#emit(chatId, { type: "request_resolved", requestId });
  }

  eventsSince(chatId, lastId = 0) {
    return (this.#events.get(chatId) || []).filter((event) => event.id > lastId);
  }

  async shutdown() {
    await this.pullRequests.stop();
    await Promise.allSettled([...this.#runtimes.keys()].map((chatId) => this.stop(chatId, "shutdown")));
  }

  async #start(chatId) {
    const chat = this.store.get(chatId);
    const version = this.#lifecycleVersions.get(chatId) || 0;
    const checkCancelled = () => { if ((this.#lifecycleVersions.get(chatId) || 0) !== version) throw Object.assign(new Error("Worker startup cancelled"), { name: "AbortError" }); };
    await this.#setStatus(chatId, "starting", "Starting isolated agent runtime", null);
    let runtime;
    let executor;
    const hooks = {
      onEvent: (event) => {
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
      onLog: (text) => this.#emit(chatId, { type: "runtime_log", text }),
      onFatal: (error) => this.#fatal(chatId, error).catch((fatalError) => console.error("runtime fatal handler:", errorMessage(fatalError))),
    };
    const Adapter = ADAPTERS[chat.agent];
    if (!Adapter) throw new Error(`unsupported agent: ${chat.agent}`);
    try {
      if (chat.repositories?.length && !chat.workspaceReady) {
        const { token } = await this.github.requireConnection();
        await prepareRepositories({ destination: chat.workspace, repositories: chat.repositories, token,
          onProgress: detail => this.#setStatus(chatId, "starting", detail, null) });
        await this.store.update(chatId, { workspaceReady: true });
      }
      checkCancelled();
      executor = chat.agent === "mock" ? null : await this.workerBackend.acquire(chat);
      if (executor?.metadata) await this.store.update(chatId, { runtimeMetadata: executor.metadata });
      checkCancelled();
      if (executor && chat.environmentId) {
        const environment = await this.environments.runtime(chat.environmentId);
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
      checkCancelled();
    } catch (error) {
      this.mcps?.revokeChat(chatId);
      if (executor) await this.workerBackend.sleep(chat).catch(() => {});
      if (error.name !== "AbortError") await this.#setStatus(chatId, "error", errorMessage(error), null);
      throw error;
    }
    const adapter = this.adapterFactory
      ? this.adapterFactory({ chat, hooks, executor })
      : new Adapter({ chat, store: this.store, config: this.config, broker: this.broker, gatewayOrigin: this.gatewayOrigin, executor, hooks });
    runtime = { adapter, executor, busy: false, idleTimer: null, generation: 0, eventQueue: Promise.resolve() };
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
      await adapter.stop().catch(() => {});
      if (chat.agent !== "mock") await this.workerBackend.sleep(chat).catch(() => {});
      if (error.name !== "AbortError") await this.#setStatus(chatId, "error", errorMessage(error), null);
      throw error;
    }
  }

  async #scheduleIdleStop(chatId, runtime) {
    const deadline = new Date(Date.now() + this.config.idleTimeoutMs).toISOString();
    await this.#setStatus(chatId, "idle", "Waiting for another message", deadline);
    runtime.idleTimer = setTimeout(() => {
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
      lastActivityAt: nowIso(),
    }));
    if (chat) this.#emit(chatId, { type: "chat_updated", chat });
  }

  async #agentEvent(chatId, event) {
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
    const runtime = this.#runtimes.get(chatId);
    if (!runtime) return;
    runtime.generation += 1;
    if (runtime.idleTimer) clearTimeout(runtime.idleTimer);
    this.#runtimes.delete(chatId);
    this.broker.revokeChat(chatId);
    this.mcps?.revokeChat(chatId);
    await runtime.adapter.stop().catch(() => {});
    const chat = this.store.get(chatId);
    if (chat && chat.agent !== "mock") await this.workerBackend.sleep(chat).catch(() => {});
    await this.#setStatus(chatId, "error", errorMessage(error), null);
    this.#emit(chatId, { type: "runtime_error", text: errorMessage(error) });
  }

  #emit(chatId, event) {
    const id = (this.#eventIds.get(chatId) || 0) + 1;
    this.#eventIds.set(chatId, id);
    const complete = { id, chatId, at: nowIso(), ...event };
    const history = this.#events.get(chatId) || [];
    history.push(complete);
    if (history.length > 300) history.splice(0, history.length - 300);
    this.#events.set(chatId, history);
    this.emit("event", complete);
  }
}
