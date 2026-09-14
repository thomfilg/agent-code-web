import { EventEmitter } from "node:events";
import { clampText, errorMessage, newId, nowIso, redact } from "./utils.mjs";
import { prepareWorkspace } from "./workspace.mjs";
import { CodexAdapter } from "./adapters/codex.mjs";
import { ClaudeAdapter } from "./adapters/claude.mjs";
import { MockAdapter } from "./adapters/mock.mjs";

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

  constructor({ store, config, broker, gatewayOrigin, workerBackend = null, adapterFactory = null }) {
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

  async createChat(input = {}) {
    const allowed = this.availableAgents().filter((agent) => agent.enabled).map((agent) => agent.id);
    const agent = input.agent || allowed[0];
    if (!allowed.includes(agent)) throw new Error(`agent is not enabled: ${agent}`);
    const title = input.title ? clampText(input.title, 120, "title") : `New ${agent === "claude" ? "Claude" : "Codex"} chat`;
    const source = typeof input.source === "string" ? input.source.trim() : this.config.workspaceSource;
    const chat = await this.store.create({ title, agent, source });
    try {
      const prepared = await prepareWorkspace({ destination: chat.workspace, source });
      const updated = await this.store.update(chat.id, {
        source: prepared.source,
        statusDetail: prepared.kind === "empty" ? "Empty workspace ready" : `Workspace cloned from ${prepared.source}`,
      });
      this.#emit(chat.id, { type: "chat_updated", chat: updated });
      return updated;
    } catch (error) {
      await this.store.remove(chat.id);
      throw error;
    }
  }

  async submit(chatId, rawText) {
    const text = clampText(rawText, 100_000, "message");
    const chat = this.store.get(chatId);
    if (!chat) throw Object.assign(new Error("chat not found"), { statusCode: 404 });
    if (this.#queued.has(chatId) || this.#runtimes.get(chatId)?.busy) {
      throw Object.assign(new Error("this chat already has a running turn"), { statusCode: 409 });
    }
    this.#queued.add(chatId);

    try {
      const userMessage = await this.store.appendMessage(chatId, { role: "user", kind: "message", text });
      this.#emit(chatId, { type: "message", message: userMessage });
      const completion = this.#runTurn(chatId, text).finally(() => this.#queued.delete(chatId));
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

  async #runTurn(chatId, text) {
    let runtime = this.#runtimes.get(chatId);

    if (!runtime) {
      try {
        runtime = await this.#start(chatId);
      } catch (error) {
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
      const result = await runtime.adapter.send(text);
      if (runtime.generation !== generation) return;
      await runtime.eventQueue;
      const message = await this.store.appendMessage(chatId, {
        id: assistantMessageId,
        role: "assistant",
        kind: "message",
        text: result.text || "",
      });
      this.#emit(chatId, { type: "turn_completed", message });
    } catch (error) {
      if (runtime.generation !== generation) return;
      const message = await this.store.appendMessage(chatId, {
        role: "system",
        kind: "error",
        text: errorMessage(error),
      });
      this.#emit(chatId, { type: "turn_failed", message });
    } finally {
      if (runtime.generation === generation && this.#runtimes.get(chatId) === runtime) {
        runtime.busy = false;
        await this.#scheduleIdleStop(chatId, runtime);
      }
    }
  }

  async stop(chatId, reason = "manual") {
    const chat = this.store.get(chatId);
    if (!chat) throw Object.assign(new Error("chat not found"), { statusCode: 404 });
    const runtime = this.#runtimes.get(chatId);
    if (this.config.workerBackend === "ec2" && chat.agent !== "mock") {
      await this.#setStatus(chatId, "stopping", "Stopping EC2 worker", null);
    }
    if (runtime) {
      runtime.generation += 1;
      if (runtime.idleTimer) clearTimeout(runtime.idleTimer);
      this.#runtimes.delete(chatId);
      await runtime.adapter.stop().catch((error) => this.#emit(chatId, { type: "runtime_log", text: `Adapter stop warning: ${errorMessage(error)}` }));
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
    await this.store.update(chatId, { pendingRequest: null });
    this.#emit(chatId, { type: "request_resolved", requestId });
  }

  eventsSince(chatId, lastId = 0) {
    return (this.#events.get(chatId) || []).filter((event) => event.id > lastId);
  }

  async shutdown() {
    await Promise.allSettled([...this.#runtimes.keys()].map((chatId) => this.stop(chatId, "shutdown")));
  }

  async #start(chatId) {
    const chat = this.store.get(chatId);
    await this.#setStatus(chatId, "starting", "Starting isolated agent runtime", null);
    let runtime;
    let executor;
    const hooks = {
      onEvent: (event) => {
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
      executor = chat.agent === "mock" ? null : await this.workerBackend.acquire(chat);
      if (executor?.metadata) await this.store.update(chatId, { runtimeMetadata: executor.metadata });
    } catch (error) {
      await this.#setStatus(chatId, "error", errorMessage(error), null);
      throw error;
    }
    const adapter = this.adapterFactory
      ? this.adapterFactory({ chat, hooks })
      : new Adapter({ chat, store: this.store, config: this.config, broker: this.broker, gatewayOrigin: this.gatewayOrigin, executor, hooks });
    runtime = { adapter, executor, busy: false, idleTimer: null, generation: 0, eventQueue: Promise.resolve() };
    this.#runtimes.set(chatId, runtime);
    try {
      await adapter.start();
      await this.#setStatus(chatId, "idle", "Runtime ready", null);
      this.#emit(chatId, { type: "runtime_started", agent: chat.agent });
      return runtime;
    } catch (error) {
      this.#runtimes.delete(chatId);
      await adapter.stop().catch(() => {});
      if (chat.agent !== "mock") await this.workerBackend.sleep(chat).catch(() => {});
      await this.#setStatus(chatId, "error", errorMessage(error), null);
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
    const chat = await this.store.update(chatId, {
      status,
      statusDetail,
      idleDeadlineAt,
      lastActivityAt: nowIso(),
    });
    if (chat) this.#emit(chatId, { type: "chat_updated", chat });
  }

  async #agentEvent(chatId, event) {
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
    await this.store.update(chatId, { pendingRequest });
    this.#emit(chatId, { type: "request", request: pendingRequest });
  }

  async #fatal(chatId, error) {
    const runtime = this.#runtimes.get(chatId);
    if (!runtime) return;
    runtime.generation += 1;
    if (runtime.idleTimer) clearTimeout(runtime.idleTimer);
    this.#runtimes.delete(chatId);
    this.broker.revokeChat(chatId);
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
