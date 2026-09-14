import { mkdir } from "node:fs/promises";
import { JsonRpcProcess } from "../json-rpc-process.mjs";
import { buildWorkerEnvironment } from "../worker-process.mjs";
import { errorMessage, redact } from "../utils.mjs";

const toml = (value) => JSON.stringify(value);

function gatewayArgs(origin) {
  return [
    "-c", `model_provider=${toml("agent_gateway")}`,
    "-c", `model_providers.agent_gateway.name=${toml("Agent Web credential gateway")}`,
    "-c", `model_providers.agent_gateway.base_url=${toml(`${origin}/gateway/openai/v1`)}`,
    "-c", `model_providers.agent_gateway.env_key=${toml("AGENT_SESSION_TOKEN")}`,
    "-c", `model_providers.agent_gateway.wire_api=${toml("responses")}`,
    "-c", "model_providers.agent_gateway.requires_openai_auth=false",
  ];
}

function safeToolEvent(item, state) {
  if (!item || typeof item !== "object") return null;
  if (item.type === "commandExecution") {
    return {
      type: "tool",
      tool: "command",
      state,
      itemId: item.id,
      title: redact(item.command || "Shell command"),
      output: state === "completed" ? redact(item.aggregatedOutput || "").slice(-16_000) : "",
      exitCode: item.exitCode ?? null,
    };
  }
  if (item.type === "fileChange") {
    return {
      type: "tool",
      tool: "files",
      state,
      itemId: item.id,
      title: `${item.changes?.length || 0} file change${item.changes?.length === 1 ? "" : "s"}`,
      output: "",
    };
  }
  if (item.type === "mcpToolCall" || item.type === "dynamicToolCall") {
    return {
      type: "tool",
      tool: item.type,
      state,
      itemId: item.id,
      title: redact(item.tool || item.name || "Tool call"),
      output: state === "completed" ? redact(JSON.stringify(item.result ?? item.contentItems ?? "")).slice(-16_000) : "",
    };
  }
  return null;
}

export class CodexAdapter {
  constructor({ chat, store, config, broker, gatewayOrigin, executor = null, hooks }) {
    this.chat = chat;
    this.store = store;
    this.config = config;
    this.broker = broker;
    this.executor = executor;
    this.gatewayOrigin = executor?.gatewayOrigin || gatewayOrigin;
    this.workspace = executor?.workspace || chat.workspace;
    this.runtimeHome = executor?.runtimeHome || store.runtimeHome(chat.id);
    this.hooks = hooks;
    this.rpc = null;
    this.threadId = chat.agentSessionId;
    this.current = null;
    this.requests = new Map();
    this.intentionalStop = false;
  }

  async start() {
    if (this.rpc) return;
    const authMode = this.config.codex.authMode;
    if (authMode === "gateway" && !this.config.codex.providerKey) {
      throw new Error("OPENAI_API_KEY is required when CODEX_AUTH_MODE=gateway");
    }
    const capability = authMode === "gateway"
      ? this.broker.issue({ chatId: this.chat.id, provider: "openai" })
      : "";
    const ensureDirectory = this.executor
      ? (directory) => this.executor.mkdir(directory)
      : (directory) => mkdir(directory, { recursive: true, mode: 0o700 });
    const env = await buildWorkerEnvironment({
      chat: this.chat,
      store: this.store,
      runtimeHome: this.runtimeHome,
      provider: "openai",
      authMode,
      capability,
      gatewayOrigin: this.gatewayOrigin,
      ensureDirectory,
      environmentVariables: this.executor?.environmentVariables,
      environmentPath: this.executor?.environmentPath,
    });
    await ensureDirectory(env.CODEX_HOME);

    const args = ["app-server"];
    if (authMode === "gateway") args.push(...gatewayArgs(this.gatewayOrigin));
    args.push(
      "-c", `shell_environment_policy.inherit=${toml("core")}`,
      "-c", "shell_environment_policy.ignore_default_excludes=false",
      "-c", `shell_environment_policy.exclude=[${toml("AGENT_SESSION_TOKEN")},${toml("OPENAI_API_KEY")},${toml("ANTHROPIC_API_KEY")}]`,
    );
    for (const [name, value] of Object.entries(this.executor?.environmentVariables || {})) args.push("-c", `shell_environment_policy.set.${name}=${toml(value)}`);

    const rpc = new JsonRpcProcess({
      command: this.config.codex.bin,
      args,
      isolation: this.executor ? "none" : this.config.processIsolation,
      spawnFn: this.executor ? this.executor.spawn.bind(this.executor) : null,
      spawnOptions: { cwd: this.workspace, env },
    });
    this.rpc = rpc;
    this.intentionalStop = false;
    rpc.on("notification", (message) => this.#notification(message));
    rpc.on("request", (message) => this.#serverRequest(message));
    rpc.on("stderr", (text) => this.hooks.onLog?.(redact(text)));
    rpc.on("protocolError", (error) => this.hooks.onLog?.(errorMessage(error)));
    rpc.on("error", (error) => this.hooks.onFatal?.(error));
    rpc.on("exit", ({ code, signal }) => {
      if (!this.intentionalStop) this.hooks.onFatal?.(new Error(`Codex worker exited: ${code ?? signal}`));
      this.rpc = null;
      this.#rejectCurrent(new Error("Codex worker stopped before the turn completed"));
    });
    rpc.start();
    await rpc.request("initialize", {
      clientInfo: { name: "agent_web_poc", title: "Agent Web POC", version: "0.1.0" },
      capabilities: { experimentalApi: false },
    });
    rpc.notify("initialized", {});
    await this.#loadThread();
  }

  async #loadThread() {
    const common = {
      cwd: this.workspace,
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
      ...(this.config.codex.model ? { model: this.config.codex.model } : {}),
      ...(this.config.codex.authMode === "gateway" ? { modelProvider: "agent_gateway" } : {}),
    };
    let result;
    if (this.threadId) {
      try {
        result = await this.rpc.request("thread/resume", { threadId: this.threadId, ...common }, 60_000);
      } catch (error) {
        this.hooks.onEvent?.({ type: "notice", text: `Stored Codex thread could not be resumed; starting a new thread. ${errorMessage(error)}` });
        this.threadId = null;
      }
    }
    if (!this.threadId) {
      result = await this.rpc.request("thread/start", {
        ...common,
        serviceName: "agent_web_poc",
        ephemeral: false,
      }, 60_000);
      this.threadId = result?.thread?.id;
      if (!this.threadId) throw new Error("Codex did not return a thread id");
      await this.hooks.onSessionId?.(this.threadId);
    }
  }

  async send(text, { model, effort } = {}) {
    if (!this.rpc) await this.start();
    if (this.current) throw new Error("A Codex turn is already running for this chat");

    let resolveTurn;
    let rejectTurn;
    const completion = new Promise((resolve, reject) => {
      resolveTurn = resolve;
      rejectTurn = reject;
    });
    const timer = setTimeout(() => rejectTurn(new Error("Codex turn timed out after one hour")), 3_600_000);
    this.current = { text: "", finalText: "", resolveTurn, rejectTurn, timer };

    try {
      await this.rpc.request("turn/start", {
        threadId: this.threadId,
        input: [{ type: "text", text }],
        ...(model ? { model } : {}),
        ...(effort ? { effort } : {}),
      }, 60_000);
      const result = await completion;
      return result;
    } catch (error) {
      this.#rejectCurrent(error);
      throw error;
    }
  }

  async respond(requestId, payload) {
    const request = this.requests.get(requestId);
    if (!request || !this.rpc) throw new Error("approval request is no longer active");
    this.requests.delete(requestId);
    this.rpc.respond(request.rpcId, payload);
  }

  async stop() {
    this.intentionalStop = true;
    for (const request of this.requests.values()) {
      try { this.rpc?.respond(request.rpcId, { decision: "cancel" }); } catch {}
    }
    this.requests.clear();
    this.#rejectCurrent(new Error("Turn interrupted because the worker was stopped"));
    const rpc = this.rpc;
    this.rpc = null;
    if (rpc) await rpc.stop();
    this.broker.revokeChat(this.chat.id);
  }

  #notification(message) {
    const { method, params = {} } = message;
    if (method === "serverRequest/resolved") {
      const requestId = `approval_${params.requestId}`;
      this.requests.delete(requestId);
      this.hooks.onEvent?.({ type: "request_resolved", requestId });
      return;
    }
    if (method === "item/agentMessage/delta" && this.current) {
      this.current.text += params.delta || "";
      this.hooks.onEvent?.({ type: "assistant_delta", delta: params.delta || "" });
      return;
    }
    if ((method === "item/started" || method === "item/completed") && params.item) {
      if (method === "item/completed" && params.item.type === "agentMessage" && this.current) {
        this.current.finalText = params.item.text || "";
      }
      const event = safeToolEvent(params.item, method === "item/started" ? "running" : "completed");
      if (event) this.hooks.onEvent?.(event);
      return;
    }
    if (method === "turn/completed" && this.current) {
      const current = this.current;
      this.current = null;
      clearTimeout(current.timer);
      const status = params.turn?.status || "completed";
      if (status === "completed") current.resolveTurn({ text: current.text || current.finalText, status });
      else current.rejectTurn(new Error(`Codex turn ended with status ${status}`));
      return;
    }
    if (method === "error") {
      this.hooks.onEvent?.({ type: "notice", level: "error", text: params.error?.message || params.message || "Codex error" });
    }
  }

  #serverRequest(message) {
    const supported = new Set([
      "item/commandExecution/requestApproval",
      "item/fileChange/requestApproval",
      "item/tool/requestUserInput",
      "item/permissions/requestApproval",
    ]);
    if (!supported.has(message.method)) {
      this.rpc.respondError(message.id, -32601, `Unsupported client request: ${message.method}`);
      return;
    }
    const requestId = `approval_${message.id}`;
    this.requests.set(requestId, { rpcId: message.id, method: message.method });
    this.hooks.onRequest?.({ requestId, method: message.method, params: message.params || {} });
  }

  #rejectCurrent(error) {
    if (!this.current) return;
    const current = this.current;
    this.current = null;
    clearTimeout(current.timer);
    current.rejectTurn(error);
  }
}
