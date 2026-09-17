import { randomUUID } from "node:crypto";
import readline from "node:readline";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { buildWorkerEnvironment, spawnWorker, terminateWorker } from "../worker-process.mjs";
import { errorMessage, redact } from "../utils.mjs";
import { claudeUsage, claudeContext, claudeRateLimits, safeSessionDetails } from "../session-info.mjs";
import { CLAUDE_PERMISSION_MODES, claudeConfigRequest, claudeSettingsChanges, inspectClaudeSettings, claudePermissionMode } from "../claude-settings.mjs";
import { claudeFastRequest, claudeFastState, claudeFastCredential, checkClaudeFastAvailability, claudeFastUnavailable } from "../claude-fast.mjs";
import { ClaudeTextStream } from "../claude-text-stream.mjs";
import { claudeMcpRequest, CLAUDE_MCP_PRIVATE_ERROR, ClaudeControlChannel, runClaudeMcpCommand } from "../claude-mcp.mjs";
import { ClaudeSession, claudeCallResult } from "../claude-session.mjs";

export class ClaudeAdapter {
  constructor({ chat, store, config, broker, gatewayOrigin, executor = null, hooks, fetchImpl = fetch, now = Date.now }) {
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
    this.turnSession = null;
    this.capability = "";
    this.stopped = false;
    this.sendVersion = 0;
    this.fetchImpl = fetchImpl;
    this.now = now;
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

  async send(text, { model, effort, resetEffort, fastMode, fastCredential, fastState, fastCooldown, onFastConstraint, onPermissionMode, mode = "accept_edits", systemPrompt } = {}) {
    const version = this.sendVersion;
    const configuration = claudeConfigRequest(text);
    const fastRequest = claudeFastRequest(text);
    const mcpRequest = claudeMcpRequest(text);
    // The native review handler checkpoints its journal only when it returns.
    // Keep its SDK input open so Stop can cancel the query and let it flush.
    const reviewRequest = /^\/code-review(?:\s|$)/.test(text.trimStart());
    const applicationRequest = /^\/(?:run|verify)(?:\s|$)/.test(text.trimStart());
    const interactive = this.config.claude.authMode === "gateway" && Boolean(this.hooks.onRequest);
    if (mcpRequest?.action && this.config.claude.authMode !== "gateway") throw new Error(CLAUDE_MCP_PRIVATE_ERROR);
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
    if (fastRequest && !enableFast) {
      // A retained CLI can still service its own background notifications.
      // Turn Fast off there now, not only on the next foreground message.
      if (this.applicationSession && !this.applicationSession.ended) await this.applicationSession.control.request("apply_flag_settings", { settings: { fastMode: false } });
      if (version !== this.sendVersion) throw Error("Claude turn interrupted");
      return { text: "Fast mode OFF (this chat only).", status: "completed", nativeFast: { state: "off" }, fastPreference: false, fastCooldown: null };
    }
    const heldCooldown = !enableFast && fastMode === true && sameAccount && Number.isSafeInteger(fastCooldown?.until) && fastCooldown.until > this.now() && ["rate_limit", "overloaded"].includes(fastCooldown.reason) ? fastCooldown : null;
    if (heldCooldown) this.hooks.onEvent?.({ type: "notice", text: "Claude Fast is cooling down. This turn uses standard speed until the saved provider retry time; /fast off disables Fast." });
    let availability, fastFallback = null;
    if (fastMode === true && !sameAccount && !enableFast) {
      fastMode = false; fastFallback = { state: "off", disabledReason: "unknown" };
      this.hooks.onEvent?.({ type: "notice", text: "Claude credentials changed. Fast is off for this chat; use /fast on to authorize it for the current account." });
    }
    if (enableFast || fastMode === true && !heldCooldown) {
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
    const sessionId = this.sessionId || randomUUID();
    // These native handlers create a resumable journal only on completion.
    // Preflight, startup and forced-stop failures must not retain a missing ID.
    const provisionalSession = isNew && (mcpRequest?.action || reviewRequest || applicationRequest);
    if (isNew && !provisionalSession) {
      this.sessionId = sessionId;
      await this.hooks.onSessionId?.(sessionId);
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
    const inspect = async (filename = "settings.json") => {
      const controller = new AbortController(); this.settingsInspection = controller;
      try {
        const value = await inspectClaudeSettings({ runtimeHome: this.runtimeHome, executor: this.executor, isolation: this.config.processIsolation, signal: controller.signal, filename });
        if (version !== this.sendVersion) throw new Error("Interrupted");
        return value;
      } catch { throw new Error("Cannot safely verify this chat's private Claude settings. The command queue is paused; check the private profile before retrying."); }
      finally { if (this.settingsInspection === controller) this.settingsInspection = null; }
    };
    const beforeSettings = configuration?.mutate ? await inspect() : null;
    if (mcpRequest?.action) await inspect(".claude.json");
    // /fast on promotes non-Opus aliases by native contract. Apply that model
    // at startup too: print-mode 2.1.222 otherwise reports the PRE-command
    // Sonnet model's Fast state as off even after saying it switched to Opus.
    // Native model/organization policy still validates the selected Opus.
    const launchModel = enableFast && !/^opus(?:\[1m\])?$/.test(requestedModel || "") ? "opus" : requestedModel;

    const args = [
      "--print",
      "--verbose",
      "--output-format", "stream-json",
      ...(mcpRequest?.action || reviewRequest || interactive ? ["--input-format", "stream-json"] : []),
      ...(interactive ? ["--permission-prompt-tool", "stdio"] : []),
      "--include-partial-messages",
      "--permission-mode", nativeMode,
      "--prompt-suggestions", "false",
      "--add-dir", uploads,
      ...(systemPrompt ? ["--append-system-prompt", systemPrompt] : []),
      ...(this.executor?.mcpServers && Object.keys(this.executor.mcpServers).length ? ["--mcp-config", JSON.stringify({ mcpServers: this.executor.mcpServers })] : []),
      ...(isNew ? ["--session-id", sessionId] : ["--resume", sessionId]),
      ...(launchModel ? ["--model", launchModel] : []),
      ...(effort ? ["--effort", effort] : []),
      ...(enableFast || typeof fastMode === "boolean" ? ["--settings", JSON.stringify({ fastMode: enableFast || fastMode && !heldCooldown })] : []),
    ];

    if (version !== this.sendVersion) throw new Error("Claude turn interrupted");
    if (availability?.enabled && credential !== claudeFastCredential(this.config.claude)) throw new Error("Claude credentials changed during the Fast availability check. Retry with the current account.");

    let feedback = null;
    const unobserve = this.config.claude.authMode === "gateway" ? this.broker.observeProvider(this.capability, "anthropic", value => {
      if (version !== this.sendVersion || value.credential !== credential) return;
      if (value.type === "disabled" && feedback?.type !== "disabled") {
        feedback = value;
        onFastConstraint?.(value);
        this.hooks.onEvent?.({ type: "notice", text: `${claudeFastUnavailable(value.reason)} Continuing at standard speed; use /fast on after account access is restored.` });
      } else if (value.type === "cooldown" && feedback?.type !== "disabled") {
        if (!feedback) this.hooks.onEvent?.({ type: "notice", text: "Claude Fast reached a provider limit. Continuing at standard speed; the cooldown will be retained for subsequent turns." });
        if (!feedback || value.until > feedback.until) { feedback = value; onFastConstraint?.(value); }
      }
    }) : () => {};
    this.providerObservation = unobserve;
    const finishObservation = () => { unobserve(); if (this.providerObservation === unobserve) this.providerObservation = null; };
    const previousModeObserver = this.modeObserver;
    const modeObserver = { sessionId, version, onPermissionMode };
    this.modeObserver = modeObserver;
    let child, managed;
    const spawn = launchArgs => this.executor
      ? this.executor.spawn(this.config.claude.bin, launchArgs, {
          cwd: this.workspace,
          env,
          stdio: ["pipe", "pipe", "pipe"],
        })
      : spawnWorker(this.config.claude.bin, launchArgs, {
          isolation: this.config.processIsolation,
          cwd: this.workspace,
          env,
          stdio: ["pipe", "pipe", "pipe"],
        });
    try {
      if (this.applicationSession?.ended) this.applicationSession = null;
      const manage = launchArgs => new ClaudeSession(spawn(launchArgs), args, env, event => this.backgroundEvent(event),
        interactive ? { requestHooks: this.hooks, cwd: this.workspace } : {});
      if (!this.applicationSession && applicationRequest) {
        const launchArgs = args.includes("--input-format") ? args : [...args, "--input-format", "stream-json"];
        this.applicationSession = manage(launchArgs);
      }
      managed = this.applicationSession || (interactive ? manage(args) : null);
      this.turnSession = managed;
      child = managed ? await managed.open(args, env) : spawn(args);
      if (version !== this.sendVersion) throw Error("Claude turn interrupted");
    } catch (error) {
      finishObservation();
      if (this.modeObserver === modeObserver) this.modeObserver = previousModeObserver;
      if (managed && managed !== this.applicationSession) await managed.stop();
      if (this.turnSession === managed) this.turnSession = null;
      // Failed first initialization must not leave a live, unaddressable CLI
      // or retry a provisional session whose journal was never checkpointed.
      if (provisionalSession && !this.sessionId) {
        await this.applicationSession?.stop(); this.applicationSession = null;
      }
      throw error;
    }
    this.child = child;
    if (provisionalSession) this.sessionId = sessionId;
    const mcpControl = mcpRequest?.action ? new ClaudeControlChannel(child) : null;
    const reviewControl = reviewRequest ? new ClaudeControlChannel(child, 2000) : null;
    if (reviewControl) {
      this.reviewInterruption = async () => {
        let timer, onClose;
        const closed = new Promise(resolve => { onClose = resolve; child.once("close", onClose); });
        try {
          await reviewControl.request("interrupt");
          child.stdin.end();
          await Promise.race([closed, new Promise(resolve => { timer = setTimeout(resolve, 2000); })]);
        } catch { /* Native startup/transport failure still falls back to termination. */ }
        finally { clearTimeout(timer); child.removeListener("close", onClose); }
      };
      child.stdin.write(`${JSON.stringify({ type: "user", message: { role: "user", content: text } })}\n`);
    }
    let mcpOutcome = null, mcpError = null;
    if (!mcpControl && !reviewControl) {
      const input = fastRequest ? "/fast on" : text;
      child.stdin.end(interactive ? `${JSON.stringify({ type: "user", message: { role: "user", content: input } })}\n` : input);
    }

    const output = new ClaudeTextStream(delta => this.hooks.onEvent?.({ type: "assistant_delta", delta }));
    let resultMessage = null;
    let nativeFast = null;
    const notifications = new Set();
    let compacted = false;
    let lastRequest = null;
    const sampleId = randomUUID();
    let resultBaseline = null, resultCount = 0;
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
      mcpControl?.accept(event);
      reviewControl?.accept(event);
      this.permissionMode(event);
      if (!mcpControl) output.accept(event);
      if (event.type === "system" && event.subtype === "notification" && ["fast-mode-overage-rejected", "fast-mode-org-changed", "fast-mode-cooldown-started", "fast-mode-cooldown-expired", "stop-hook-error"].includes(event.key) && typeof event.text === "string" && !notifications.has(event.key)) {
        notifications.add(event.key);
        this.hooks.onEvent?.({ type: "notice", text: event.key === "stop-hook-error" ? "Claude reported a Stop-hook error. The completion check failed; use /goal to inspect any active goal or check the native hook settings." : redact(event.text).slice(0, 1500) });
      }
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
      if (event.type === "assistant") {
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
        if (reviewControl) child.stdin.end();
        nativeFast = claudeFastState(event);
        // Resuming a stopped background task can emit an empty local result
        // before the actual model reply, even in one-shot mode. Each native
        // result needs its own sample; process totals still need deltas.
        const usageResult = managed ? event : claudeCallResult(event, resultBaseline);
        resultBaseline = event;
        this.hooks.onEvent?.({ type: "usage", usage: claudeUsage(usageResult, lastRequest, `${sampleId}:${event.uuid || ++resultCount}`) });
        for (const itemId of activeTools.keys()) completeTool(itemId, "", false, true);
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
        if (provisionalSession) this.sessionId = null;
        if (reviewControl) this.reviewInterruption = null;
        finishObservation();
        if (this.child === child) this.child = null;
        reject(error);
      });
      child.once("close", (code, signal) => { void (async () => {
        finishObservation();
        if (managed && managed !== this.applicationSession) await managed.stop();
        if ((!managed || managed !== this.applicationSession) && this.modeObserver === modeObserver) this.modeObserver = null;
        if (this.turnSession === managed) this.turnSession = null;
        if (spawnFailed) return;
        mcpControl?.close();
        reviewControl?.close();
        if (reviewControl) this.reviewInterruption = null;
        if (this.child === child) this.child = null;
        const checkpointed = resultMessage?.subtype === "success" && resultMessage.is_error !== true;
        // Application prompts journal their interrupted query as a native
        // error result (unlike the bundled review's success checkpoint).
        const applicationCheckpoint = applicationRequest && version !== this.sendVersion && resultMessage?.subtype === "error_during_execution" && resultMessage.session_id === sessionId;
        if (provisionalSession) {
          // Graceful review cancellation still returns and saves its journal.
          // Preserve that checkpoint even though the running turn was stopped.
          this.sessionId = applicationCheckpoint || checkpointed && (reviewControl || applicationRequest || version === this.sendVersion) ? sessionId : null;
          if (this.sessionId) await this.hooks.onSessionId?.(this.sessionId);
          else if (this.applicationSession) { await this.applicationSession.stop(); this.applicationSession = null; }
        }
        if (version !== this.sendVersion) throw new Error("Claude turn interrupted");
        if (mcpError) throw mcpError;
        if (mcpControl && (!mcpOutcome || !checkpointed)) throw new Error("Claude MCP control stopped before verification");
        if (mcpOutcome) {
          await this.hooks.onEvent?.({ type: "session_capabilities", connectors: mcpOutcome.connectors });
          if (mcpOutcome.failed) throw new Error(mcpOutcome.text);
        }
        const nativeSettings = beforeSettings ? claudeSettingsChanges(beforeSettings, await inspect(), configuration) : undefined;
        const resultFailed = resultMessage && (
          resultMessage.is_error === true ||
          (resultMessage.subtype && resultMessage.subtype !== "success")
        );
        const confirmedFast = enableFast && code === 0 && !resultFailed && nativeFast && nativeFast.state !== "off" && !nativeFast.disabledReason;
        let fastResult = { ...(nativeFast || fastFallback ? { nativeFast: fastFallback || nativeFast } : {}), fastCooldown: null,
          ...(confirmedFast ? { fastPreference: true, fastModel: launchModel, fastCredential: credential } : fastFallback ? { fastPreference: false } : {}) };
        if (feedback?.type === "disabled") fastResult = { nativeFast: { state: "off", disabledReason: feedback.reason }, fastPreference: false, fastCooldown: null };
        else if (feedback?.type === "cooldown" || heldCooldown) {
          const cooldown = feedback?.type === "cooldown" ? { until: feedback.until, reason: feedback.reason } : heldCooldown;
          fastResult = { ...fastResult, nativeFast: { state: "cooldown" }, fastCooldown: cooldown };
        }
        if (code === 0 && !resultFailed) {
          if (enableFast && (!nativeFast || nativeFast.state === "off" || nativeFast.disabledReason)) throw Object.assign(new Error(claudeFastUnavailable(nativeFast?.disabledReason)), { nativeFast });
          resolve({ text: mcpOutcome?.text ?? output.text, status: "completed", compacted, ...(nativeSettings ? { nativeSettings } : {}), ...fastResult, ...(feedback && onFastConstraint ? { fastConstraintObserved: true } : {}) });
        } else {
          reject(Object.assign(new Error(`Claude worker exited ${code ?? signal}: ${redact(resultMessage?.result || stderr || "unknown error")}`), { nativeSettings, ...fastResult, ...(feedback && onFastConstraint ? { fastConstraintObserved: true } : {}) }));
        }
      })().catch(reject); });
      if (mcpControl) void runClaudeMcpCommand(mcpControl, mcpRequest, { initialize: !managed }).then(outcome => {
        if (version !== this.sendVersion) throw Error("Claude turn interrupted");
        mcpOutcome = outcome;
        // A local status command checkpoints the native session journal after
        // the SDK action. It cannot invoke a model or repeat the mutation.
        // Relay displays the verified outcome, not terminal-only instructions.
        child.stdin.end(`${JSON.stringify({ type: "user", message: { role: "user", content: "/mcp" } })}\n`);
      }).catch(error => { mcpError = error; void terminateWorker(child); });
    });
  }

  async respond(requestId, payload) {
    const requests = this.turnSession?.requests || this.applicationSession?.requests;
    if (!requests || this.stopped) throw Object.assign(Error("Claude request is no longer active"), { statusCode: 409 });
    await requests.respond(requestId, payload);
  }

  permissionMode(event) {
    const observer = this.modeObserver;
    if (this.stopped || !observer || observer.version !== this.sendVersion) return;
    const mode = claudePermissionMode(event, observer.sessionId);
    if (!mode) return;
    const failed = () => {
      if (!this.stopped && this.modeObserver === observer && observer.version === this.sendVersion) {
        this.hooks.onFatal?.(Error("Claude permission-mode state could not be synchronized. Recheck the selected mode before continuing."));
      }
    };
    try { void Promise.resolve(observer.onPermissionMode?.(mode)).catch(failed); }
    catch { failed(); }
  }

  backgroundEvent(event) {
    this.permissionMode(event);
    if (this.stopped || !["assistant", "stream_event", "result"].includes(event.type)) return;
    this.backgroundOutput ||= new ClaudeTextStream(() => {});
    this.backgroundOutput.accept(event);
    if (event.type === "assistant" && !event.parent_tool_use_id && event.message?.usage) this.backgroundRequest = event.message;
    if (event.type === "result") {
      this.hooks.onEvent?.({ type: "usage", usage: claudeUsage(event, this.backgroundRequest, randomUUID()) });
      const failed = event.is_error === true || Boolean(event.subtype && event.subtype !== "success");
      const text = this.backgroundOutput.text || (failed ? redact(event.result || "Claude background task failed") : "");
      if (text) this.hooks.onEvent?.({ type: "background_response", text, failed });
      this.backgroundOutput = null; this.backgroundRequest = null;
    }
  }

  async interrupt() {
    this.sendVersion += 1;
    this.modeObserver = null;
    (this.turnSession?.requests || this.applicationSession?.requests)?.cancel();
    this.settingsInspection?.abort();
    this.fastInspection?.abort();
    this.providerObservation?.(); this.providerObservation = null;
    // Application turns are logical children: interrupt their native query,
    // retaining the CLI and its background servers. Other turns are one-shot.
    const child = this.child;
    await this.reviewInterruption?.();
    if (child) await terminateWorker(child);
    else if (this.turnSession?.pending) await this.turnSession.stop();
  }

  async stop() {
    this.sendVersion += 1;
    this.modeObserver = null;
    this.settingsInspection?.abort();
    this.fastInspection?.abort();
    this.providerObservation?.(); this.providerObservation = null;
    this.stopped = true;
    (this.turnSession?.requests || this.applicationSession?.requests)?.cancel();
    const child = this.child;
    this.child = null;
    await this.reviewInterruption?.();
    if (child) await terminateWorker(child);
    await this.turnSession?.stop(); this.turnSession = null;
    await this.applicationSession?.stop(); this.applicationSession = null;
    this.broker.revokeChat(this.chat.id);
    this.capability = "";
  }
}
