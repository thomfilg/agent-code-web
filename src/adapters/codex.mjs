import { mkdir } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { JsonRpcProcess } from "../json-rpc-process.mjs";
import { buildWorkerEnvironment } from "../worker-process.mjs";
import { inspectDesktopSession } from "../desktop-handoff.mjs";
import { errorMessage, redact } from "../utils.mjs";
import { SecretTextStream } from "../secret-text-stream.mjs";
import { capabilityMcpServers, codexShellEnvironmentArgs } from "../worker-capabilities.mjs";
import { codexUsage, safeRateLimits, cliVersionFromUserAgent, safeSessionDetails } from "../session-info.mjs";
import { codexMcpArgs } from "../mcp-connections.mjs";
import { captureSessionBundle, workerSessionIO } from "../codex-session-bundle.mjs";
import { CodexAgentThreads } from "../codex-agent-threads.mjs";
import { CodexApps } from "../codex-apps.mjs";
import { CodexPlugins, CodexPluginCli } from "../codex-plugins.mjs";
import { CodexHooks } from "../codex-hooks.mjs";
import { CodexFeatures } from "../codex-features.mjs";
import { CodexMemories } from "../codex-memories.mjs";
import { createCodexImportControls } from "../codex-import-runtime.mjs";
import { importedTranscript } from "../codex-import-chat.mjs";
import { codexFeedbackPolicy } from "../codex-feedback.mjs";
import { codexApprovalSettings } from "../codex-permissions.mjs";
import { codexLogoutPolicy, logoutHash } from "../codex-logout.mjs";
import { inspectCodexAuthFile } from "../codex-auth-files.mjs";
import { planProgress } from "../tab-title.mjs";
import { captureCodexFinal, codexFinalAnswer } from "../message-search.mjs";

const toml = (value) => JSON.stringify(value);
const providerCredentialHash = config => createHash("sha256").update(JSON.stringify([
  "openai", config.providerKey || null, config.upstreamBaseUrl || null,
])).digest("hex");

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

function safeToolJson(value) {
  if (value == null) return "";
  // Transport already strips known account/capability credentials. Tool arguments
  // can also contain user-supplied credentials under structured secret keys.
  return redact(JSON.stringify(value, (key, field) => {
    const normalized = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
    return /^(?:password|passwd|authorization|proxyauthorization|cookie|setcookie|apikey|secret|clientsecret|token|accesstoken|refreshtoken|idtoken|bearertoken|sessiontoken|credentials)$/.test(normalized)
      ? "[redacted]" : field;
  }, 2));
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
      failed: item.exitCode != null && item.exitCode !== 0,
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
    const completed = state === "completed";
    const result = item.type === "mcpToolCall"
      ? (item.result == null ? null : { content: item.result.content, structuredContent: item.result.structuredContent })
      : item.contentItems;
    // MCP _meta is provider-internal metadata, not the user-visible tool result.
    const error = typeof item.error?.message === "string" ? redact(item.error.message) : "";
    const output = completed ? [safeToolJson(result), error ? `Error: ${error}` : ""].filter(Boolean).join("\n") : "";
    return {
      type: "tool",
      tool: item.type,
      state,
      itemId: item.id,
      title: redact(item.tool || item.name || "Tool call"),
      input: safeToolJson(item.arguments).slice(0, 16_000),
      output: output.slice(-16_000),
      failed: completed && (item.status === "failed" || item.error != null || item.success === false),
      resultMissing: completed && result == null && !error,
    };
  }
  return null;
}

export class CodexAdapter {
  constructor({ chat, store, config, broker, gatewayOrigin, executor = null, hooks, requireResume = Boolean(chat.nativeForkSessionId), restoreFork = null, savedAgentThreads = null, nativeSessions = null, checkpointGuard = () => {} }) {
    this.chat = chat;
    this.apps = new CodexApps((method, params) => {
      if (!this.rpc) throw new Error("The native app connection is stopped");
      return this.rpc.request(method, params, 20000);
    }, () => this.threadId);
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
    this.recoverApplication = chat.suspension?.nativeRetained === true;
    this.requireResume = requireResume;
    this.restoreFork = restoreFork;
    this.savedAgentThreads = savedAgentThreads;
    this.nativeSessions = nativeSessions;
    this.checkpointGuard = checkpointGuard;
    this.nativeCapture = Promise.resolve();
    this.nativePaths = new Map();
    this.createdForks = new Set();
    this.current = null;
    this.requests = new Map();
    this.mode = chat.mode || "auto";
    this.intentionalStop = false;
    this.goal = null;
    this.children = new Set();
    this.sharedParent = null;
    this.sharedListeners = null;
    this.credentialSecrets = new Set(executor?.capabilitySecrets || []);
  }

  async start({ skipCheckpointRestore = false } = {}) {
    if (this.rpc) return;
    if (this.sharedParent) throw new Error("This temporary side chat has closed; open a new side chat");
    if (this.requireResume && !this.threadId) throw new Error("The fork's native session ID is missing; refusing to start an empty conversation");
    const authMode = this.chat.agentAccountId ? "account" : this.config.codex.authMode;
    if (authMode === "account" && !this.hooks.accountCredentials) throw new Error("The selected Codex account is unavailable; reconnect it in Agent accounts");
    if (authMode === "gateway" && !this.config.codex.providerKey) {
      throw new Error("OPENAI_API_KEY is required when CODEX_AUTH_MODE=gateway");
    }
    const retainedProvider = this.recoverApplication ? this.executor?.retainedCapabilities?.provider : null;
    if (this.recoverApplication && authMode === "gateway"
      && (retainedProvider?.provider !== "openai" || !/^cap_[A-Za-z0-9_-]{43}$/.test(retainedProvider?.token || "")
        || retainedProvider.credentialHash !== providerCredentialHash(this.config.codex))) {
      throw new Error("The retained Codex provider capability is invalid");
    }
    const capability = authMode === "gateway"
      ? retainedProvider ? this.broker.restoreToken({ token: retainedProvider.token, chatId: this.chat.id, provider: "openai" })
        : this.broker.issue({ chatId: this.chat.id, provider: "openai" })
      : "";
    this.capability = capability;
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
    this.nativeHome = env.CODEX_HOME;
    this.nativeAuthMode = authMode;
    if (!skipCheckpointRestore && authMode === "account" && this.nativeSessions?.available(this.chat) && this.threadId && !this.restoreFork) {
      this.checkpointGuard();
      const saved = await this.nativeSessions.read(this.store.get(this.chat.id), this.checkpointGuard);
      this.checkpointGuard();
      if (saved.value) {
        const restored = await workerSessionIO(this.executor, { action: "restoreFresh", home: env.CODEX_HOME, bundle: saved.value.bundle });
        this.checkpointGuard();
        if (restored.restored) this.restoredNativeCheckpoint = saved.value;
      }
    }
    this.pluginCli = new CodexPluginCli({ command: this.config.codex.bin, workspace: this.workspace, env,
      ...(this.executor ? { spawn: this.executor.spawn.bind(this.executor) } : { isolation: this.config.processIsolation }) });
    this.plugins = new CodexPlugins({ run: args => this.pluginCli.run(args),
      request: (method, params) => { if (!this.rpc) throw new Error("The native plugin connection stopped"); return this.rpc.request(method, params, 30000); },
      workspace: this.workspace, thread: () => this.threadId, mutable: authMode !== "host",
      busy: () => this.nativeSettingsBusy() || Boolean(this.hookControls?.changing || this.featureControls?.changing || this.memoryControls?.changing || this.importControls?.changing || this.importControls?.needsRefresh),
      changed: () => this.refreshSkills() });
    this.hookControls = new CodexHooks({ request: (method, params) => { if (!this.rpc) throw new Error("The native hook connection stopped"); return this.rpc.request(method, params, 30000); },
      workspace: this.workspace, thread: () => this.threadId, mutable: authMode !== "host",
      busy: () => this.nativeSettingsBusy() || Boolean(this.plugins?.changing || this.featureControls?.changing || this.memoryControls?.changing || this.importControls?.changing || this.importControls?.needsRefresh) });
    this.featureControls = new CodexFeatures({ request: (method, params) => { if (!this.rpc) throw new Error("The native feature connection stopped"); return this.rpc.request(method, params, 30000); },
      workspace: this.workspace, thread: () => this.threadId, mutable: authMode !== "host",
      busy: () => this.nativeSettingsBusy() || Boolean(this.plugins?.changing || this.hookControls?.changing || this.memoryControls?.changing || this.importControls?.changing || this.importControls?.needsRefresh) });
    this.memoryControls = new CodexMemories({ request: (method, params) => { if (!this.rpc) throw new Error("The native memory connection stopped"); return this.rpc.request(method, params, 30000); },
      workspace: this.workspace, thread: () => this.threadId, mutable: authMode !== "host",
      busy: () => this.nativeSettingsBusy() || Boolean(this.plugins?.changing || this.hookControls?.changing || this.featureControls?.changing || this.importControls?.changing || this.importControls?.needsRefresh) });
    if (this.restoreFork && authMode !== "host") {
      if (this.restoreFork.threadId !== this.threadId) throw new Error("Fork history does not match its native session ID");
      await workerSessionIO(this.executor, { action: "install", home: env.CODEX_HOME, bundle: this.restoreFork });
    }

    const args = ["app-server"];
    if (authMode === "account") args.push("-c", 'cli_auth_credentials_store="ephemeral"', "-c", 'model_provider="openai"');
    args.push(...codexMcpArgs(capabilityMcpServers(this.executor?.mcpServers, this.credentialSecrets, env, "codex")));
    if (authMode === "gateway") args.push(...gatewayArgs(this.gatewayOrigin));
    args.push(...codexShellEnvironmentArgs(env, this.executor?.environmentVariables, this.credentialSecrets));

    const rpc = new JsonRpcProcess({
      command: this.config.codex.bin,
      args,
      isolation: this.executor ? "none" : this.config.processIsolation,
      spawnFn: this.executor ? (this.executor.spawnAgent || this.executor.spawn).bind(this.executor) : null,
      spawnOptions: { cwd: this.workspace, env, recoverOnly: this.recoverApplication },
      deferAgentDeltaRedaction: authMode === "account" || this.credentialSecrets.size > 0,
      redactSecrets: value => {
        for (const secret of [...this.credentialSecrets].sort((a, b) => b.length - a.length)) value = value.replaceAll(secret, "[redacted]");
        return value;
      },
    });
    this.rpc = rpc;
    this.feedbackStartupPolicy = null;
    this.logoutStartupPolicy = null; this.accountEpoch = 0; this.logoutChanging = false;
    this.intentionalStop = false;
    // A new native process gets a new identity. Restoring a record alone is
    // never evidence that its previous process stopped.
    const importWorkerId = this.importWorkerId = randomUUID();
    this.importControls = await createCodexImportControls(this, env, rpc, importWorkerId);
    const imports = this.importControls;
    this.importStop = null;
    this.agents = new CodexAgentThreads({ rpc, root: () => this.threadId, workspace: this.workspace, model: this.config.codex.model, mode: () => this.mode, saved: this.savedAgentThreads,
      assertCurrent: this.hooks.assertAgentCurrent,
      secrets: authMode === "account" || this.credentialSecrets.size ? this.credentialSecrets : null,
      publish: snapshot => this.hooks.onAgentThreads?.(snapshot), log: text => this.hooks.onLog?.(text) });
    rpc.on("notification", (message) => this.#notification(message));
    rpc.on("request", (message) => this.#serverRequest(message));
    // Native diagnostics can split a credential across stderr chunks. Named
    // accounts expose structured, redacted errors, never raw native stderr.
    rpc.on("stderr", (text) => { if (authMode !== "account" && !this.credentialSecrets.size) this.hooks.onLog?.(redact(text)); });
    rpc.on("protocolError", (error) => this.hooks.onLog?.(this.credentialSecrets.size ? "Codex returned invalid protocol output; private diagnostics were omitted." : errorMessage(error)));
    rpc.on("error", (error) => this.hooks.onFatal?.(error));
    rpc.on("exit", ({ code, signal }) => {
      const confirmed = this.executor?.metadata?.backend !== "ec2" || Number.isInteger(code) && code >= 0 && code < 255 && !signal;
      const recorded = imports?.workerStopped(importWorkerId, confirmed).catch(() => this.hooks.onLog?.("Import stop tracking could not be saved; refresh /import before continuing."));
      if (this.importWorkerId !== importWorkerId) return;
      this.importStop = recorded;
      if (!this.intentionalStop) this.hooks.onFatal?.(new Error(`Codex worker exited: ${code ?? signal}`));
      if (this.rpc === rpc) this.rpc = null;
      this.#rejectCurrent(new Error("Codex worker stopped before the turn completed"));
    });
    rpc.start();
    await rpc.ready;
    if (rpc.recovered) {
      if (rpc.recovery?.provider !== "codex" || !this.threadId || rpc.recovery.threadId !== this.threadId) {
        throw new Error("The retained Codex process does not match this chat's native session");
      }
      this.cliVersion = typeof rpc.recovery.cliVersion === "string" ? rpc.recovery.cliVersion : null;
      this.recoverApplication = false;
    } else {
      const initialized = await rpc.request("initialize", {
        clientInfo: { name: "agent_web_poc", title: "Agent Web POC", version: "0.1.0" },
        capabilities: { experimentalApi: true },
      });
      this.cliVersion = cliVersionFromUserAgent(initialized?.userAgent);
      rpc.notify("initialized", {});
    }
    if (authMode === "account") {
      const credentials = await this.hooks.accountCredentials({});
      this.credentialSecrets.add(credentials.accessToken);
      try { await rpc.request("account/login/start", { type: "chatgptAuthTokens", ...credentials }); }
      catch { throw new Error("Codex could not use the selected account. Reconnect it in Agent accounts; no server credentials were used."); }
    }
    await this.#loadThread();
    // Native feedback retains its invocation configuration after reloads.
    // Remember its startup policy without blocking ordinary work on old CLIs.
    try { this.feedbackStartupPolicy = await this.feedbackPolicy(() => {}, true); } catch { /* Logs stay unavailable if startup policy cannot be verified. */ }
    try { this.logoutStartupPolicy = await codexLogoutPolicy((method, params) => rpc.request(method, params, 5000), this.workspace); } catch { /* No credential mutation without verified startup storage. */ }
    await this.agents.refresh().catch(error => this.hooks.onLog?.(`Agent picker unavailable: ${errorMessage(error)}`));
    try { await this.goalAction("get"); } catch (error) { if (this.restoreFork) throw error; /* Older CLIs can still run ordinary turns. */ }
    if (this.restoreFork) {
      const saved = this.restoreFork.goal;
      if (saved && !this.goal) await this.goalAction("set", saved.objective, saved.status === "active" ? "paused" : saved.status, saved.tokenBudget);
      if (saved && (this.goal?.objective !== saved.objective || this.goal?.tokenBudget !== saved.tokenBudget || this.goal?.status !== (saved.status === "active" ? "paused" : saved.status))) throw new Error("The fork's saved goal changed before initialization; no goal was overwritten");
      await this.hooks.onForkRestored?.();
      this.restoreFork = null;
    }
    if (this.restoredNativeCheckpoint?.bundle.goal) {
      const saved = this.restoredNativeCheckpoint.bundle.goal;
      if (!this.goal) await this.goalAction("set", saved.objective, saved.status === "active" ? "paused" : saved.status, saved.tokenBudget);
      if (this.goal?.objective !== saved.objective || this.goal?.tokenBudget !== saved.tokenBudget
        || this.goal?.status !== (saved.status === "active" ? "paused" : saved.status)) throw new Error("Restored native goal could not be verified; no new task was started");
    }
    await this.checkpointNativeSession().catch(error => this.checkpointNotice(error));
    try { await this.refreshSkills(); } catch { /* Older workers can still run without skill discovery. */ }
  }

  async refreshSkills() {
    const result = await this.rpc.request("skills/list", { cwds: [this.workspace], forceReload: true }, 10000);
    await this.hooks.onEvent?.({ type: "command_catalog", commands: (result.data || []).flatMap(entry => (entry.skills || []).filter(skill => skill.enabled !== false).map(skill => ({ name: skill.name, description: skill.description, path: skill.path, kind: "Skill" }))) });
  }

  checkpointNotice(error) {
    const code = typeof error?.code === "string" && /^[A-Z][A-Z0-9_]{1,63}$/.test(error.code) ? error.code : "UNCLASSIFIED";
    const step = ["read", "capture", "save"].includes(error?.checkpointStep) ? error.checkpointStep : "unknown";
    const diagnostic = `${step}:${code}`;
    if (this.lastNativeCheckpointFailure !== diagnostic) {
      this.lastNativeCheckpointFailure = diagnostic;
      this.hooks.onLog?.(`Native history checkpoint failed (${diagnostic}).`);
    }
    if (this.nativeCheckpointWarning) return;
    this.nativeCheckpointWarning = true;
    this.hooks.onEvent?.({ type: "notice", text: `The latest native history checkpoint could not be saved (${diagnostic}). The current session is retained; worker-loss recovery may use only an earlier verified checkpoint.` });
  }

  checkpointNativeSession({ boundary = "complete-records", turnId = null, stopping = false, checkpointVersion } = {}) {
    if (this.sharedParent || this.nativeAuthMode !== "account" || !this.nativeSessions?.available(this.chat)) return Promise.resolve(null);
    const rpc = this.rpc, threadId = this.threadId;
    const check = () => {
      this.checkpointGuard({ stopping, checkpointVersion });
      if (this.threadId !== threadId || this.rpc !== rpc || this.intentionalStop && !stopping) throw new Error("Native checkpoint cancelled");
    };
    let checkpointStep = "read";
    const operation = this.nativeCapture.catch(() => {}).then(async () => {
      check(); const chat = this.store.get(this.chat.id);
      const previous = await this.nativeSessions.read(chat, check); check();
      checkpointStep = "capture";
      const bundle = await captureSessionBundle({ threadId, goal: this.goal ? structuredClone(this.goal) : null,
        readThread: async id => {
          check();
          let thread = this.nativePaths.get(id);
          if (!thread) {
            if (!rpc) throw new Error("Native checkpoint source is unavailable");
            thread = (await rpc.request("thread/read", { threadId: id, includeTurns: false }, 10000)).thread; check();
            if (thread?.id !== id || thread.ephemeral || typeof thread.path !== "string") throw new Error("Native checkpoint source is unavailable");
            this.nativePaths.set(id, thread);
          }
          return thread;
        },
        readBytes: async (filename, byteBoundary) => {
          check(); const result = await workerSessionIO(this.executor, { action: "readScoped", home: this.nativeHome, path: filename, boundary: byteBoundary }); check();
          return Buffer.from(result.data, "base64");
        } });
      check(); checkpointStep = "save";
      const saved = await this.nativeSessions.save(chat, bundle, previous.revision, { boundary, turnId }, check);
      this.nativeCheckpointWarning = false;
      this.lastNativeCheckpointFailure = null;
      return { savedAt: saved.value.savedAt, bytes: saved.value.bytes, threadId, boundary, turnId };
    }).catch(error => {
      if (error && typeof error === "object") error.checkpointStep = checkpointStep;
      throw error;
    });
    this.nativeCapture = operation.catch(() => {}); return operation;
  }

  scheduleNativeCheckpoint() {
    if (this.nativeCheckpointTimer || this.nativeCaptureScheduled || this.intentionalStop || this.sharedParent || !this.nativeSessions?.available(this.chat)) return;
    this.nativeCheckpointTimer = setTimeout(() => {
      this.nativeCheckpointTimer = null;
      this.nativeCaptureScheduled = true;
      void this.checkpointNativeSession().catch(error => this.checkpointNotice(error)).finally(() => { this.nativeCaptureScheduled = false; });
    }, 1000);
    this.nativeCheckpointTimer.unref?.();
  }

  nativeSettingsBusy() { return Boolean(this.current || this.goal?.status === "active" || this.agents?.busy() || [...this.children].some(child => child.current)); }

  desktopSession(check) { return inspectDesktopSession(this, check); }

  async #loadThread() {
    const mode = this.mode;
    const common = {
      cwd: this.workspace,
      ...codexApprovalSettings(mode),
      sandbox: mode === "plan" ? "read-only" : "workspace-write",
      ...(this.chat.model || this.nativeAuthMode !== "account" && this.config.codex.model ? { model: this.chat.model || this.config.codex.model } : {}),
      ...(this.nativeAuthMode === "gateway" ? { modelProvider: "agent_gateway" } : {}),
    };
    let result;
    if (this.threadId) {
      try {
        result = await this.rpc.request("thread/resume", { threadId: this.threadId, ...common, ...(this.requireResume ? { excludeTurns: true } : {}) }, 60_000);
        if (result?.thread?.id !== this.threadId) throw new Error("Codex returned a different native session ID");
      } catch (error) {
        throw new Error(`The ${this.requireResume ? "fork's" : "chat's"} native history could not be resumed. Its session ID was retained; no empty conversation was created. ${errorMessage(error)}`);
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
    this.settings = { model: result.model, serviceTier: result.serviceTier ?? null };
    if (typeof result.thread?.path === "string") this.nativePaths.set(this.threadId, result.thread);
    await this.hooks.onEvent?.({ type: "session_details", details: safeSessionDetails("codex", { cwd: this.workspace, model: result.model, cliVersion: this.cliVersion }) });
  }

  async forkSide(hooks) {
    this.assertImportReady();
    if (!this.rpc || this.intentionalStop) throw new Error("Codex runtime is not active");
    if (this.sharedParent || this.current?.review) throw new Error("Side chats are unavailable inside a side chat or during review");
    const rpc = this.rpc;
    const result = await rpc.request("thread/fork", {
      threadId: this.threadId, cwd: this.workspace,
      ephemeral: true, excludeTurns: true,
    }, 60000);
    if (!result.thread?.id) throw new Error("Codex did not return a side thread ID");
    const child = new CodexAdapter({ chat: this.chat, store: this.store, config: this.config, broker: this.broker, gatewayOrigin: this.gatewayOrigin, executor: this.executor, hooks });
    child.mode = this.mode;
    child.rpc = rpc; child.threadId = result.thread.id; child.sharedParent = this;
    child.nativeAuthMode = this.nativeAuthMode;
    child.credentialSecrets = this.credentialSecrets;
    child.settings = { model: result.model, serviceTier: result.serviceTier ?? null };
    child.sharedListeners = {
      notification: message => { if (message.params?.threadId === child.threadId) child.#notification(message); },
      request: message => { if (message.params?.threadId === child.threadId) child.#serverRequest(message); },
      exit: () => { child.rpc = null; child.#rejectCurrent(new Error("The side chat's worker stopped")); if (!child.intentionalStop) hooks.onFatal?.(new Error("The side chat's worker stopped")); },
    };
    for (const [event, listener] of Object.entries(child.sharedListeners)) rpc.on(event, listener);
    this.children.add(child);
    try {
      if (this.rpc !== rpc || this.intentionalStop) throw new Error("Side chat cancelled because the worker stopped");
      // Ephemeral side threads have no persisted goal. In particular do not
      // pass deferGoalContinuation, which is only valid for stored forks.
      return child;
    } catch (error) { await child.stop(); throw error; }
  }

  async forkSession(workspace, { sourceId = this.threadId, check = () => {}, scoped = false } = {}) {
    this.assertImportReady();
    if (!this.rpc || this.intentionalStop || this.sharedParent) throw new Error("An active main Codex session is required to fork");
    check(); const rpc = this.rpc;
    const result = await rpc.request("thread/fork", { threadId: sourceId, cwd: workspace, excludeTurns: true, deferGoalContinuation: true }, 60000);
    const forkId = result.thread?.id;
    if (!forkId || forkId === sourceId) throw new Error("Codex did not return a new forked session");
    this.createdForks.add(forkId);
    try {
      check();
      const { goal } = await rpc.request("thread/goal/get", { threadId: forkId }, 10000);
      // Keep a fork parked while its independent worker is being prepared.
      // The original goal is not modified. Preserve the fork's intended state
      // separately, so active goals can resume with its first explicit input.
      if (goal?.status === "active") await rpc.request("thread/goal/set", { threadId: forkId, status: "paused" }, 10000);
      const bundle = await captureSessionBundle({ threadId: forkId, goal: goal || null,
        readThread: async id => {
          check(); const thread = id === forkId ? result.thread : (await rpc.request("thread/read", { threadId: id, includeTurns: false }, 30000)).thread; check();
          if (scoped && (thread?.cwd !== this.workspace || typeof thread.path !== "string" || path.normalize(thread.path) !== thread.path || !["sessions", "archived"].some(folder => thread.path.startsWith(`${this.nativeHome}/${folder}/`)))) throw new Error("Imported native history is outside this chat's workspace/profile");
          return thread;
        },
        readBytes: async (filename, boundary) => { check(); const bytes = Buffer.from((await workerSessionIO(this.executor, { action: "read", path: filename, boundary })).data, "base64"); check(); return bytes; },
      });
      check();
      return bundle;
    } catch (error) {
      // This is only the newly-created failed fork, never the source session.
      await rpc.request("thread/archive", { threadId: forkId }, 10000).catch(() => {});
      this.createdForks.delete(forkId);
      throw error;
    } finally { await rpc.request("thread/unsubscribe", { threadId: forkId }, 10000).catch(() => {}); }
  }

  async forkImportedSession(operationId, sessionId, check = () => {}) {
    this.assertImportReady(); check();
    if (!this.importControls?.mutable || this.nativeSettingsBusy()) throw new Error("Open imported conversations from an idle private chat profile");
    const selected = this.importControls.importedSession(operationId, sessionId, check), rpc = this.rpc;
    if (selected.cwd !== this.workspace) throw new Error("The imported conversation belongs to another workspace");
    await this.importControls.inspect({ source: selected.source, includeHome: true }, check); check();
    const original = (await rpc.request("thread/read", { threadId: selected.threadId, includeTurns: false }, 30000)).thread; check();
    if (original?.id !== selected.threadId || original.cwd !== this.workspace || original.ephemeral || original.status?.type === "active") throw new Error("The selected imported history is unavailable, changed or active");
    const bundle = await this.forkSession(this.workspace, { sourceId: selected.threadId, check, scoped: true });
    try {
      const thread = (await rpc.request("thread/read", { threadId: bundle.threadId, includeTurns: true }, 30000)).thread; check();
      if (thread?.id !== bundle.threadId || thread.cwd !== this.workspace) throw new Error("The imported fork returned different native history");
      return { bundle, messages: importedTranscript(thread), title: selected.title, source: selected.source };
    } catch (error) { await this.discardFork(bundle.threadId).catch(() => {}); throw error; }
  }

  async discardFork(id) {
    if (!this.createdForks.has(id)) return;
    if (this.rpc) await this.rpc.request("thread/archive", { threadId: id }, 1000);
    this.createdForks.delete(id);
  }

  releaseFork(id) { this.createdForks.delete(id); }

  async goalAction(action, objective, status = null, tokenBudget = undefined) {
    if (!["get", "pause", "clear"].includes(action)) this.assertImportReady();
    if (!this.rpc) throw new Error("Codex runtime is not active");
    let result;
    if (action === "get" || action === "clear") result = await this.rpc.request(`thread/goal/${action}`, { threadId: this.threadId }, 10000);
    else {
      if (action === "resume" && !this.goal) throw new Error("Set a goal before resuming it");
      result = await this.rpc.request("thread/goal/set", { threadId: this.threadId, ...(action === "set" ? { objective } : {}), ...(tokenBudget !== undefined ? { tokenBudget } : {}), status: status || (action === "pause" ? "paused" : "active") }, 10000);
    }
    this.goal = result?.goal || null;
    await this.hooks.onEvent?.({ type: "goal", goal: this.goal });
    return this.goal;
  }

  assertImportReady() {
    if (this.logoutChanging || this.sharedParent?.logoutChanging) throw Object.assign(new Error("Wait for native sign-out to finish before starting agent work"), { statusCode: 409 });
    const imports = this.importControls || this.sharedParent?.importControls;
    if (imports?.changing || imports?.needsRefresh) throw Object.assign(new Error("Refresh /import to finish reconciling the import before starting agent work"), { statusCode: 409 });
  }

  async confirmImportWorkerStopped(observed) {
    if (this.executor?.metadata?.backend === "ec2" && observed?.stopped === true && observed.instanceId === this.executor.metadata.instanceId && this.importControls) {
      await this.importStop;
      await this.importControls.workerStopped(this.importWorkerId);
    }
  }

  assertInputReady() {
    this.assertImportReady();
    if (this.memoryControls?.changing || this.sharedParent?.memoryControls?.changing) throw new Error("Wait for the current memory change to finish");
    if (this.memoryControls?.needsRefresh || this.sharedParent?.memoryControls?.needsRefresh) throw new Error("Refresh /memories to reconcile the previous memory change before sending");
    if (this.featureControls?.changing || this.sharedParent?.featureControls?.changing) throw new Error("Wait for the current feature change to finish");
    if (this.featureControls?.needsRefresh || this.sharedParent?.featureControls?.needsRefresh) throw new Error("Refresh /experimental to reconcile the previous feature change before sending");
    if (this.hookControls?.changing || this.sharedParent?.hookControls?.changing) throw new Error("Wait for the current hook change to finish");
    if (this.hookControls?.needsRefresh || this.sharedParent?.hookControls?.needsRefresh) throw new Error("Refresh /hooks to reconcile the previous hook change before sending");
    if (this.plugins?.changing || this.sharedParent?.plugins?.changing) throw new Error("Wait for the current plugin change to finish");
    if (this.plugins?.needsRefresh || this.sharedParent?.plugins?.needsRefresh) throw new Error("Refresh /plugins to reconcile the previous plugin change before sending");
  }

  async logoutSnapshot(check = () => {}) {
    check(); const rpc = this.rpc, threadId = this.threadId, workerId = this.importWorkerId, accountEpoch = this.accountEpoch || 0;
    if (!rpc || !threadId || !workerId || this.intentionalStop || this.sharedParent) throw new Error("Connect this chat's native Codex worker before inspecting sign-out");
    const busy = () => this.nativeSettingsBusy() || [this.plugins, this.hookControls, this.featureControls, this.memoryControls, this.importControls].some(service => service?.changing || service?.needsRefresh);
    const authMode = this.nativeAuthMode || this.config.codex.authMode;
    const base = { threadId, workerId, gateway: authMode === "gateway", privateProfile: authMode !== "host",
      busy: busy(), account: null, credentialPresent: null, storage: null, canLogout: false };
    if (!base.privateProfile) return { ...base, reason: "This shared host profile may be used by other companies. Native sign-out is locked until company/profile isolation is complete." };
    if (authMode === "account") return { ...base, reason: "Disconnect this named account in Agent accounts to remove its saved credentials and stop its workers." };
    const guard = () => {
      check(); if (this.rpc !== rpc || this.threadId !== threadId || this.importWorkerId !== workerId || this.intentionalStop) throw new Error("The sign-out worker changed or stopped");
      if ((this.accountEpoch || 0) !== accountEpoch) throw new Error("The native account changed during inspection. Refresh /logout.");
    };
    const policy = await codexLogoutPolicy((method, params) => rpc.request(method, params, 15000), this.workspace, guard);
    base.storage = policy.storage;
    if (!this.logoutStartupPolicy || this.logoutStartupPolicy.revision !== policy.revision) return { ...base, reason: "Native credential storage changed or its startup policy is unknown. Inspect again after your own worker restart; Relay will not restart it automatically." };
    if (!["file", "ephemeral"].includes(policy.storage)) return { ...base, reason: "OS keyring/automatic credential storage is locked pending profile-isolation verification. No credential store was accessed or changed." };
    const files = await inspectCodexAuthFile(this.executor, { home: this.runtimeHome, nativeHome: this.nativeHome }, guard);
    let info;
    try { info = await rpc.request("account/read", { refreshToken: false }, 15000); } catch { guard(); throw new Error("The native account could not be inspected. No token refresh or sign-out was requested."); }
    guard();
    const account = info?.account;
    if (typeof info?.requiresOpenaiAuth !== "boolean" || account !== null && (!account || !["apiKey", "chatgpt"].includes(account.type))) return { ...base, reason: "This authentication method cannot be verified for scoped native sign-out." };
    const after = await inspectCodexAuthFile(this.executor, { home: this.runtimeHome, nativeHome: this.nativeHome }, guard); guard();
    if (files.revision !== after.revision) throw new Error("Native credentials changed during inspection. Refresh /logout.");
    const email = typeof account?.email === "string" ? account.email.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 160) : null;
    const visible = account ? { type: account.type, email } : null;
    const present = policy.storage === "file" ? files.present : Boolean(account);
    const safeEphemeral = policy.storage !== "ephemeral" || !files.present;
    return { ...base, busy: busy(), account: visible, credentialPresent: files.present, canLogout: present && safeEphemeral,
      revision: logoutHash([threadId, workerId, accountEpoch, policy.revision, files.revision, visible, info.requiresOpenaiAuth]),
      reason: !safeEphemeral ? "A stored credential file coexists with in-memory authentication. Scoped sign-out is unavailable until the storage choice is reconciled."
        : policy.storage === "ephemeral" && !info.requiresOpenaiAuth && !account ? "This gateway provider does not expose its in-memory native account. Relay cannot verify scoped removal; gateway access itself is unchanged."
        : !present ? "No stored native credentials are available to clear. Environment or Relay gateway authentication is not removed by /logout." : "" };
  }

  async performLogout(revision, check, dispatched) {
    const rpc = this.rpc, snapshot = await this.logoutSnapshot(check); check();
    if (!snapshot.canLogout || snapshot.revision !== revision || snapshot.busy || this.nativeSettingsBusy()) throw new Error("The reviewed credentials, storage or agent activity changed. Inspect /logout again.");
    dispatched(); this.accountEpoch = (this.accountEpoch || 0) + 1;
    // Invalidate cached account data, without yielding between the final
    // credential check and native dispatch. Native account/updated follows too.
    this.hooks.onEvent?.({ type: "native_account_updated" });
    const response = await rpc.request("account/logout", {}, 30000); check();
    if (!response || typeof response !== "object" || Array.isArray(response) || Object.keys(response).length) throw new Error("Unrecognized native sign-out acknowledgement");
    const after = await this.logoutSnapshot(check); check();
    if (this.rpc !== rpc || after.account !== null || after.credentialPresent !== false || after.storage !== snapshot.storage) throw new Error("Native credential removal could not be verified");
  }

  async feedbackPolicy(check = () => {}, startup = false) {
    check(); const rpc = this.rpc, threadId = this.threadId, workerId = this.importWorkerId;
    if (!rpc || !threadId || this.intentionalStop || this.sharedParent) throw new Error("Connect this chat's native Codex worker before reviewing feedback");
    const guard = () => { check(); if (this.rpc !== rpc || this.threadId !== threadId || this.importWorkerId !== workerId || this.intentionalStop) throw new Error("The feedback worker changed or stopped"); };
    const result = await codexFeedbackPolicy({ request: (method, params) => rpc.request(method, params, startup ? 5000 : 20000), workspace: this.workspace,
      nativeHome: this.nativeHome, privateProfile: (this.nativeAuthMode || this.config.codex.authMode) !== "host", threadId, workerId }, guard);
    guard(); if (startup) return result;
    const initial = this.feedbackStartupPolicy;
    const enabled = result.enabled && initial?.enabled !== false;
    const logsAllowed = enabled && result.logsAllowed && initial?.logsAllowed === true && initial.revision === result.revision;
    return { ...result, enabled, logsAllowed, revision: `${result.revision}:${initial?.revision || "unknown-startup"}`,
      logsReason: !enabled ? "Feedback is disabled by current or startup native configuration. A changed startup setting requires your own worker restart."
        : result.logsReason || (!logsAllowed ? "Startup diagnostic configuration is unavailable or changed. Logs require a verified fresh worker; Relay will not restart it automatically." : "") };
  }

  async uploadFeedback(payload, check) {
    check(); const rpc = this.rpc, threadId = this.threadId;
    if (!rpc || payload.threadId !== threadId || this.intentionalStop || this.sharedParent) throw new Error("The reviewed feedback worker stopped");
    // Only CodexFeedback constructs this payload after a persisted confirmation.
    // There is intentionally no retry on timeout or disconnect.
    const result = await rpc.request("feedback/upload", payload, 60000); check();
    if (this.rpc !== rpc || this.threadId !== threadId || this.intentionalStop) throw new Error("The feedback connection changed");
    return result;
  }

  async approveDeniedAction(event, check) {
    this.assertInputReady(); check();
    const rpc = this.rpc, threadId = this.threadId;
    if (!rpc || !threadId || this.current || this.sharedParent || this.intentionalStop) throw new Error("The reviewed native session must be connected and idle");
    const result = await rpc.request("thread/approveGuardianDeniedAction", { threadId, event }, 30000);
    check();
    if (this.rpc !== rpc || this.threadId !== threadId || this.intentionalStop || !result || typeof result !== "object") throw new Error("The native approval connection changed");
  }

  async setPermissionMode(mode, check = () => {}, acknowledge = () => {}) {
    check();
    // A mode selected while the runtime is still starting must still govern
    // thread/start. RuntimeManager owns validation and persists only after this
    // method returns, so retaining the requested value here is safe.
    const rpc = this.rpc, threadId = this.threadId;
    if (!rpc || !threadId || this.intentionalStop) { this.mode = mode; return false; }
    await rpc.request("thread/settings/update", {
      threadId,
      ...codexApprovalSettings(mode),
      sandboxPolicy: mode === "plan" ? { type: "readOnly" } : { type: "workspaceWrite", writableRoots: [this.workspace], networkAccess: false },
      collaborationMode: { mode: mode === "plan" ? "plan" : "default", settings: { model: this.chat.model || this.config.codex.model, reasoning_effort: this.chat.effort || null, developer_instructions: null } },
    }, 10000);
    check();
    if (this.rpc !== rpc || this.threadId !== threadId || this.intentionalStop) throw new Error("The Codex permission connection changed");
    this.mode = mode;
    this.agents?.setPermissionMode(mode);
    acknowledge();
    if (mode === "auto") this.#declineStaleApprovals();
    return true;
  }

  async send(text, { model, effort, mode = "auto", images = [], skills = [], appReferences = [], additionalContext = {}, goalDirective = null, reviewTarget = null, serviceTier, personality } = {}) {
    this.assertInputReady();
    if (!this.rpc) await this.start();
    this.assertImportReady();
    if (this.current) throw new Error("A Codex turn is already running for this chat");

    let resolveTurn;
    let rejectTurn;
    const completion = new Promise((resolve, reject) => {
      resolveTurn = resolve;
      rejectTurn = reject;
    });
    const timer = setTimeout(() => this.#rejectCurrent(new Error("Codex turn timed out after one hour")), 3_600_000);
    const current = this.current = { text: "", finalText: "", resolveTurn, rejectTurn, timer, done: completion.catch(() => {}) };
    current.review = Boolean(reviewTarget);
    const startReady = Promise.withResolvers(); current.started = startReady.promise;
    current.goalRun = !reviewTarget && mode !== "plan" && (Boolean(goalDirective) || this.goal?.status === "active");
    current.activatingGoal = Boolean(goalDirective) && mode !== "plan";
    if (current.goalRun) clearTimeout(timer);

    try {
      if (reviewTarget && appReferences.length) throw new Error("Native code review does not accept app references");
      const appMentions = await this.apps.mentions(appReferences);
      if (current.interruptRequested || this.current !== current || !this.rpc) throw new Error("Codex turn interrupted before startup");
      // Setting an ACTIVE goal on a populated thread immediately starts native
      // continuation. Stage it PAUSED, establish this turn's model/permissions,
      // then activate while that turn is already tracked. Plan stays paused.
      if (goalDirective) {
        if (goalDirective.action === "resume" && !this.goal) throw new Error("Set a goal before resuming it");
        await this.goalAction(goalDirective.action === "set" ? "set" : "pause", goalDirective.objective, "paused");
        if (goalDirective.action === "set") await this.hooks.onEvent?.({ type: "notice", text: `Goal set: ${goalDirective.objective}` });
      }
      if (current.interruptRequested) throw new Error("Codex turn interrupted before startup");
      const turnSettings = {
        threadId: this.threadId,
        ...(model ? { model } : {}),
        ...(effort ? { effort } : {}),
        ...(serviceTier !== undefined ? { serviceTier } : {}),
        ...(personality ? { personality } : {}),
        ...codexApprovalSettings(mode),
        sandboxPolicy: mode === "plan" ? { type: "readOnly" } : { type: "workspaceWrite", writableRoots: [this.workspace], networkAccess: false },
        collaborationMode: { mode: mode === "plan" ? "plan" : "default", settings: { model: model || this.config.codex.model, reasoning_effort: effort || null, developer_instructions: null } },
      };
      // turn/start applies settings to the explicit turn, but native /goal
      // continuations are created by the thread itself. Persist the same
      // settings before every turn so Auto remains non-interactive on those
      // continuations too, including for threads created before this fix.
      await this.rpc.request("thread/settings/update", turnSettings, 10000);
      this.mode = mode;
      if (reviewTarget) {
        // Review is its own native turn, not a prompt asking the main agent to
        // pretend to be the reviewer. Pause an active goal so it cannot start
        // an editing continuation as soon as the review finishes.
        if (this.goal?.status === "active") await this.goalAction("pause");
      }
      if (current.interruptRequested) throw new Error("Codex turn interrupted before startup");
      const starting = reviewTarget
        ? this.rpc.request("review/start", { threadId: this.threadId, target: reviewTarget, delivery: "inline" }, 60_000)
        : this.rpc.request("turn/start", { ...turnSettings, ...(Object.keys(additionalContext).length ? { additionalContext } : {}), input: [{ type: "text", text }, ...images.map(imagePath => ({ type: "localImage", path: imagePath })), ...skills.map(skill => ({ type: "skill", name: skill.name, path: skill.path })), ...appMentions] }, 60_000);
      const started = await starting; startReady.resolve(started);
      if (!reviewTarget) await this.hooks.onInputStarted?.({ forkGoal: Boolean(goalDirective?.fork) });
      if (reviewTarget) current.reviewTurnId = started.turn?.id;
      current.turnId ||= started.turn?.id;
      if (current.pendingReviewCompletion) {
        const pending = current.pendingReviewCompletion; current.pendingReviewCompletion = null;
        this.#notification(pending);
      }
      if (current.activatingGoal) {
        if (!current.interruptRequested) await this.goalAction("resume");
        current.activatingGoal = false;
        if (current.awaitingContinuation && this.goal?.status !== "active") this.#finishGoalRun();
      }
      const result = await completion;
      await this.checkpointNativeSession({ boundary: "turn-completed", turnId: current.turnId || null }).catch(error => this.checkpointNotice(error));
      return result;
    } catch (error) {
      startReady.resolve(null);
      this.#rejectCurrent(error);
      await completion.catch(() => {});
      throw error;
    }
  }

  async respond(requestId, payload) {
    const request = this.requests.get(requestId);
    if (!request || !this.rpc) throw new Error("approval request is no longer active");
    this.requests.delete(requestId);
    this.rpc.respond(request.rpcId, payload);
  }

  async interrupt() {
    const current = this.current;
    if (!current) {
      if (this.goal?.status === "active") await this.goalAction("pause");
      const active = this.agents?.snapshot?.().threads?.filter(thread => thread.status === "active").map(thread => thread.id) || [];
      await Promise.all(active.map(threadId => this.agents.interrupt(threadId)));
      return;
    }
    current.interruptRequested = true;
    if (this.goal?.status === "active") await this.goalAction("pause");
    const started = await current.started;
    if (this.current !== current) return;
    const turnId = current.turnId || started?.turn?.id;
    if (!turnId) throw new Error("Codex has not returned the current turn ID; try again shortly");
    await this.rpc.request("turn/interrupt", { threadId: this.threadId, turnId }, 15000);
    await current.done;
    this.requests.clear();
  }

  async #forceTerminate() {
    if (this.sharedParent) { await this.stop(); return; }
    this.intentionalStop = true;
    clearTimeout(this.nativeCheckpointTimer); this.nativeCheckpointTimer = null;
    const cleanup = Promise.allSettled([this.pluginCli?.stop(), this.agents?.close(), ...[...this.children].map(child => child.stop())]);
    this.children.clear();
    for (const request of this.requests.values()) {
      try { this.rpc?.respond(request.rpcId, { decision: "cancel" }); } catch {}
    }
    this.requests.clear();
    this.#rejectCurrent(new Error("Turn interrupted by native process-group termination"));
    const rpc = this.rpc;
    this.rpc = null;
    if (rpc) await rpc.stop();
    await cleanup;
    this.broker.revoke(this.capability); this.capability = "";
  }

  async forceInterrupt() {
    await this.#forceTerminate();
    this.intentionalStop = false;
    await this.start({ skipCheckpointRestore: true });
    if (this.goal?.status === "active") await this.goalAction("pause");
  }

  async forceStop() { await this.#forceTerminate(); }

  async inspect() {
    if (!this.rpc) return {};
    const [limits, connectors, account] = await Promise.allSettled([
      this.rpc.request("account/rateLimits/read", {}, 10000),
      this.rpc.request("mcpServerStatus/list", { limit: 100, detail: "toolsAndAuthOnly" }, 10000),
      this.rpc.request("account/read", { refreshToken: false }, 10000),
    ]);
    return { rateLimits: limits.status === "fulfilled" ? safeRateLimits(limits.value) : null,
      account: account.status === "fulfilled" && account.value.account ? { planType: account.value.account.planType || null } : null,
      connectors: connectors.status === "fulfilled" ? (connectors.value.data || []).map(server => ({ name: server.name, status: server.authStatus || "configured", tools: Object.keys(server.tools || {}).length })) : null };
  }

  machineHealth() {
    const child = this.rpc?.child, receipt = child?.receipt;
    return { pid: child?.pid || null, pgid: receipt?.groupAnchor?.pid || child?.pid || null,
      state: child ? child.exitCode === null && child.signalCode === null ? "running" : "exited" : "stopped",
      heartbeatAt: child?.lastHeartbeatAt || this.rpc?.lastActivityAt || null,
      heartbeatExpected: Boolean(receipt),
      control: child?.detached === true ? "detached" : this.rpc ? "connected" : "disconnected" };
  }

  async inspectCommand(command) {
    if (!this.rpc) throw new Error("Codex runtime is not active");
    if (command === "ps") {
      const items = [], cursors = new Set(); let cursor;
      do {
        const result = await this.rpc.request("thread/backgroundTerminals/list", { threadId: this.threadId, limit: 100, ...(cursor ? { cursor } : {}) }, 10000);
        items.push(...(result.data || []).map(item => ({ id: item.processId, title: redact(item.command || "Background command"), detail: redact(item.cwd || "") })));
        cursor = result.nextCursor;
        if (cursor && cursors.has(cursor)) throw new Error("Native background-terminal pagination repeated a cursor");
        if (cursor) cursors.add(cursor);
      } while (cursor && items.length < 1000);
      return { title: "Background terminals", items, note: "Processes tracked by this Codex thread. Other chats and untracked processes are not included." };
    }
    if (command === "debug-config") {
      const result = await this.rpc.request("config/read", { cwd: this.workspace, includeLayers: false }, 10000);
      const keys = ["model", "model_provider", "model_reasoning_effort", "service_tier", "personality", "approval_policy", "approvals_reviewer", "sandbox_mode"];
      // Explicit allowlist: config may include provider secrets, MCP headers,
      // shell variables and capabilities. Never expose the raw native response.
      const items = keys.filter(key => typeof result.config?.[key] === "string").map(key => ({ id: key, title: `${key}: ${redact(result.config[key])}`, detail: result.origins?.[key]?.name?.type || "default" }));
      return { title: "Codex configuration", items, note: "Effective non-secret configuration on disk and its source layers. Per-turn model and permission overrides are shown in this chat's controls. Credentials and environment variables are excluded." };
    }
    throw new Error("Unknown native inspection command");
  }

  async terminateBackground(processId) {
    if (!this.rpc) throw new Error("Codex runtime is not active");
    if (processId === "all") return this.rpc.request("thread/backgroundTerminals/clean", { threadId: this.threadId }, 10000);
    const info = await this.inspectCommand("ps");
    if (!info.items.some(item => item.id === processId)) throw new Error("That background terminal is no longer tracked by this chat");
    return this.rpc.request("thread/backgroundTerminals/terminate", { threadId: this.threadId, processId }, 10000);
  }

  async compact() {
    this.assertImportReady();
    if (!this.rpc || this.current) throw new Error("Compaction needs an active, idle Codex session");
    let resolveTurn, rejectTurn;
    const complete = new Promise((resolve, reject) => { resolveTurn = resolve; rejectTurn = reject; });
    const timer = setTimeout(() => this.#rejectCurrent(new Error("Context compaction timed out")), 180000);
    const startReady = Promise.withResolvers();
    this.current = { text: "", finalText: "", resolveTurn, rejectTurn, timer, done: complete.catch(() => {}), started: startReady.promise, resolveStarted: startReady.resolve };
    try { await this.rpc.request("thread/compact/start", { threadId: this.threadId }, 10000); return await complete; }
    catch (error) { this.#rejectCurrent(error); await complete.catch(() => {}); throw error; }
  }

  async prepareTransportSuspend() {
    if (this.sharedParent || !this.rpc || this.intentionalStop) return { retained: false };
    if (this.current || this.requests.size || this.nativeSettingsBusy() || this.agents?.busy()
      || [this.plugins, this.hookControls, this.featureControls, this.memoryControls, this.importControls].some(service => service?.changing || service?.needsRefresh)) {
      throw new Error("Codex is not at a quiescent suspension boundary");
    }
    if (this.nativeAuthMode === "gateway" && !this.broker.validate(this.capability, "openai")) {
      throw new Error("Codex provider capability expired before hibernation");
    }
    const child = this.rpc.child;
    if (typeof child?.markRecoverable !== "function") return { retained: false };
    await this.nativeCapture;
    const checkpoint = await child.markRecoverable({ provider: "codex", threadId: this.threadId, cliVersion: this.cliVersion || null });
    return { retained: true, processId: "native-agent", checkpoint,
      capabilities: this.nativeAuthMode === "gateway" ? { provider: { provider: "openai", token: this.capability,
        credentialHash: providerCredentialHash(this.config.codex) } } : {} };
  }

  async detachTransportForSuspend() {
    const rpc = this.rpc;
    if (!rpc || typeof rpc.child?.detach !== "function") return { detached: false };
    if (this.current || this.requests.size) throw new Error("Codex changed after its suspension checkpoint");
    this.intentionalStop = true;
    await this.pluginCli?.stop();
    await this.agents?.close();
    if (typeof rpc.child.relinquish === "function") await rpc.child.relinquish();
    else rpc.child.detach();
    this.rpc = null;
    this.broker.revokeChat(this.chat.id);
    return { detached: true, processId: "native-agent" };
  }

  async stop({ checkpointVersion } = {}) {
    this.intentionalStop = true;
    clearTimeout(this.nativeCheckpointTimer); this.nativeCheckpointTimer = null;
    await this.pluginCli?.stop();
    if (this.sharedParent) {
      const rpc = this.rpc;
      try {
        if (rpc) {
          await this.interrupt().catch(() => {});
          await rpc.request("thread/backgroundTerminals/clean", { threadId: this.threadId }, 10000).catch(() => {});
          await rpc.request("thread/unsubscribe", { threadId: this.threadId }, 10000).catch(() => {});
        }
      } finally {
        this.#rejectCurrent(new Error("Side chat closed")); this.requests.clear(); this.rpc = null;
        for (const [event, listener] of Object.entries(this.sharedListeners || {})) rpc?.off(event, listener);
        this.sharedListeners = null; this.sharedParent.children.delete(this);
      }
      return;
    }
    await this.agents?.close();
    await Promise.allSettled([...this.children].map(child => child.stop()));
    if (this.goal?.status === "active") await this.goalAction("pause").catch(() => {});
    for (const request of this.requests.values()) {
      try { this.rpc?.respond(request.rpcId, { decision: "cancel" }); } catch {}
    }
    this.requests.clear();
    this.#rejectCurrent(new Error("Turn interrupted because the worker was stopped"));
    await this.checkpointNativeSession({ boundary: "stopping", stopping: true, checkpointVersion }).catch(() => {});
    await this.nativeCapture;
    const rpc = this.rpc;
    if (rpc) await Promise.allSettled([...this.createdForks].map(threadId => rpc.request("thread/archive", { threadId }, 1000)));
    this.createdForks.clear();
    this.rpc = null;
    if (rpc) await rpc.stop();
    // Retain known tokens for delayed notifications and restored native
    // history throughout this adapter's lifetime, including after refresh.
    await this.importStop;
    this.broker.revokeChat(this.chat.id);
  }

  #notification(message) {
    this.importControls?.notification(message);
    const { method, params = {} } = message;
    if (method === "account/updated") { this.accountEpoch = (this.accountEpoch || 0) + 1; this.hooks.onEvent?.({ type: "native_account_updated" }); return; }
    if (params.threadId && this.threadId && params.threadId !== this.threadId) return;
    if (["item/completed", "turn/completed"].includes(method) && params.threadId === this.threadId) this.scheduleNativeCheckpoint();
    if (method === "item/autoApprovalReview/completed" && params.threadId === this.threadId && params.review?.status === "denied") {
      this.hooks.onEvent?.({ type: "native_approval_denied", report: params }); return;
    }
    if (method === "thread/settings/updated") this.settings = params.threadSettings || this.settings;
    if (method === "thread/goal/updated" || method === "thread/goal/cleared") {
      this.goal = params.goal || null;
      this.hooks.onEvent?.({ type: "goal", goal: this.goal });
      if (this.current?.awaitingContinuation && !this.current.activatingGoal && this.goal?.status !== "active") this.#finishGoalRun();
    }
    if (method === "turn/started" && this.current) {
      const current = this.current;
      if (current.goalRun && current.awaitingContinuation) {
        clearTimeout(current.continuationTimer); current.awaitingContinuation = false;
        current.text = ""; current.finalText = ""; current.outputRedactor = null;
        current.searchAnswers = new Map();
        current.agentMessageId = undefined; current.pendingAgentMessageId = undefined; current.agentMessageIds = new Set();
        this.hooks.onEvent?.({ type: "goal_turn_started" });
      }
      current.turnId = params.turn?.id || current.turnId;
      this.hooks.onEvent?.({ type: "task_progress", agent: "codex", sessionId: this.threadId, progress: null });
      current.resolveStarted?.({ turn: params.turn });
    }
    if (method === "turn/plan/updated" && params.threadId === this.threadId && this.current && params.turnId === this.current.turnId) {
      this.hooks.onEvent?.({ type: "task_progress", agent: "codex", sessionId: this.threadId, progress: planProgress(params.plan, this.threadId, params.turnId) });
    }
    if (method === "thread/tokenUsage/updated") this.hooks.onEvent?.({ type: "usage", usage: codexUsage(params.tokenUsage) });
    if (method === "account/rateLimits/updated") this.hooks.onEvent?.({ type: "rate_limits", rateLimits: safeRateLimits(params) });
    if (method === "turn/diff/updated") this.hooks.onEvent?.({ type: "workspace_diff", diff: String(params.diff || "").slice(0, 500000) });
    if (method === "serverRequest/resolved") {
      const requestId = `approval_${params.requestId}`;
      this.requests.delete(requestId);
      this.hooks.onEvent?.({ type: "request_resolved", requestId });
      return;
    }
    if (method === "item/agentMessage/delta" && this.current) {
      this.#appendAgentMessage(this.current, params.delta || "", params.itemId);
      return;
    }
    if ((method === "item/started" || method === "item/completed") && params.item) {
      if (method === "item/started" && params.item.type === "agentMessage" && this.current) this.current.pendingAgentMessageId = params.item.id;
      if (method === "item/completed" && params.item.type === "agentMessage" && this.current) {
        captureCodexFinal(this.current, params, this.threadId, text => {
          const filter = new SecretTextStream(this.credentialSecrets);
          return redact(filter.push(text) + filter.finish());
        });
        const id = params.item.id ?? this.current.pendingAgentMessageId ?? "legacy-message";
        // Some transports deliver only a completed message. Keep that block
        // too, without appending a second copy of already-streamed text.
        if (!this.current.agentMessageIds?.has(id)) this.#appendAgentMessage(this.current, params.item.text || "", id);
        this.current.finalText = params.item.text || "";
      }
      if (method === "item/completed" && params.item.type === "exitedReviewMode" && this.current) this.current.reviewText = params.item.review || "";
      const event = safeToolEvent(params.item, method === "item/started" ? "running" : "completed");
      if (event) this.hooks.onEvent?.(event);
      return;
    }
    if (method === "turn/completed" && this.current) {
      const current = this.current;
      if (current.turnId && params.turn?.id && current.turnId !== params.turn.id) {
        // Native inline review reports an inner started-turn ID but completes
        // the outer review/start turn. Retain both without accepting unrelated
        // thread turns; the response can arrive after this notification.
        if (current.review && !current.reviewTurnId) { current.pendingReviewCompletion = message; return; }
        if (!current.review || params.turn.id !== current.reviewTurnId) return;
      }
      const status = params.turn?.status || "completed";
      this.#finishOutput(current);
      if (status === "completed" && current.goalRun) {
        this.hooks.onEvent?.({ type: "goal_turn_completed", text: current.text || current.finalText, finalAnswer: codexFinalAnswer(current, params, this.threadId) });
        current.awaitingContinuation = true;
        if (!current.activatingGoal && this.goal?.status !== "active") this.#finishGoalRun();
        // If the native dispatcher suppresses a continuation, release the idle
        // worker too. Automatic turns normally arrive immediately in this stream.
        else current.continuationTimer = setTimeout(() => { if (this.current === current && current.awaitingContinuation) this.#finishGoalRun(); }, 2000);
        return;
      }
      this.current = null;
      current.resolveStarted?.(null);
      clearTimeout(current.timer);
      clearTimeout(current.continuationTimer);
      if (status === "completed") current.resolveTurn({ text: current.reviewText || current.text || current.finalText, status, finalAnswer: codexFinalAnswer(current, params, this.threadId) });
      else current.rejectTurn(new Error(`Codex turn ended with status ${status}`));
      return;
    }
    if (method === "error") {
      this.hooks.onEvent?.({ type: "notice", level: "error", text: params.error?.message || params.message || "Codex error" });
    }
  }

  #finishGoalRun() {
    const current = this.current;
    if (!current) return;
    this.#finishOutput(current);
    this.current = null; clearTimeout(current.timer); clearTimeout(current.continuationTimer);
    current.resolveTurn({ text: "", status: "completed", turnsHandled: true });
  }

  #serverRequest(message) {
    if (message.method === "account/chatgptAuthTokens/refresh" && this.hooks.accountCredentials && this.nativeAuthMode === "account") {
      const rpc = this.rpc;
      void this.hooks.accountCredentials({ refresh: true, previousAccountId: message.params?.previousAccountId }).then(credentials => {
        this.credentialSecrets.add(credentials.accessToken);
        if (this.rpc === rpc) rpc.respond(message.id, credentials);
      }, () => { if (this.rpc === rpc) rpc.respondError(message.id, -32000, "Reconnect the selected Codex account in Relay"); }).catch(() => {});
      return;
    }
    if (message.params?.threadId && message.params.threadId !== this.threadId) return;
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
    // Auto is deliberately non-interactive. A request can still arrive from a
    // turn that began just before a live mode change (or from an older native
    // continuation). Never display that stale request as if Auto asked the
    // user, and never silently approve it: deny it and let the agent retry
    // under the now-persisted automatic-review policy.
    if (this.mode === "auto" && message.method !== "item/tool/requestUserInput") {
      this.rpc.respond(message.id, message.method === "item/permissions/requestApproval" ? { permissions: {} } : { decision: "decline" });
      this.hooks.onEvent?.({ type: "request_resolved", requestId });
      return;
    }
    this.requests.set(requestId, { rpcId: message.id, method: message.method });
    this.hooks.onRequest?.({ requestId, method: message.method, params: message.params || {} });
  }

  #declineStaleApprovals() {
    for (const [requestId, request] of this.requests) {
      if (request.method === "item/tool/requestUserInput") continue;
      this.requests.delete(requestId);
      this.rpc.respond(request.rpcId, request.method === "item/permissions/requestApproval" ? { permissions: {} } : { decision: "decline" });
      this.hooks.onEvent?.({ type: "request_resolved", requestId });
    }
  }

  #rejectCurrent(error) {
    if (!this.current) return;
    const current = this.current;
    this.#finishOutput(current);
    this.current = null;
    current.resolveStarted?.(null);
    clearTimeout(current.timer);
    clearTimeout(current.continuationTimer);
    current.rejectTurn(error);
  }

  #appendAgentMessage(current, text, itemId) {
    if (!text) return;
    const id = itemId ?? current.pendingAgentMessageId ?? "legacy-message";
    current.agentMessageIds ||= new Set();
    if (current.agentMessageId !== undefined && current.agentMessageId !== id) {
      // Native agentMessage items are separate visible updates, not arbitrary
      // token chunks. Flush redaction safely and retain their paragraph break
      // in both the live stream and the saved turn text.
      const tail = current.outputRedactor?.boundary() || "";
      current.text += tail;
      if (tail) this.hooks.onEvent?.({ type: "assistant_delta", delta: tail });
      const separator = current.text ? current.text.endsWith("\n\n") ? "" : current.text.endsWith("\n") ? "\n" : "\n\n" : "";
      current.text += separator;
      if (separator) this.hooks.onEvent?.({ type: "assistant_delta", delta: separator });
    }
    current.agentMessageId = id; current.agentMessageIds.add(id);
    if (this.nativeAuthMode === "account" || this.credentialSecrets.size) current.outputRedactor ||= new SecretTextStream(this.credentialSecrets);
    const delta = current.outputRedactor ? current.outputRedactor.push(text) : text;
    current.text += delta;
    if (delta) this.hooks.onEvent?.({ type: "assistant_delta", delta });
  }

  #finishOutput(current) {
    const tail = current.outputRedactor?.finish();
    if (!tail) return;
    current.text += tail;
    this.hooks.onEvent?.({ type: "assistant_delta", delta: tail });
  }
}
