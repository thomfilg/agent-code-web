import { createHash } from "node:crypto";
import { spawnWorker, terminateWorker } from "./worker-process.mjs";

const conflict = message => Object.assign(new Error(message), { statusCode: 409 });
const clean = (value, limit = 400) => typeof value === "string" ? value.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, limit) : "";
const validId = value => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,119}@[A-Za-z0-9][A-Za-z0-9_.-]{0,119}$/.test(value);
const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");

// The supported CLI is used for discovery/install/removal. The corresponding
// plugin/list/read/install/uninstall RPCs are explicitly not production APIs.
export class CodexPluginCli {
  constructor({ command, workspace, env, spawn = spawnWorker, isolation = "none", timeoutMs = 30000, maxBytes = 2 * 1024 * 1024 }) {
    Object.assign(this, { command, workspace, spawn, isolation, timeoutMs, maxBytes });
    this.env = Object.fromEntries(["HOME", "CODEX_HOME", "PATH", "LANG", "LC_ALL", "SSL_CERT_DIR", "SSL_CERT_FILE", "TMPDIR", "NO_COLOR", "CI"].filter(key => env[key] !== undefined).map(key => [key, env[key]]));
    this.children = new Set(); this.closed = false;
  }
  async run(args) {
    if (this.closed) throw conflict("The plugin worker stopped; reopen the picker");
    if (!(args.length === 3 && args.join(" ") === "list --available --json") && !(args.length === 3 && ["add", "remove"].includes(args[0]) && validId(args[1]) && args[2] === "--json")) throw new Error("Invalid plugin CLI action");
    const child = this.spawn(this.command, ["plugin", ...args], { cwd: this.workspace, env: this.env, isolation: this.isolation, stdio: ["ignore", "pipe", "pipe"] });
    this.children.add(child);
    try {
      return await new Promise((resolve, reject) => {
        let bytes = 0, chunks = [], settled = false;
        const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(value); };
        const timer = setTimeout(() => finish(new Error("Native plugin command timed out. Refresh to check its state before retrying.")), this.timeoutMs);
        child.stdout.on("data", chunk => {
          bytes += chunk.length;
          if (bytes > this.maxBytes) finish(new Error("The native plugin catalog exceeded its output limit"));
          else if (!settled) chunks.push(chunk);
        });
        // Never return raw CLI stderr: registries may print credential-bearing URLs.
        child.stderr.on("data", chunk => { bytes += chunk.length; if (bytes > this.maxBytes) finish(new Error("The native plugin command exceeded its output limit")); });
        child.once("error", () => finish(new Error("Cannot start the native plugin CLI; check the worker's Codex installation")));
        child.once("close", code => {
          if (this.closed) return finish(conflict("The plugin worker stopped; refresh before retrying"));
          if (code !== 0) return finish(new Error("Native plugin command failed. Check marketplace access and the installed Codex version, then refresh before retrying."));
          try { finish(null, JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
          catch { finish(new Error("The native plugin CLI returned invalid JSON; update the worker's Codex CLI")); }
          chunks = [];
        });
      });
    } finally { await terminateWorker(child); this.children.delete(child); }
  }
  async stop() { this.closed = true; await Promise.allSettled([...this.children].map(child => terminateWorker(child))); }
}

export class CodexPlugins {
  constructor({ run, request, workspace, thread, mutable = false, busy = () => false, changed = async () => {} }) {
    Object.assign(this, { run, workspace, thread, mutable, busy, changed });
    this.request = async (method, params) => {
      try { return await request(method, params); }
      catch { throw new Error(`Native plugin operation ${method} failed. Refresh to check its state; verify the worker's Codex version and marketplace access.`); }
    };
    this.changing = false; this.needsRefresh = false;
  }
  async list(check = () => {}) {
    check(); const threadId = this.thread();
    if (!threadId) throw conflict("Connect this chat's native session before managing plugins");
    if (this.needsRefresh && !this.changing) {
      if (this.busy()) throw conflict("Wait for the agents to be idle before reconciling the previous plugin change");
      this.changing = true;
      try { await this.sync(check); this.needsRefresh = false; } finally { this.changing = false; }
    }
    const cli = await this.run(["list", "--available", "--json"]); check();
    if (!Array.isArray(cli?.installed) || !Array.isArray(cli?.available)) throw new Error("This Codex CLI does not support the plugin catalog");
    const runtime = await this.request("plugin/installed", { cwds: [this.workspace] }); check();
    if (!Array.isArray(runtime?.marketplaces)) throw new Error("This Codex CLI did not return plugin policy");
    const policies = new Map();
    for (const marketplace of runtime.marketplaces) for (const item of (marketplace.plugins || [])) {
      if (validId(item?.id)) policies.set(item.id, policies.has(item.id) ? null : item);
    }
    const entries = new Map();
    for (const raw of [...cli.installed, ...cli.available]) {
      if (!validId(raw?.pluginId)) continue;
      const old = entries.get(raw.pluginId);
      if (old && digest(old) !== digest(raw)) entries.set(raw.pluginId, { ...raw, ambiguous: true });
      else if (!old) entries.set(raw.pluginId, raw);
    }
    const all = [...entries.values()].sort((a, b) => a.pluginId.localeCompare(b.pluginId));
    const plugins = all.slice(0, 200).map(raw => {
      const policy = policies.get(raw.pluginId), installed = raw.installed === true;
      const ambiguous = raw.ambiguous || (policies.has(raw.pluginId) && !policy);
      const managed = policy?.installPolicySource === "WORKSPACE_SETTING" || policy?.installPolicy === "INSTALLED_BY_DEFAULT" || raw.installPolicy === "INSTALLED_BY_DEFAULT";
      const available = raw.installPolicy === "AVAILABLE" && (!policy || (policy.availability === "AVAILABLE" && policy.installPolicy === "AVAILABLE")) && !policy?.disabledReason;
      // plugin/installed omits uninstalled entries. Discovery and install policy
      // for those come from the supported CLI; native add enforces that policy.
      const known = !installed || policy?.installed === true;
      const consent = !installed && policy?.mustShowInstallationInterstitial === true;
      const loadError = Boolean(runtime.marketplaceLoadErrors?.length);
      const allowed = this.mutable && !ambiguous && !managed && available && known && !consent && !loadError;
      return { id: raw.pluginId, name: clean(policy?.interface?.displayName || raw.name, 160), marketplace: clean(raw.marketplaceName, 160),
        description: clean(policy?.interface?.longDescription || policy?.interface?.shortDescription, 2000),
        version: clean(raw.version || policy?.localVersion || policy?.version, 100), source: clean(raw.source?.source || policy?.source?.type, 40),
        capabilities: (policy?.interface?.capabilities || []).filter(value => typeof value === "string").slice(0, 20).map(value => clean(value, 80)),
        installed, enabled: installed && policy?.enabled === true,
        actions: allowed ? installed ? [policy.enabled ? "disable" : "enable", "remove"] : ["install"] : [],
        reason: !this.mutable ? "Shared host profile — inspection only" : ambiguous ? "Ambiguous plugin identity" : managed ? "Managed by native workspace policy" : !known ? "Native installation state unavailable" : consent ? "Requires native installation consent" : loadError ? "Refresh after resolving native marketplace errors" : !available ? "Unavailable under native policy" : "",
      };
    });
    if (threadId !== this.thread()) throw conflict("The native session changed; reopen the plugin picker");
    // Sources participate in the revision but are never returned to the browser.
    const revision = digest({ threadId, cli: all, policies: [...policies].sort(([a], [b]) => a.localeCompare(b)) });
    return { threadId, revision, plugins, mutable: this.mutable, busy: this.busy(), truncated: all.length > 200, warning: runtime.marketplaceLoadErrors?.length ? "Some native marketplaces could not be loaded. Plugin changes are disabled until they can be refreshed." : "" };
  }
  async change(input, check = () => {}) {
    if (!this.mutable) throw conflict("Plugin changes require a private chat profile. Shared host configuration is read-only.");
    if (this.changing || this.busy()) throw conflict("Wait for this chat and its agents to be idle before changing plugins");
    if (this.needsRefresh) throw conflict("Refresh the plugin picker to reconcile the previous change before retrying");
    if (!validId(input?.id) || !["install", "remove", "enable", "disable"].includes(input.action) || input.confirm !== true) throw new Error("Choose and confirm a plugin action from this chat's picker");
    if (input.threadId !== this.thread() || typeof input.revision !== "string") throw conflict("The native session changed; refresh the plugin picker");
    this.changing = true;
    try {
      const before = await this.list(check); check();
      if (this.busy()) throw conflict("Wait for this chat and its agents to be idle before changing plugins");
      if (input.revision !== before.revision) throw conflict("The plugin catalog changed; refresh and confirm the action again");
      const plugin = before.plugins.find(item => item.id === input.id);
      if (!plugin?.actions.includes(input.action)) throw conflict("This plugin action is no longer permitted by the native policy");
      this.needsRefresh = true;
      if (["install", "remove"].includes(input.action)) await this.run([input.action === "install" ? "add" : "remove", plugin.id, "--json"]);
      else await this.request("config/batchWrite", { edits: [{ keyPath: `plugins.${JSON.stringify(plugin.id)}.enabled`, value: input.action === "enable", mergeStrategy: "replace" }], reloadUserConfig: true });
      check(); await this.sync(check);
      const after = await this.list(check), result = after.plugins.find(item => item.id === plugin.id);
      const applied = input.action === "remove" ? result ? !result.installed : !after.truncated : input.action === "disable" ? result?.installed && !result.enabled : result?.installed && result.enabled;
      if (!applied) throw conflict("The native plugin state did not match the requested change. Refresh before retrying; native or project policy may override it.");
      this.needsRefresh = false;
      return after;
    } finally { this.changing = false; }
  }
  async sync(check) {
    if (!this.mutable) throw conflict("Shared host configuration is read-only");
    check(); await this.request("plugin/reconcile", { reason: "Explicit Relay plugin change" }); check();
    // Reload external CLI writes without replacing any unrelated config key.
    await this.request("config/batchWrite", { edits: [], reloadUserConfig: true }); check();
    await this.changed(); check();
  }
}
