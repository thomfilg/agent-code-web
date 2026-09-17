import { randomUUID } from "node:crypto";
import readline from "node:readline";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { buildWorkerEnvironment, spawnWorker, terminateWorker } from "../worker-process.mjs";
import { errorMessage, redact } from "../utils.mjs";
import { claudeUsage, claudeContext, claudeRateLimits, safeSessionDetails } from "../session-info.mjs";
import { CLAUDE_PERMISSION_MODES, claudeConfigRequest, claudeSettingsChanges, inspectClaudeSettings } from "../claude-settings.mjs";
import { claudeFastRequest, claudeFastState, claudeFastCredential, checkClaudeFastAvailability, claudeFastUnavailable } from "../claude-fast.mjs";

export class ClaudeAdapter {
  constructor({ chat, store, config, broker, gatewayOrigin, executor = null, hooks, fetchImpl = fetch }) {
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
    this.sendVersion = 0;
    this.fetchImpl = fetchImpl;
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

  async send(text, { model, effort, resetEffort, fastMode, fastCredential, fastState, mode = "accept_edits", systemPrompt } = {}) {
    const version = this.sendVersion;
    const configuration = claudeConfigRequest(text);
    const fastRequest = claudeFastRequest(text);
    if (fastRequest && this.config.claude.authMode !== "gateway") throw new Error("Fast changes require a private Claude profile; shared host profiles remain locked until company/profile isolation is complete.");
    if (configuration?.mutate && this.config.claude.authMode !== "gateway") throw new Error("Native settings changes require a private Claude profile. This worker uses a shared host profile; shared settings writes are locked until company/profile isolation is complete.");
    const nativeMode = Object.keys(CLAUDE_PERMISSION_MODES).find(key => CLAUDE_PERMISSION_MODES[key] === mode);
    if (!nativeMode) throw new Error("Unsupported Claude permission mode");
    if (this.child || this.settingsInspection || this.fastInspection) throw new Error("A Claude turn is already running for this chat");
    if (this.stopped || (this.config.claude.authMode === "gateway" && !this.capability)) await this.start();

    const credential = claudeFastCredential(this.config.claude);
    const sameAccount = fastCredential === credential;
    const requestedModel = model || this.config.claude.model;
    const activeFast = fastMode === true && sameAccount && (fastState ? fastState !== "off" : /^opus(?:\[1m\])?$/.test(requestedModel || ""));
    const enableFast = fastRequest === "on" || (fastRequest === "toggle" && !activeFast);
    // Turning it off must always work, including after account access is lost.
    // The following turn explicitly starts with fastMode:false; no inference,
    // account lookup or global Claude settings write is needed for this action.
    if (fastRequest && !enableFast) return { text: "Fast mode OFF (this chat only).", status: "completed", nativeFast: { state: "off" }, fastPreference: false };
    let availability, fastFallback = null;
    if (fastMode === true && !sameAccount && !enableFast) {
      fastMode = false; fastFallback = { state: "off", disabledReason: "unknown" };
      this.hooks.onEvent?.({ type: "notice", text: "Claude credentials changed. Fast is off for this chat; use /fast on to authorize it for the current account." });
    }
    if (enableFast || fastMode === true) {
      const controller = new AbortController(); this.fastInspection = controller;
      try {
        availability = await checkClaudeFastAvailability(this.config.claude, { signal: controller.signal, fetchImpl: this.fetchImpl });
        if (version !== this.sendVersion) throw new Error("Claude turn interrupted");
        if (!availability.enabled) throw Object.assign(new Error(claudeFastUnavailable(availability.disabledReason)), { nativeFast: { state: "off", disabledReason: availability.disabledReason } });
      } catch (error) {
        if (!controller.signal.aborted && version === this.sendVersion && !error.nativeFast) error.nativeFast = { state: "off", disabledReason: "network_error" };
        if (enableFast || controller.signal.aborted || version !== this.sendVersion) throw error;
        fastMode = false; fastFallback = error.nativeFast;
        this.hooks.onEvent?.({ type: "notice", text: `${error.message} Continuing at standard speed; use /fast on to retry.` });
      } finally { if (this.fastInspection === controller) this.fastInspection = null; }
    }

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
    // Documented bearer-gateway compatibility, gated by the fresh authoritative
    // controller lookup above. Never guess permission or bypass a denial/error.
    // Model allowlists, native policy and API-side entitlement still apply.
    if (this.config.claude.authMode === "gateway") {
      delete env.CLAUDE_CODE_SKIP_FAST_MODE_ORG_CHECK;
      delete env.CLAUDE_CODE_SKIP_FAST_MODE_NETWORK_ERRORS;
      if (availability?.enabled) env.CLAUDE_CODE_SKIP_FAST_MODE_ORG_CHECK = "1";
    }
    const inspect = async () => {
      const controller = new AbortController(); this.settingsInspection = controller;
      try {
        const value = await inspectClaudeSettings({ runtimeHome: this.runtimeHome, executor: this.executor, isolation: this.config.processIsolation, signal: controller.signal });
        if (version !== this.sendVersion) throw new Error("Interrupted");
        return value;
      } catch { throw new Error("Cannot safely verify this chat's private Claude settings. The command queue is paused; check the private profile before retrying."); }
      finally { if (this.settingsInspection === controller) this.settingsInspection = null; }
    };
    const beforeSettings = configuration?.mutate ? await inspect() : null;
    // /fast on promotes non-Opus aliases by native contract. Apply that model
    // at startup too: print-mode 2.1.222 otherwise reports the PRE-command
    // Sonnet model's Fast state as off even after saying it switched to Opus.
    // Native model/organization policy still validates the selected Opus.
    const launchModel = enableFast && !/^opus(?:\[1m\])?$/.test(requestedModel || "") ? "opus" : requestedModel;

    const args = [
      "--print",
      "--verbose",
      "--output-format", "stream-json",
      "--include-partial-messages",
      "--permission-mode", nativeMode,
      "--prompt-suggestions", "false",
      "--add-dir", uploads,
      ...(systemPrompt ? ["--append-system-prompt", systemPrompt] : []),
      ...(this.executor?.mcpServers && Object.keys(this.executor.mcpServers).length ? ["--mcp-config", JSON.stringify({ mcpServers: this.executor.mcpServers })] : []),
      ...(isNew ? ["--session-id", this.sessionId] : ["--resume", this.sessionId]),
      ...(launchModel ? ["--model", launchModel] : []),
      ...(effort ? ["--effort", effort] : []),
      ...(enableFast || typeof fastMode === "boolean" ? ["--settings", JSON.stringify({ fastMode: enableFast || fastMode })] : []),
    ];

    if (version !== this.sendVersion) throw new Error("Claude turn interrupted");
    if (availability?.enabled && credential !== claudeFastCredential(this.config.claude)) throw new Error("Claude credentials changed during the Fast availability check. Retry with the current account.");

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
    child.stdin.end(fastRequest ? "/fast on" : text);

    let streamed = "";
    let fallback = "";
    let resultMessage = null;
    let nativeFast = null;
    let compacted = false;
    let lastRequest = null;
    const sampleId = randomUUID();
    let stderr = "";
    const activeTools = new Map();
    const completeTool = (itemId, output = "", failed = false, resultMissing = false) => {
      const tool = activeTools.get(itemId);
      if (!tool) return;
      activeTools.delete(itemId);
      this.hooks.onEvent?.({ ...tool, state: "completed", failed, resultMissing, output });
    };
    const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on("line", (line) => {
      let event;
      try { event = JSON.parse(line); } catch { return; }
      if (event.type === "system" && event.subtype === "compact_boundary") {
        compacted = true;
        this.hooks.onEvent?.({ type: "notice", text: event.compact_metadata?.trigger === "manual" ? "Context compacted." : "Context compacted automatically." });
      }
      if (event.type === "rate_limit_event") this.hooks.onEvent?.({ type: "rate_limits", rateLimits: claudeRateLimits(event.rate_limit_info), merge: true });
      if (event.type === "assistant" && !event.parent_tool_use_id && event.message?.usage) {
        lastRequest = event.message;
        const usage = claudeContext(lastRequest);
        if (usage) this.hooks.onEvent?.({ type: "context_usage", usage });
      }
      if (event.type === "system" && event.subtype === "init") {
        this.hooks.onEvent?.({ type: "session_capabilities", connectors: (event.mcp_servers || []).map(server => ({ name: server.name, status: server.status })), slashCommands: event.slash_commands || [] });
        this.hooks.onEvent?.({ type: "session_details", details: safeSessionDetails("claude", { cwd: this.workspace, model: event.model, cliVersion: event.claude_code_version }) });
      }
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
            const input = redact(JSON.stringify(block.input || {}, null, 2)).slice(0, 16000);
            const title = redact(block.input?.command || block.input?.file_path || block.input?.pattern || block.name || "Tool call").slice(0, 500);
            const tool = { type: "tool", tool: block.name || "tool", itemId: block.id, title, input };
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
          completeTool(block.tool_use_id, redact(content).slice(-16_000), block.is_error === true);
        }
      } else if (event.type === "result") {
        resultMessage = event;
        nativeFast = claudeFastState(event);
        this.hooks.onEvent?.({ type: "usage", usage: claudeUsage(event, lastRequest, sampleId) });
        for (const itemId of activeTools.keys()) completeTool(itemId, "", false, true);
        if (!streamed && !fallback && typeof event.result === "string") fallback = event.result;
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${redact(chunk)}`.slice(-16_000);
    });

    return new Promise((resolve, reject) => {
      let spawnFailed = false;
      child.once("error", (error) => {
        spawnFailed = true;
        if (this.child === child) this.child = null;
        reject(error);
      });
      child.once("close", (code, signal) => { void (async () => {
        if (spawnFailed) return;
        if (this.child === child) this.child = null;
        if (version !== this.sendVersion) throw new Error("Claude turn interrupted");
        const nativeSettings = beforeSettings ? claudeSettingsChanges(beforeSettings, await inspect(), configuration) : undefined;
        const resultFailed = resultMessage && (
          resultMessage.is_error === true ||
          (resultMessage.subtype && resultMessage.subtype !== "success")
        );
        if (code === 0 && !resultFailed) {
          if (enableFast && (!nativeFast || nativeFast.state === "off" || nativeFast.disabledReason)) throw Object.assign(new Error(claudeFastUnavailable(nativeFast?.disabledReason)), { nativeFast });
          resolve({ text: streamed || fallback, status: "completed", compacted, ...(nativeSettings ? { nativeSettings } : {}), ...(nativeFast || fastFallback ? { nativeFast: fastFallback || nativeFast } : {}),
            ...(enableFast ? { fastPreference: true, fastModel: launchModel, fastCredential: credential } : fastFallback ? { fastPreference: false } : {}) });
        } else {
          reject(Object.assign(new Error(`Claude worker exited ${code ?? signal}: ${redact(resultMessage?.result || stderr || "unknown error")}`), { nativeSettings, nativeFast }));
        }
      })().catch(reject); });
    });
  }

  async respond() {
    throw new Error("Interactive approval responses are currently implemented for Codex only");
  }

  async interrupt() {
    this.sendVersion += 1;
    this.settingsInspection?.abort();
    this.fastInspection?.abort();
    // Claude print mode is one child per turn. Keep its resume ID, capability,
    // worker lease and browser; only terminate this turn's CLI process.
    const child = this.child;
    if (child) await terminateWorker(child);
  }

  async stop() {
    this.sendVersion += 1;
    this.settingsInspection?.abort();
    this.fastInspection?.abort();
    this.stopped = true;
    const child = this.child;
    this.child = null;
    if (child) await terminateWorker(child);
    this.broker.revokeChat(this.chat.id);
    this.capability = "";
  }
}
