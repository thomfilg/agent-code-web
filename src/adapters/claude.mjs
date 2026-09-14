import { randomUUID } from "node:crypto";
import readline from "node:readline";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { buildWorkerEnvironment, spawnWorker, terminateWorker } from "../worker-process.mjs";
import { errorMessage, redact } from "../utils.mjs";
import { claudeUsage } from "../session-info.mjs";

export class ClaudeAdapter {
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
    this.sessionId = chat.agentSessionId;
    this.child = null;
    this.capability = "";
    this.stopped = false;
  }

  async start() {
    const authMode = this.config.claude.authMode;
    if (authMode === "gateway" && !this.config.claude.providerKey) {
      throw new Error("ANTHROPIC_API_KEY is required when CLAUDE_AUTH_MODE=gateway");
    }
    if (authMode === "gateway") {
      this.capability = this.broker.issue({ chatId: this.chat.id, provider: "anthropic" });
    }
    this.stopped = false;
  }

  async send(text, { model, effort, resetEffort, mode = "accept_edits" } = {}) {
    if (this.child) throw new Error("A Claude turn is already running for this chat");
    if (this.stopped || (this.config.claude.authMode === "gateway" && !this.capability)) await this.start();

    const isNew = !this.sessionId;
    if (isNew) {
      this.sessionId = randomUUID();
      await this.hooks.onSessionId?.(this.sessionId);
    }
    const ensureDirectory = this.executor
      ? (directory) => this.executor.mkdir(directory)
      : (directory) => mkdir(directory, { recursive: true, mode: 0o700 });
    const env = await buildWorkerEnvironment({
      chat: this.chat,
      store: this.store,
      runtimeHome: this.runtimeHome,
      provider: "anthropic",
      authMode: this.config.claude.authMode,
      capability: this.capability,
      gatewayOrigin: this.gatewayOrigin,
      ensureDirectory,
      environmentVariables: this.executor?.environmentVariables,
      environmentPath: this.executor?.environmentPath,
    });
    await ensureDirectory(env.CLAUDE_CONFIG_DIR);
    // Only this chat's uploaded files join its permitted working directories.
    // Do not grant access to the controller or other chats' runtime homes.
    const uploads = path.join(this.runtimeHome, "uploads");
    await ensureDirectory(uploads);
    if (resetEffort) env.CLAUDE_CODE_EFFORT_LEVEL = "auto";

    const args = [
      "--print",
      "--verbose",
      "--output-format", "stream-json",
      "--include-partial-messages",
      "--permission-mode", mode === "plan" ? "plan" : mode === "auto" ? "auto" : "acceptEdits",
      "--prompt-suggestions", "false",
      "--add-dir", uploads,
      ...(isNew ? ["--session-id", this.sessionId] : ["--resume", this.sessionId]),
      ...(model || this.config.claude.model ? ["--model", model || this.config.claude.model] : []),
      ...(effort ? ["--effort", effort] : []),
    ];

    const child = this.executor
      ? this.executor.spawn(this.config.claude.bin, args, {
          cwd: this.workspace,
          env,
          stdio: ["pipe", "pipe", "pipe"],
        })
      : spawnWorker(this.config.claude.bin, args, {
          isolation: this.config.processIsolation,
          cwd: this.workspace,
          env,
          stdio: ["pipe", "pipe", "pipe"],
        });
    this.child = child;
    child.stdin.end(text);

    let streamed = "";
    let fallback = "";
    let resultMessage = null;
    let stderr = "";
    const activeTools = new Map();
    const completeTool = (itemId, output = "") => {
      const tool = activeTools.get(itemId);
      if (!tool) return;
      activeTools.delete(itemId);
      this.hooks.onEvent?.({ ...tool, state: "completed", output });
    };
    const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on("line", (line) => {
      let event;
      try { event = JSON.parse(line); } catch { return; }
      if (event.type === "system" && event.subtype === "init") this.hooks.onEvent?.({ type: "session_capabilities", connectors: (event.mcp_servers || []).map(server => ({ name: server.name, status: server.status })), slashCommands: event.slash_commands || [] });
      if (event.type === "stream_event" && event.event?.type === "content_block_delta") {
        const delta = event.event.delta?.text || "";
        if (delta) {
          streamed += delta;
          this.hooks.onEvent?.({ type: "assistant_delta", delta });
        }
      } else if (event.type === "assistant") {
        fallback = (event.message?.content || [])
          .filter((block) => block.type === "text")
          .map((block) => block.text)
          .join("");
        for (const block of event.message?.content || []) {
          if (block.type === "tool_use" && !activeTools.has(block.id)) {
            const tool = { type: "tool", tool: block.name || "tool", itemId: block.id, title: block.name || "Tool call" };
            activeTools.set(block.id, tool);
            this.hooks.onEvent?.({ ...tool, state: "running", output: "" });
          }
        }
      } else if (event.type === "user") {
        for (const block of event.message?.content || []) {
          if (block.type !== "tool_result") continue;
          const content = typeof block.content === "string"
            ? block.content
            : JSON.stringify(block.content ?? "");
          completeTool(block.tool_use_id, redact(content).slice(-16_000));
        }
      } else if (event.type === "result") {
        resultMessage = event;
        this.hooks.onEvent?.({ type: "usage", usage: claudeUsage(event) });
        for (const itemId of activeTools.keys()) completeTool(itemId);
        if (!streamed && !fallback && typeof event.result === "string") fallback = event.result;
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${redact(chunk)}`.slice(-16_000);
    });

    return new Promise((resolve, reject) => {
      child.once("error", (error) => {
        this.child = null;
        reject(error);
      });
      child.once("exit", (code, signal) => {
        this.child = null;
        const resultFailed = resultMessage && (
          resultMessage.is_error === true ||
          (resultMessage.subtype && resultMessage.subtype !== "success")
        );
        if (code === 0 && !resultFailed) {
          resolve({ text: streamed || fallback, status: "completed" });
        } else {
          reject(new Error(`Claude worker exited ${code ?? signal}: ${redact(resultMessage?.result || stderr || "unknown error")}`));
        }
      });
    });
  }

  async respond() {
    throw new Error("Interactive approval responses are currently implemented for Codex only");
  }

  async stop() {
    this.stopped = true;
    const child = this.child;
    this.child = null;
    if (child) await terminateWorker(child);
    this.broker.revokeChat(this.chat.id);
    this.capability = "";
  }
}
