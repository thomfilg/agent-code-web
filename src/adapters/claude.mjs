import { createHash, randomUUID } from "node:crypto";
import readline from "node:readline";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { buildWorkerEnvironment, spawnWorker, terminateWorker } from "../worker-process.mjs";
import { errorMessage, redact } from "../utils.mjs";
import { claudeUsage, claudeContext, claudeRateLimits, safeSessionDetails } from "../session-info.mjs";
import { CLAUDE_PERMISSION_MODES, claudeConfigRequest, claudeSettingsChanges, inspectClaudeSettings, inspectNativeClaudeSettings, claudePermissionMode } from "../claude-settings.mjs";
import { claudeFastRequest, claudeFastState, claudeFastCredential, claudeFastScope, checkClaudeFastAvailability, claudeFastUnavailable } from "../claude-fast.mjs";
import { ClaudeTextStream } from "../claude-text-stream.mjs";
import { SecretTextStream } from "../secret-text-stream.mjs";
import { capabilityMcpServers } from "../worker-capabilities.mjs";
import { claudeMcpRequest, CLAUDE_MCP_PRIVATE_ERROR, ClaudeControlChannel, runClaudeMcpCommand } from "../claude-mcp.mjs";
import { ClaudeSession, claudeCallResult, CLAUDE_SCHEDULE_DIAGNOSTICS } from "../claude-session.mjs";
import { claudePluginReloadRequest, reloadClaudePlugins, CLAUDE_PLUGIN_PRIVATE_ERROR } from "../claude-plugins.mjs";
import { claudeDebugRequest, CLAUDE_DEBUG_PRIVATE_ERROR } from "../claude-debug.mjs";
import { ClaudeWorkspaceTrust, claudeTrustProbe } from "../claude-workspace-trust.mjs";
import { claudeCommandMetadata } from "../command-catalog.mjs";
import { claudeFinalAnswer } from "../message-search.mjs";
import { ClaudeAgentThreads } from "../claude-agent-threads.mjs";

const accountCredentialHash = credentials => createHash("sha256").update(JSON.stringify([
  credentials?.accountId || null, credentials?.organizationId || null, credentials?.accessToken || null,
])).digest("hex");
const providerCredentialHash = config => createHash("sha256").update(JSON.stringify([
  "anthropic", config.providerKey || null, config.upstreamBaseUrl || null,
])).digest("hex");

export class ClaudeAdapter {
  constructor({ chat, store, config, broker, gatewayOrigin, executor = null, hooks, fetchImpl = fetch, now = Date.now }) {
    this.chat = chat;
    this.store = store;
    this.nativeAuthMode = chat.agentAccountId ? "account" : config.claude.authMode;
    this.config = chat.agentAccountId ? { ...config, claude: { ...config.claude, authMode: "account", providerKey: null, accountId: chat.agentAccountId, upstreamBaseUrl: "https://api.anthropic.com" } } : config;
    this.broker = broker;
    this.executor = executor;
    this.gatewayOrigin = executor?.gatewayOrigin || gatewayOrigin;
    this.workspace = executor?.workspace || chat.workspace;
    this.runtimeHome = executor?.runtimeHome || store.runtimeHome(chat.id);
    this.hooks = hooks;
    this.sessionId = chat.agentSessionId;
    // A hibernated native application is adopted on the first request after
    // wake. Never launch a replacement CLI while that exact process is
    // retained by the worker supervisor.
    this.recoverApplication = chat.suspension?.nativeRetained === true;
    this.retainedCapabilities = executor?.retainedCapabilities || null;
    this.child = null;
    this.turnSession = null;
    this.capability = "";
    this.stopped = false;
    this.sendVersion = 0;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.accountSecrets = new Set(executor?.capabilitySecrets || []);
    if (chat.agentAccountId || this.accountSecrets.size) this.hooks = { ...hooks,
      ...(hooks.onEvent ? { onEvent: event => hooks.onEvent(this.redactAccount(event)) } : {}),
      ...(hooks.onLog ? { onLog: text => hooks.onLog(this.redactAccount(text)) } : {}),
      ...(hooks.onRequest ? { onRequest: request => hooks.onRequest(this.redactAccount(request)) } : {}), ...(chat.agentAccountId ? { accountCredentials: async options => {
      const credentials = await hooks.accountCredentials(options);
      if (typeof credentials?.accessToken !== "string" || !credentials.accessToken || !credentials.accountId || !credentials.organizationId || credentials.expiresAt <= this.now()) throw Error("Reconnect this Claude account; no other credentials were used.");
      this.accountSecrets.add(credentials.accessToken);
      this.currentAccountCredentialHash = accountCredentialHash(credentials);
      return credentials;
    } } : {}) };
  }

  get privateProfile() { return this.config.claude.authMode !== "host"; }

  redactAccount(value) {
    if (this.nativeAuthMode !== "account" && !this.accountSecrets.size) return value;
    let raw = JSON.stringify(value, (_key, item) => {
      if (typeof item !== "string") return item;
      for (const secret of [...this.accountSecrets].sort((a, b) => b.length - a.length)) item = item.replaceAll(secret, "[redacted]");
      return item;
    });
    return JSON.parse(raw.replace(/sk-ant-[A-Za-z0-9_-]{8,}/g, "[redacted]"));
  }

  async start() {
    const authMode = this.config.claude.authMode;
    if (authMode === "account") this.assertRetainedAccountCredential(await this.hooks.accountCredentials({}));
    if (authMode === "gateway" && !this.config.claude.providerKey) {
      throw new Error("ANTHROPIC_API_KEY is required when CLAUDE_AUTH_MODE=gateway");
    }
    if (authMode === "gateway") {
      const scope = claudeFastScope(this.chat), credential = claudeFastCredential(this.config.claude), upstream = this.config.claude.upstreamBaseUrl;
      const retained = this.recoverApplication ? this.retainedCapabilities?.provider : null;
      if (this.recoverApplication && (retained?.provider !== "anthropic" || !/^cap_[A-Za-z0-9_-]{43}$/.test(retained?.token || "")
        || retained.credentialHash !== providerCredentialHash(this.config.claude))) {
        throw new Error("The retained Claude provider capability is invalid");
      }
      const grant = { chatId: this.chat.id, provider: "anthropic", renewable: true, validWhile: () => {
        const current = this.store.get(this.chat.id);
        return !this.stopped && current && !current.archived && claudeFastScope(current) === scope
          && claudeFastCredential(this.config.claude) === credential && this.config.claude.upstreamBaseUrl === upstream
          && (this.executor?.workspace || this.chat.workspace) === this.workspace
          && (this.executor?.runtimeHome || this.store.runtimeHome(this.chat.id)) === this.runtimeHome;
      } };
      this.capability = retained ? this.broker.restoreToken({ token: retained.token, ...grant }) : this.broker.issue(grant);
    }
    this.stopped = false;
    this.effortEnvironmentNotified = false;
  }

  assertCapability() {
    if ((this.capability || this.config.claude.authMode === "gateway") && !this.broker.validate(this.capability, "anthropic")) {
      throw new Error("Claude's temporary gateway access expired or its account/profile changed. Stop the worker and retry to establish a new session capability; the running application has not been restarted.");
    }
  }

  async workspaceTrust(action, input, binding, guard) {
    if (!this.privateProfile) throw Error("Workspace trust requires this chat's private Claude profile. Shared host profiles remain locked.");
    if (this.stopped || this.child || this.turnSession?.pending || this.isBackgroundBusy() || this.hasScheduledWork()) throw Object.assign(Error("Wait for native Claude work and schedules to finish before reviewing workspace trust."), { statusCode: 409 });
    this.assertCapability();
    if (!this.trustControls || this.trustControls.closed) this.trustControls = new ClaudeWorkspaceTrust({ workspace: this.workspace, now: this.now, open: async signal => {
      const check = () => { signal.throwIfAborted(); this.assertCapability(); if (this.stopped) throw Error("Workspace trust inspection stopped"); };
      const ensureDirectory = directory => this.executor ? this.executor.mkdir(directory) : mkdir(directory, { recursive: true, mode: 0o700 });
      const neutral = path.join(this.runtimeHome, "claude-trust");
      if (neutral === this.workspace || neutral.startsWith(`${this.workspace}/`)) throw Error("Workspace trust inspection requires a private directory outside the workspace.");
      check(); await ensureDirectory(this.runtimeHome);
      for (const filename of ["settings.json", ".claude.json"]) {
        await inspectClaudeSettings({ runtimeHome: this.runtimeHome, executor: this.executor, isolation: this.config.processIsolation, signal, filename }); check();
      }
      await ensureDirectory(neutral);
      await inspectClaudeSettings({ runtimeHome: neutral, executor: this.executor, isolation: this.config.processIsolation, signal }); check();
      const env = await buildWorkerEnvironment({ chat: this.chat, store: this.store, runtimeHome: this.runtimeHome, provider: "anthropic", authMode: this.nativeAuthMode,
        capability: this.capability, gatewayOrigin: this.gatewayOrigin, ensureDirectory, environmentVariables: this.executor?.environmentVariables, environmentPath: this.executor?.environmentPath });
      if (this.nativeAuthMode === "account") this.applyAccountEnvironment(env, await this.hooks.accountCredentials({}));
      await ensureDirectory(env.CLAUDE_CONFIG_DIR); check();
      // Use the existing chat capability. Issuing another would revoke a
      // retained application's owner. No user turn, hooks or MCP startup here.
      const child = (this.executor?.spawn?.bind(this.executor) || spawnWorker)(this.config.claude.bin,
        ["--print", "--verbose", "--output-format", "stream-json", "--input-format", "stream-json", "--permission-mode", "default", "--permission-prompt-tool", "stdio",
          "--tools", "", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--settings", '{"disableAllHooks":true}'],
        { cwd: neutral, env, isolation: this.config.processIsolation, stdio: ["pipe", "pipe", "pipe"] });
      return claudeTrustProbe(child, signal);
    } });
    return this.trustControls.run(action, input, binding, async () => { await guard(); this.assertCapability(); });
  }

  async disableFast(version) {
    this.assertCapability();
    // A retained CLI can still service background notifications between web
    // turns. A denied opt-in must switch it off, not just change the UI state.
    if (this.applicationSession && !this.applicationSession.ended) await this.applicationSession.control.request("apply_flag_settings", { settings: { fastMode: false } });
    if (version !== this.sendVersion) throw Error("Claude turn interrupted");
  }

  async reloadPlugins(session, version) {
    const check = () => { if (version !== this.sendVersion) throw Error("Claude turn interrupted"); this.assertCapability(); };
    check();
    const settled = Promise.withResolvers(); this.pluginReload = settled.promise;
    let verified = false;
    try {
      const outcome = await reloadClaudePlugins(session.control);
      verified = outcome.errorCount === 0;
      check();
      await this.hooks.onEvent?.({ type: "command_catalog", commands: outcome.commands });
      check();
      await this.hooks.onEvent?.({ type: "session_capabilities", connectors: outcome.connectors });
      check();
      if (outcome.errorCount) throw Error(`${outcome.text} ${outcome.errorCount} component load error(s); review the private plugin configuration and retry /reload-plugins.`);
      return outcome;
    } finally {
      if (this.pluginReload === settled.promise) this.pluginReload = null;
      settled.resolve(verified);
    }
  }

  async send(text, { model, effort, resetEffort, ultracode, selectionCurrent, fastMode, fastCredential, fastState, fastCooldown, onFastConstraint, onPermissionMode, mode = "accept_edits", systemPrompt } = {}) {
    const version = this.sendVersion;
    const configuration = claudeConfigRequest(text);
    const settingsPrompt = configuration?.kind === "prompt";
    const diagnostic = configuration?.diagnostic === true;
    const fastRequest = claudeFastRequest(text);
    const mcpRequest = claudeMcpRequest(text);
    const pluginReload = claudePluginReloadRequest(text);
    const debugRequest = claudeDebugRequest(text);
    // The native review handler checkpoints its journal only when it returns.
    // Keep its SDK input open so Stop can cancel the query and let it flush.
    const reviewRequest = /^\/code-review(?:\s|$)/.test(text.trimStart());
    const applicationRequest = this.recoverApplication || /^\/(?:run|verify)(?:\s|$)/.test(text.trimStart());
    const interactive = this.privateProfile && Boolean(this.hooks.onRequest || this.hooks.accountCredentials);
    if (ultracode === true && (!this.privateProfile || effort !== "xhigh")) throw new Error("Ultracode requires a private Claude session with xhigh effort.");
    if (ultracode === true && (mcpRequest?.action || reviewRequest)) throw new Error("Ultracode confirmation is not supported for this native command yet. Select ordinary effort before running it; this chat's saved mode has not changed.");
    // Normal private turns need false readback too, even without interactive
    // permission hooks. Control-only MCP and native review retain their separate
    // transports, never a second control channel over a managed logical turn.
    const ultracodeSession = this.privateProfile && typeof ultracode === "boolean" && !mcpRequest?.action && !reviewRequest;
    if (mcpRequest?.action && !this.privateProfile) throw new Error(CLAUDE_MCP_PRIVATE_ERROR);
    if (pluginReload && !this.privateProfile) throw Error(CLAUDE_PLUGIN_PRIVATE_ERROR);
    if (debugRequest && !this.privateProfile) throw Error(CLAUDE_DEBUG_PRIVATE_ERROR);
    if (fastRequest && !this.privateProfile) throw new Error("Fast changes require a private Claude profile; shared host profiles remain locked until company/profile isolation is complete.");
    if (configuration?.mutate && !this.privateProfile) throw new Error("Native settings changes require a private Claude profile. This worker uses a shared host profile; shared settings writes are locked until company/profile isolation is complete.");
    const nativeMode = Object.keys(CLAUDE_PERMISSION_MODES).find(key => CLAUDE_PERMISSION_MODES[key] === mode);
    if (!nativeMode) throw new Error("Unsupported Claude permission mode");
    if (this.child || this.pluginReload || this.settingsInspection || this.fastInspection || this.debugInspection || this.trustControls?.pending) throw new Error("A Claude turn is already running for this chat");
    if (this.stopped || (this.config.claude.authMode === "gateway" && !this.capability)) await this.start();
    this.assertCapability();

    const accountCredentials = this.nativeAuthMode === "account" ? await this.hooks.accountCredentials({}) : null;
    if (accountCredentials) this.assertRetainedAccountCredential(accountCredentials);

    const credential = claudeFastCredential(this.config.claude);
    const sameAccount = fastCredential === credential;
    const requestedModel = model || this.config.claude.model;
    const activeFast = fastMode === true && sameAccount && (fastState ? fastState !== "off" : /^opus(?:\[1m\])?$/.test(requestedModel || ""));
    const enableFast = fastRequest === "on" || (fastRequest === "toggle" && !activeFast);
    // Turning it off must always work, including after account access is lost.
    // The following turn explicitly starts with fastMode:false; no inference,
    // account lookup or global Claude settings write is needed for this action.
    if (fastRequest && !enableFast) {
      await this.disableFast(version);
      return { text: "Fast mode OFF (this chat only).", status: "completed", nativeFast: { state: "off" }, fastPreference: false, fastCooldown: null };
    }
    const heldCooldown = !enableFast && fastMode === true && sameAccount && Number.isSafeInteger(fastCooldown?.until) && fastCooldown.until > this.now() && ["rate_limit", "overloaded"].includes(fastCooldown.reason) ? fastCooldown : null;
    if (heldCooldown) this.hooks.onEvent?.({ type: "notice", text: "Claude Fast is cooling down. This turn uses standard speed until the saved provider retry time; /fast off disables Fast." });
    let availability, fastFallback = null;
    if (fastMode === true && !sameAccount && !enableFast) {
      fastMode = false; fastFallback = { state: "off", disabledReason: "unknown" };
      this.hooks.onEvent?.({ type: "notice", text: "Claude credentials changed. Fast is off for this chat; use /fast on to authorize it for the current account." });
    }
    if (!pluginReload && (enableFast || fastMode === true && !heldCooldown)) {
      const controller = new AbortController(); this.fastInspection = controller;
      try {
        availability = await checkClaudeFastAvailability({ ...this.config.claude, ...(accountCredentials ? { accessToken: accountCredentials.accessToken } : {}) }, { signal: controller.signal, fetchImpl: this.fetchImpl });
        if (version !== this.sendVersion) throw new Error("Claude turn interrupted");
        if (!availability.enabled) throw Object.assign(new Error(claudeFastUnavailable(availability.disabledReason)), { nativeFast: { state: "off", disabledReason: availability.disabledReason } });
      } catch (error) {
        if (!controller.signal.aborted && version === this.sendVersion && !error.nativeFast) error.nativeFast = { state: "off", disabledReason: "network_error" };
        if (controller.signal.aborted || version !== this.sendVersion) throw error;
        if (enableFast) {
          await this.disableFast(version);
          throw Object.assign(error, { fastPreference: false, fastCooldown: null });
        }
        fastMode = false; fastFallback = error.nativeFast;
        this.hooks.onEvent?.({ type: "notice", text: `${error.message} Continuing at standard speed; use /fast on to retry.` });
      } finally { if (this.fastInspection === controller) this.fastInspection = null; }
    }

    const isNew = !this.sessionId;
    const sessionId = this.sessionId || this.applicationSession?.sessionId || randomUUID();
    // These native handlers create a resumable journal only on completion.
    // Preflight, startup and forced-stop failures must not retain a missing ID.
    const provisionalSession = isNew && (mcpRequest?.action || reviewRequest || applicationRequest || pluginReload || debugRequest);
    if (isNew && !provisionalSession && !interactive && !settingsPrompt && !ultracodeSession) {
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
    if (accountCredentials) this.applyAccountEnvironment(env, accountCredentials);
    await ensureDirectory(env.CLAUDE_CONFIG_DIR);
    // Only this chat's uploaded files join its permitted working directories.
    // Do not grant access to the controller or other chats' runtime homes.
    const uploads = path.join(this.runtimeHome, "uploads");
    await ensureDirectory(uploads);
    // SDK sessions can clear effort natively. A startup environment override
    // would otherwise pin Auto and silently defeat all later picker changes.
    const usesSession = interactive || ultracodeSession || applicationRequest || pluginReload || settingsPrompt || debugRequest || this.applicationSession && !this.applicationSession.ended;
    if (resetEffort && !usesSession) env.CLAUDE_CODE_EFFORT_LEVEL = "auto";
    if (usesSession && env.CLAUDE_CODE_EFFORT_LEVEL && !this.effortEnvironmentNotified) {
      this.hooks.onEvent?.({ type: "notice", text: "Claude's worker environment sets CLAUDE_CODE_EFFORT_LEVEL. It may override the web effort selection; use /effort status to check the effective native level." });
      this.effortEnvironmentNotified = true;
    }
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
        const value = await inspectClaudeSettings({ runtimeHome: this.runtimeHome, executor: this.executor, isolation: this.config.processIsolation, signal: controller.signal, filename, pathOnly: diagnostic });
        if (version !== this.sendVersion) throw new Error("Interrupted");
        return value;
      } catch { throw new Error("Cannot safely verify this chat's private Claude settings. The command queue is paused; check the private profile before retrying."); }
      finally { if (this.settingsInspection === controller) this.settingsInspection = null; }
    };
    const beforeSettings = configuration?.mutate ? await inspect() : null;
    if (diagnostic) await inspect(".claude.json");
    let beforeNativeSettings;
    const inspectNative = async session => {
      const controller = new AbortController(); this.settingsInspection = controller;
      try {
        const value = await inspectNativeClaudeSettings(session.control, controller.signal, { diagnostic });
        if (version !== this.sendVersion) throw Error("Interrupted");
        this.assertCapability();
        return value;
      } catch { throw Error("Cannot safely verify this chat's effective Claude settings. The command queue is paused; check the private configuration before retrying."); }
      finally { if (this.settingsInspection === controller) this.settingsInspection = null; }
    };
    if (mcpRequest?.action) await inspect(".claude.json");
    if (pluginReload) { await inspect(".claude.json"); await inspect(); }
    // /fast on promotes non-Opus aliases by native contract. Apply that model
    // at startup too: print-mode 2.1.222 otherwise reports the PRE-command
    // Sonnet model's Fast state as off even after saying it switched to Opus.
    // Native model/organization policy still validates the selected Opus.
    const launchModel = enableFast && !/^opus(?:\[1m\])?$/.test(requestedModel || "") ? "opus" : requestedModel;

    const args = [
      "--print",
      "--verbose",
      "--output-format", "stream-json",
      ...(mcpRequest?.action || reviewRequest || interactive || ultracodeSession || pluginReload || settingsPrompt || debugRequest ? ["--input-format", "stream-json"] : []),
      ...(interactive ? ["--permission-prompt-tool", "stdio"] : []),
      ...(this.privateProfile && usesSession ? CLAUDE_SCHEDULE_DIAGNOSTICS : []),
      "--include-partial-messages",
      "--permission-mode", nativeMode,
      "--prompt-suggestions", "false",
      "--add-dir", uploads,
      ...(systemPrompt ? ["--append-system-prompt", systemPrompt] : []),
      ...(this.executor?.mcpServers && Object.keys(this.executor.mcpServers).length ? ["--mcp-config", JSON.stringify({ mcpServers: capabilityMcpServers(this.executor.mcpServers, this.accountSecrets, env, "claude") })] : []),
      ...(isNew ? ["--session-id", sessionId] : ["--resume", sessionId]),
      ...(launchModel ? ["--model", launchModel] : []),
      ...(effort ? ["--effort", effort] : []),
      ...(enableFast || typeof fastMode === "boolean" || typeof ultracode === "boolean" ? ["--settings", JSON.stringify({
        ...(enableFast || typeof fastMode === "boolean" ? { fastMode: enableFast || fastMode && !heldCooldown } : {}),
        ...(typeof ultracode === "boolean" ? { ultracode } : {}),
      })] : []),
    ];

    if (version !== this.sendVersion) throw new Error("Claude turn interrupted");
    this.assertCapability();
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
    let child, managed, startedDebugCapture = false;
    const recoveringApplication = this.recoverApplication;
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
    const spawnPersistent = launchArgs => this.executor?.spawnAgent
      ? this.executor.spawnAgent(this.config.claude.bin, launchArgs, { cwd: this.workspace, env, stdio: ["pipe", "pipe", "pipe"], recoverOnly: recoveringApplication })
      : spawn(launchArgs);
    try {
      if (this.applicationSession?.ended) this.applicationSession = null;
      const manage = launchArgs => {
        const session = new ClaudeSession(spawnPersistent(launchArgs), args, env, event => {
          if (this.stopped || ![this.turnSession, this.applicationSession].includes(session)) return;
          return this.backgroundEvent(event);
        }, {
          ...(this.privateProfile ? {
            onNativeAgentEvent: event => session.agents?.observe(event),
            onNativeAgentClose: () => session.agents?.close(),
          } : {}),
          ...(interactive ? { requestHooks: this.hooks, cwd: this.workspace } : {}),
          onSchedulesChanged: () => {
            if (this.stopped || ![this.turnSession, this.applicationSession].includes(session)) return;
            if (session.hasScheduledWork() && !session.ended) this.applicationSession = session;
            this.hooks.onEvent?.({ type: "scheduled_work" });
          },
          onWorkflowsChanged: () => {
            if (this.stopped || ![this.turnSession, this.applicationSession].includes(session)) return;
            if (session.hasWorkflowWork() && !session.ended) this.applicationSession = session;
            this.hooks.onEvent?.({ type: "background_turn", active: this.isBackgroundBusy() });
          },
        });
        if (this.privateProfile) {
          session.agents = new ClaudeAgentThreads({ root: () => session.sessionId, control: session.control, secrets: this.accountSecrets,
            current: () => {
              if (this.stopped || session.ended || session.stopping || this.agents !== session.agents || ![this.turnSession, this.applicationSession].includes(session)) return false;
              this.assertCapability(); this.hooks.assertAgentCurrent?.(session.sessionId); return true;
            },
            publish: snapshot => this.hooks.onAgentThreads?.(snapshot),
          });
          this.agents = session.agents;
        }
        return session;
      };
      if (!this.applicationSession && applicationRequest) {
        const launchArgs = args.includes("--input-format") ? args : [...args, "--input-format", "stream-json"];
        this.applicationSession = manage(launchArgs);
      }
      managed = this.applicationSession || (interactive || ultracodeSession || pluginReload || settingsPrompt || debugRequest ? manage(args) : null);
      if (recoveringApplication) {
        await managed.child.ready;
        if (managed.child.recovered !== true || managed.child.recovery?.provider !== "claude"
          || !this.sessionId || managed.child.recovery.sessionId !== this.sessionId) {
          throw Error("The retained Claude process does not match this chat's native session");
        }
        this.recoverApplication = false;
      }
      this.turnSession = managed;
      child = managed ? await managed.open(args, env, { resetEffort, ultracode, selectionCurrent }) : spawn(args);
      if (version !== this.sendVersion) throw Error("Claude turn interrupted");
      this.assertCapability();
      if (settingsPrompt) beforeNativeSettings = await inspectNative(managed);
      if (debugRequest) {
        const controller = new AbortController(); this.debugInspection = controller;
        startedDebugCapture = !managed.debugLog || Boolean(managed.debugLog.error);
        try {
          await managed.enableDebug({ runtimeHome: this.runtimeHome, executor: this.executor, isolation: this.config.processIsolation, signal: controller.signal,
            sanitize: value => this.redactAccount(value),
            onError: error => { if (!this.stopped && [this.applicationSession, this.turnSession].includes(managed)) this.hooks.onEvent?.({ type: "notice", text: error.message }); } });
          if (version !== this.sendVersion) throw Error("Claude turn interrupted");
          this.assertCapability();
          // Debugging must continue into the reproduction turn, even when no
          // application is running. Idle sleep or explicit Stop still closes it.
          this.applicationSession = managed;
          if (startedDebugCapture) this.hooks.onEvent?.({ type: "notice", text: "Private debug logging is active for this native process from this point onward (up to 2 MiB). Earlier diagnostics from this process were not recorded by Relay. Stop ends this capture." });
        } finally { if (this.debugInspection === controller) this.debugInspection = null; }
      }
      // No user input exists during SDK initialization/reset. Do not publish
      // a resume ID for a first turn that fails before those controls finish.
      if (isNew && !provisionalSession && (interactive || settingsPrompt || ultracodeSession)) {
        await this.hooks.onSessionId?.(sessionId);
        this.sessionId = sessionId;
        if (version !== this.sendVersion) throw Error("Claude turn interrupted");
        this.assertCapability();
      }
    } catch (error) {
      if (startedDebugCapture && managed?.debugLog) { await managed.debugLog.close(); managed.debugLog = null; }
      finishObservation();
      if (this.modeObserver === modeObserver) this.modeObserver = previousModeObserver;
      if (child && managed?.active === child && !child.commandUuid) managed.finish(child, 1, null);
      if (!managed) await terminateWorker(child);
      if (managed && managed !== this.applicationSession) await managed.stop();
      // Recovery failures deliberately leave the retained remote process for
      // explicit Stop; replacing or killing it would destroy the only
      // continuity evidence.
      if (recoveringApplication && this.applicationSession === managed) this.applicationSession = null;
      if (this.turnSession === managed) this.turnSession = null;
      // Failed first initialization must not leave a live, unaddressable CLI
      // or retry a provisional session whose journal was never checkpointed.
      if (provisionalSession && !this.sessionId) {
        await this.applicationSession?.stop(); this.applicationSession = null;
      }
      throw error;
    }
    this.child = child;
    if (pluginReload) {
      // A control-only first command creates no native journal. Retain this
      // private initialized owner for the next input, but publish no resume ID
      // until actual input has started. Stop before that input stays a new chat.
      this.applicationSession = managed;
      try {
        const outcome = await this.reloadPlugins(managed, version);
        return { text: outcome.text, status: "completed" };
      } finally {
        finishObservation();
        if (managed.active === child) managed.finish(child, 0, null);
        if (this.child === child) this.child = null;
        if (this.turnSession === managed) this.turnSession = null;
      }
    }
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
      child.stdin.end(interactive || ultracodeSession || settingsPrompt || debugRequest ? `${JSON.stringify({ type: "user", message: { role: "user", content: input } })}\n` : input);
    }

    const output = new ClaudeTextStream(delta => this.hooks.onEvent?.({ type: "assistant_delta", delta }), this.nativeAuthMode === "account" || this.accountSecrets.size ? { secrets: this.accountSecrets } : {});
    this.activeOutput = output;
    const errorOutput = this.nativeAuthMode === "account" || this.accountSecrets.size ? new SecretTextStream(this.accountSecrets, { tokenPrefix: "sk-ant-" }) : null;
    let resultMessage = null;
    let nativeFast = null;
    const notifications = new Set();
    let compacted = false;
    let lastRequest = null;
    const sampleId = randomUUID();
    let resultBaseline = null, resultCount = 0;
    let stderr = "";
    const activeTools = new Map();
    const backgroundCandidates = new Set();
    const completeTool = (itemId, output = "", failed = false, resultMissing = false) => {
      const tool = activeTools.get(itemId);
      if (!tool) return;
      activeTools.delete(itemId);
      backgroundCandidates.delete(itemId);
      this.hooks.onEvent?.({ ...tool, state: "completed", failed, resultMissing, output });
    };
    const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on("line", (line) => {
      let event, raw;
      try { raw = JSON.parse(line); event = this.redactAccount(raw); } catch { return; }
      mcpControl?.accept(event);
      reviewControl?.accept(event);
      this.permissionMode(event);
      // Any private SDK turn can launch an app, including a generated skill
      // or ordinary prose. Retain its actual owner, not just /run and /verify.
      // Bind the native task event to this live main-session Bash call; text,
      // unrelated tasks and late events after interruption are not evidence.
      if (managed && !this.applicationSession && this.turnSession === managed && this.child === child
        && !this.stopped && version === this.sendVersion && event.type === "system" && event.subtype === "task_started"
        && event.session_id === sessionId && !event.parent_tool_use_id && event.task_type === "local_bash"
        && typeof event.task_id === "string" && event.task_id
        && typeof event.tool_use_id === "string" && backgroundCandidates.has(event.tool_use_id)) {
        this.applicationSession = managed;
      }
      // Keep native text unchanged for stream deduplication. The text sink
      // masks credentials across events before either SSE or saved output.
      if (!mcpControl) output.accept(raw);
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
        this.sessionMetadata(event);
      }
      if (event.type === "assistant") {
        for (const block of event.message?.content || []) {
          if (block.type === "tool_use" && !activeTools.has(block.id)) {
            if (!event.parent_tool_use_id && block.name === "Bash" && typeof block.id === "string" && block.id) backgroundCandidates.add(block.id);
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
      stderr = `${stderr}${redact(errorOutput ? errorOutput.push(String(chunk)) : String(chunk))}`.slice(-16_000);
    });

    return new Promise((resolve, reject) => {
      let spawnFailed = false;
      child.once("error", (error) => {
        output.finish(); errorOutput?.finish();
        if (this.activeOutput === output) this.activeOutput = null;
        spawnFailed = true;
        if (provisionalSession) this.sessionId = null;
        if (reviewControl) this.reviewInterruption = null;
        finishObservation();
        if (this.child === child) this.child = null;
        reject(error);
      });
      child.once("close", (code, signal) => { void (async () => {
        output.finish(); stderr += errorOutput?.finish() || "";
        if (this.activeOutput === output) this.activeOutput = null;
        finishObservation();
        // Query the actual merge before a one-shot SDK owner is closed. A
        // retained application owner stays alive; inspecting settings cannot
        // restart it or substitute a controller-side approximation of policy.
        let afterNativeSettings, settingsError;
        if (beforeNativeSettings && version === this.sendVersion) {
          try {
            await inspect(); if (diagnostic) await inspect(".claude.json");
            afterNativeSettings = await inspectNative(managed);
            if (afterNativeSettings.hasErrors) {
              if (!beforeNativeSettings.hasErrors || beforeNativeSettings.model !== afterNativeSettings.model || beforeNativeSettings.permissionMode !== afterNativeSettings.permissionMode
                || beforeNativeSettings.pluginsFingerprint !== afterNativeSettings.pluginsFingerprint) {
                throw Error("Cannot safely verify settings after the native diagnostic. The command queue is paused; check the private configuration before retrying.");
              }
              this.hooks.onEvent?.({ type: "notice", text: "Claude's existing configuration errors are still present. No model or permission-mode changes were synchronized. Review the diagnostic before requesting a repair." });
            }
            // A saved enabledPlugins change does not invalidate the native
            // owner's plugin/skill cache. Reconcile before FIFO can release,
            // without restarting its app or replaying the diagnostic prompt.
            if (diagnostic && beforeNativeSettings.pluginsFingerprint !== afterNativeSettings.pluginsFingerprint) await this.reloadPlugins(managed, version);
          }
          catch (error) { settingsError = error; }
        }
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
        const applicationCheckpoint = (applicationRequest || debugRequest) && version !== this.sendVersion && resultMessage?.subtype === "error_during_execution" && resultMessage.session_id === sessionId;
        if (provisionalSession) {
          // Graceful review cancellation still returns and saves its journal.
          // Preserve that checkpoint even though the running turn was stopped.
          this.sessionId = applicationCheckpoint || checkpointed && (reviewControl || applicationRequest || version === this.sendVersion) ? sessionId : null;
          if (this.sessionId) await this.hooks.onSessionId?.(this.sessionId);
          else if (this.applicationSession) { await this.applicationSession.stop(); this.applicationSession = null; }
        }
        if (version !== this.sendVersion) throw new Error("Claude turn interrupted");
        if (settingsError) throw settingsError;
        if (mcpError) throw mcpError;
        if (mcpControl && (!mcpOutcome || !checkpointed)) throw new Error("Claude MCP control stopped before verification");
        if (mcpOutcome) {
          await this.hooks.onEvent?.({ type: "session_capabilities", connectors: mcpOutcome.connectors });
          if (mcpOutcome.failed) throw new Error(mcpOutcome.text);
        }
        const nativeSettings = beforeNativeSettings ? claudeSettingsChanges(beforeNativeSettings, afterNativeSettings, configuration)
          : beforeSettings ? claudeSettingsChanges(beforeSettings, await inspect(), configuration) : undefined;
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
          if (enableFast && (!nativeFast || nativeFast.state === "off" || nativeFast.disabledReason)) {
            await this.disableFast(version);
            throw Object.assign(new Error(claudeFastUnavailable(nativeFast?.disabledReason)), { nativeFast: nativeFast || { state: "off" }, fastPreference: false, fastCooldown: null });
          }
          resolve(this.redactAccount({ text: mcpOutcome?.text ?? output.text, status: "completed", compacted,
            finalAnswer: mcpControl || diagnostic || configuration || debugRequest ? null : claudeFinalAnswer(resultMessage, sessionId),
            ...(nativeSettings ? { nativeSettings } : {}), ...fastResult, ...(feedback && onFastConstraint ? { fastConstraintObserved: true } : {}) }));
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

  async setPermissionMode(mode, guard = () => {}, onAcknowledged = () => {}) {
    const nativeMode = Object.keys(CLAUDE_PERMISSION_MODES).find(key => CLAUDE_PERMISSION_MODES[key] === mode);
    if (!nativeMode) throw Error("Unsupported Claude permission mode");
    const session = this.turnSession || this.applicationSession;
    if (!session) {
      if (this.child) throw Object.assign(Error("This Claude transport cannot change permissions live. Wait for this turn to finish."), { statusCode: 409 });
      return false;
    }
    const check = () => {
      guard(); this.assertCapability();
      if (this.stopped || session.ended || session.stopping || !session.initialized || session.pending
        || ![this.turnSession, this.applicationSession].includes(session)) {
        throw Object.assign(Error("Claude is starting or changed; retry the permission selection when ready."), { statusCode: 409 });
      }
    };
    check();
    try {
      await session.control.request("set_permission_mode", { mode: nativeMode }, { onSuccess: result => {
        if (result.mode !== nativeMode) throw Error("Claude did not confirm the selected permission mode");
        check(); onAcknowledged();
      } });
      check();
    } catch (error) {
      // Never surface native errors containing private settings, or silently
      // substitute bypassPermissions when Auto is unavailable.
      if (error.statusCode) throw error;
      throw Error("Claude could not confirm the permission change. Check account/model restrictions and retry; the selection was not saved.");
    }
    // Pending tools remain native-owned. A mode change is not Approve once.
    // Native control_cancel_request removes prompts that Claude re-evaluates.
    return true;
  }

  async respond(requestId, payload) {
    const requests = this.turnSession?.requests || this.applicationSession?.requests;
    if (!requests || this.stopped) throw Object.assign(Error("Claude request is no longer active"), { statusCode: 409 });
    this.assertCapability();
    await requests.respond(requestId, payload);
  }

  applyAccountEnvironment(env, credentials) {
    // Environments may configure build tools, never override the selected
    // account with a project API key, custom provider or OAuth-token helper.
    for (const key of Object.keys(env)) if (/^(?:ANTHROPIC_|CLAUDE_CODE_(?:OAUTH|USE_|API_KEY|PROVIDER_|HOST_AUTH|SKIP_FAST))/.test(key)) delete env[key];
    env.CLAUDE_CODE_OAUTH_TOKEN = credentials.accessToken;
    env.CLAUDE_CODE_ACCOUNT_UUID = credentials.accountId;
    env.CLAUDE_CODE_ORGANIZATION_UUID = credentials.organizationId;
    delete env.CLAUDE_CODE_USER_EMAIL;
    if (credentials.email) env.CLAUDE_CODE_USER_EMAIL = credentials.email;
    env.CLAUDE_CODE_ENTRYPOINT = "local-agent";
    env.CLAUDE_CODE_SDK_HAS_OAUTH_REFRESH = "1";
    this.currentAccountCredentialHash = accountCredentialHash(credentials);
  }

  assertRetainedAccountCredential(credentials) {
    const expected = this.recoverApplication ? this.retainedCapabilities?.accountCredentialHash : null;
    if (this.recoverApplication && (!/^[a-f0-9]{64}$/.test(expected || "") || accountCredentialHash(credentials) !== expected)) {
      throw new Error("The selected Claude account credential changed while its native process was hibernated; use Stop before continuing");
    }
    this.currentAccountCredentialHash = accountCredentialHash(credentials);
  }

  hasScheduledWork() {
    return !this.stopped && !this.applicationSession?.ended && Boolean(this.applicationSession?.hasScheduledWork());
  }

  isBackgroundBusy() {
    return !this.stopped && !this.applicationSession?.ended && Boolean(this.applicationSession?.backgroundCommand || this.applicationSession?.hasWorkflowWork());
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

  sessionMetadata(event) {
    const commands = claudeCommandMetadata(event.slash_commands);
    this.hooks.onEvent?.({ type: "session_capabilities", ...(Array.isArray(event.mcp_servers) ? { connectors: event.mcp_servers.map(server => ({ name: server.name, status: server.status })) } : {}),
      ...(commands ? { slashCommands: commands.map(command => command.name) } : {}) });
    this.hooks.onEvent?.({ type: "session_details", details: safeSessionDetails("claude", { cwd: this.workspace, model: event.model, cliVersion: event.claude_code_version }) });
  }

  backgroundEvent(event) {
    const raw = event;
    event = this.redactAccount(event);
    this.permissionMode(event);
    if (!this.stopped && event.type === "command_catalog") {
      const commands = claudeCommandMetadata(event.commands);
      if (commands) return this.hooks.onEvent?.({ type: "command_catalog", commands });
      return;
    }
    if (!this.stopped && event.type === "system" && event.subtype === "init") { this.sessionMetadata(event); return; }
    if (!this.stopped && event.type === "workspace_trust_notice") {
      this.hooks.onEvent?.({ type: "notice", text: "Claude is ignoring project permission grants because this workspace has not been trusted. Saving allow rules does not enable them. Open Chat actions → Workspace trust to review and explicitly trust this chat's private workspace; existing approval requirements remain in force." });
      return;
    }
    if (!this.stopped && event.type === "background_turn") { this.hooks.onEvent?.(event); return; }
    if (this.stopped || !["assistant", "stream_event", "result"].includes(event.type)) return;
    this.backgroundOutput ||= new ClaudeTextStream(() => {}, this.nativeAuthMode === "account" || this.accountSecrets.size ? { secrets: this.accountSecrets } : {});
    this.backgroundOutput.accept(raw);
    if (event.type === "assistant" && !event.parent_tool_use_id && event.message?.usage) this.backgroundRequest = event.message;
    if (event.type === "result") {
      this.backgroundOutput.finish();
      this.hooks.onEvent?.({ type: "usage", usage: claudeUsage(event, this.backgroundRequest, randomUUID()) });
      const interrupted = event.relayWorkflowInterrupted === true;
      const failed = !interrupted && (event.is_error === true || Boolean(event.subtype && event.subtype !== "success"));
      const text = this.backgroundOutput.text || (failed ? redact(event.result || "Claude background task failed") : "");
      if (text) this.hooks.onEvent?.({ type: "background_response", text, failed });
      if (interrupted) this.hooks.onEvent?.({ type: "notice", text: "Native workflow report interrupted to send your queued message." });
      this.backgroundOutput = null; this.backgroundRequest = null;
    }
  }

  async interrupt() {
    this.activeOutput?.finish(); this.backgroundOutput?.finish();
    this.backgroundOutput = null; this.backgroundRequest = null;
    this.sendVersion += 1;
    this.modeObserver = null;
    (this.turnSession?.requests || this.applicationSession?.requests)?.cancel();
    this.settingsInspection?.abort();
    this.debugInspection?.abort();
    this.fastInspection?.abort();
    this.providerObservation?.(); this.providerObservation = null;
    // Application turns are logical children: interrupt their native query,
    // retaining the CLI and its background servers. Other turns are one-shot.
    const child = this.child;
    // Native plugin reload has no cancellation control. Wait for its bounded
    // receipt before Send now; the version guard rejects late publication and
    // the owning app remains alive. Explicit Stop still terminates the owner.
    if (this.pluginReload) {
      if (!await this.pluginReload) throw Error("Could not verify native plugin reload before Send now. The selected input was not sent; retry reload or explicitly Stop the worker.");
      return;
    }
    await this.reviewInterruption?.();
    if (child) await terminateWorker(child);
    else if (this.turnSession?.pending) await this.turnSession.stop();
    await this.applicationSession?.interruptWorkflows();
    if (this.applicationSession?.backgroundCommand) await this.applicationSession.interruptBackground();
  }

  async prepareTransportSuspend() {
    if (this.stopped || this.child || this.turnSession?.pending || this.isBackgroundBusy() || this.hasScheduledWork()) {
      throw Error("Claude is not at a quiescent suspension boundary");
    }
    if (!this.applicationSession || this.applicationSession.ended) return { retained: false };
    if (this.nativeAuthMode === "gateway") this.assertCapability();
    if (this.nativeAuthMode === "account" && !/^[a-f0-9]{64}$/.test(this.currentAccountCredentialHash || "")) {
      throw Error("Claude account credential could not be checkpointed before hibernation");
    }
    const boundary = await this.applicationSession.prepareTransportSuspend();
    return { ...boundary, capabilities: {
      ...(this.nativeAuthMode === "gateway" ? { provider: { provider: "anthropic", token: this.capability,
        credentialHash: providerCredentialHash(this.config.claude) } } : {}),
      ...(this.nativeAuthMode === "account" ? { accountCredentialHash: this.currentAccountCredentialHash } : {}),
    } };
  }

  async detachTransportForSuspend() {
    const session = this.applicationSession;
    if (!session || session.ended || typeof session.child?.detach !== "function") {
      this.stopped = true;
      this.agents?.close();
      this.turnSession = null; this.applicationSession = null;
      this.broker.revoke(this.capability); this.capability = "";
      return { detached: false };
    }
    if (this.child || this.turnSession?.pending || this.isBackgroundBusy() || this.hasScheduledWork()) throw Error("Claude changed after its suspension checkpoint");
    this.stopped = true;
    this.agents?.close();
    if (typeof session.child.relinquish === "function") await session.child.relinquish();
    else session.child.detach();
    this.turnSession = null; this.applicationSession = null;
    this.broker.revoke(this.capability); this.capability = "";
    return { detached: true, processId: "native-agent" };
  }

  async stop() {
    this.activeOutput?.finish(); this.backgroundOutput?.finish();
    this.backgroundOutput = null; this.backgroundRequest = null;
    this.sendVersion += 1;
    this.modeObserver = null;
    this.settingsInspection?.abort();
    this.debugInspection?.abort();
    this.fastInspection?.abort();
    const trustStopped = this.trustControls?.close();
    this.providerObservation?.(); this.providerObservation = null;
    this.stopped = true;
    this.agents?.close();
    // Revoke synchronously, before any slow process/SDK shutdown. A stale
    // adapter must never revoke a replacement runtime's newer capability.
    this.broker.revoke(this.capability);
    this.capability = "";
    (this.turnSession?.requests || this.applicationSession?.requests)?.cancel();
    const child = this.child;
    this.child = null;
    await this.reviewInterruption?.();
    if (child) await terminateWorker(child);
    await this.turnSession?.stop(); this.turnSession = null;
    await this.applicationSession?.stop(); this.applicationSession = null;
    await trustStopped;
  }
}
