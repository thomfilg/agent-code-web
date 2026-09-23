import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { JsonRpcProcess } from "./json-rpc-process.mjs";
import { claudeFastScope } from "./claude-fast.mjs";
import { compareSemver } from "./utils.mjs";
const exec = promisify(execFile);
const fail = message => Object.assign(new Error(message), { statusCode: 400 });

// Aliases whose availability depends on the installed Claude CLI being new
// enough, not merely on --help mentioning the word. Update as new gated
// aliases ship; an alias absent from this table is always available once the
// CLI advertises it.
const CLAUDE_MODEL_GATES = { fable: "2.1.280" };

export class ModelCatalog {
  constructor(config) { this.config = config; this.cache = new Map(); this.pending = new Map(); }
  defaults(agent) { return { model: this.config[agent]?.model || null, effort: this.config[agent]?.effort || null }; }
  async creationSettings(agent, input = {}) {
    if (agent === "mock") return this.validate(agent, input);
    const defaults = this.defaults(agent);
    const catalog = await this.list(agent);
    const model = input.model || defaults.model;
    const selected = catalog.models.find(item => item.id === model);
    return this.validate(agent, { model, effort: input.effort || (selected?.efforts.includes(defaults.effort) ? defaults.effort : selected?.defaultEffort) || null });
  }
  // Drop a cached/in-flight catalog so the next list() re-derives it from the
  // currently installed CLI. Call this once a software update activates a new
  // CLI version; without it the picker can stay stale for up to five minutes,
  // or indefinitely if the caller never happens to hit the TTL again.
  invalidate(agent = null) {
    if (agent) { this.cache.delete(agent); this.pending.delete(agent); }
    else { this.cache.clear(); this.pending.clear(); }
  }
  async list(agent) {
    if (agent === "mock") return { models: [], source: "mock", note: "Mock mode does not use a model or effort level." };
    if (!["codex", "claude"].includes(agent)) throw fail("Invalid agent");
    const cached = this.cache.get(agent);
    if (cached?.expires > Date.now()) return cached.value;
    if (this.pending.has(agent)) return this.pending.get(agent);
    const promise = (agent === "codex" ? this.codex() : this.claude()).then(value => {
      value = { ...value, configuredDefault: this.defaults(agent).model, configuredDefaultEffort: this.defaults(agent).effort, defaults: this.defaults(agent) };
      // A stale lookup started before invalidate() must not resurrect the
      // pre-update catalog after a fresher one was requested: only the
      // identity-matching in-flight promise is allowed to populate the cache.
      if (this.pending.get(agent) === promise) this.cache.set(agent, { value, expires: Date.now() + 300000 });
      return value;
    }).finally(() => { if (this.pending.get(agent) === promise) this.pending.delete(agent); });
    this.pending.set(agent, promise); return promise;
  }
  async codex() {
    const directory = await mkdtemp(path.join(os.tmpdir(), "relay-models-"));
    const hostAuth = this.config.codex.authMode === "host";
    const env = { PATH: process.env.PATH, HOME: hostAuth ? os.homedir() : directory, LANG: process.env.LANG || "C.UTF-8" };
    if (hostAuth && process.env.CODEX_HOME) env.CODEX_HOME = process.env.CODEX_HOME;
    const rpc = new JsonRpcProcess({ command: this.config.codex.bin, args: ["app-server"], spawnOptions: { cwd: directory, env }, isolation: this.config.processIsolation, requestTimeoutMs: 15000 });
    let spawnError; rpc.on("error", error => { spawnError = error; });
    try {
      rpc.start();
      await rpc.request("initialize", { clientInfo: { name: "agent_relay_model_picker", version: "1.0" }, capabilities: { experimentalApi: false } }); rpc.notify("initialized", {});
      const models = []; let cursor;
      do {
        const result = await rpc.request("model/list", { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) });
        models.push(...result.data.map(model => ({ id: model.model, label: model.displayName || model.model, description: model.description || "", isDefault: model.isDefault, defaultEffort: model.defaultReasoningEffort, efforts: model.supportedReasoningEfforts.map(e => e.reasoningEffort), supportsPersonality: model.supportsPersonality === true, serviceTiers: (model.serviceTiers || []).map(tier => ({ id: tier.id, name: tier.name, description: tier.description })) })));
        cursor = result.nextCursor;
      } while (cursor);
      return { models, source: "codex-app-server", note: "Models and effort levels reported by the installed Codex CLI.", configuredDefault: this.config.codex.model || null };
    } catch (error) { throw fail(`Could not load Codex models: ${spawnError?.message || error.message}`); }
    finally { await rpc.stop(); await rm(directory, { recursive: true, force: true }); }
  }
  async claudeVersion() {
    try {
      const { stdout } = await exec(this.config.claude.bin, ["--version"], { timeout: 15000, env: { PATH: process.env.PATH, HOME: os.homedir() } });
      return /(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)/.exec(stdout)?.[1] || null;
    } catch { return null; }
  }
  async claude() {
    const [{ stdout }, installedVersion] = await Promise.all([
      exec(this.config.claude.bin, ["--help"], { timeout: 15000, env: { PATH: process.env.PATH, HOME: os.homedir() } }),
      this.claudeVersion(),
    ]);
    const advertised = /--effort[^\n]*\n?\s*\(([^)]+)\)/.exec(stdout)?.[1]?.split(",").map(value => value.trim()) || [];
    const efforts = ["low", "medium", "high", "xhigh", "max"].filter(value => advertised.includes(value));
    const aliases = ["opus", "sonnet", "haiku", "default", "best", "sonnet[1m]", "opus[1m]", "opusplan"];
    // An alias needs both: the installed CLI advertises it in --help, and (if
    // gated) the installed version meets the minimum. An unparsable installed
    // version does not disable an otherwise-advertised alias (fail open on
    // "can't tell", not silently stuck disabled after a real update).
    const gateOk = id => { const min = CLAUDE_MODEL_GATES[id]; if (!min) return true; const cmp = compareSemver(installedVersion, min); return cmp === null || cmp >= 0; };
    if (stdout.includes("fable") && gateOk("fable")) aliases.unshift("fable");
    return { models: aliases.map(id => ({ id, label: id === "default" ? "Claude account default" : id[0].toUpperCase() + id.slice(1), efforts: id === "haiku" ? ["auto"] : ["auto", ...efforts], defaultEffort: null })), source: "claude-cli-aliases", configuredDefault: this.config.claude.model || null, installedVersion, note: "CLI aliases; Claude checks account availability when you send and may use a different planning model in Plan mode. Auto effort uses Claude's native default; Fable may require usage credits." };
  }
  async validate(agent, input) {
    const model = input.model || null; const effort = input.effort || null;
    if (model !== null && (typeof model !== "string" || model.length > 150 || !/^[a-zA-Z0-9_.\[\]-]+$/.test(model))) throw fail("Invalid model name");
    if (effort !== null && typeof effort !== "string") throw fail("Invalid effort level");
    if (!model && !effort && !Object.hasOwn(input, "serviceTier") && !Object.hasOwn(input, "personality")) return { model: null, effort: null };
    const catalog = await this.list(agent);
    const selected = catalog.models.find(item => item.id === (model || catalog.configuredDefault)) || (!model ? catalog.models.find(item => item.isDefault) : null);
    if (agent === "mock" || (model && !selected)) throw fail("Choose a model from the available models list");
    const allowed = selected?.efforts || (agent === "claude" ? catalog.models.find(item => item.id === "opus")?.efforts : []);
    if (effort && !(agent === "claude" && effort === "auto") && !allowed?.includes(effort)) throw fail("This effort level is not supported by the selected model");
    const extra = {};
    if (Object.hasOwn(input, "serviceTier")) {
      if (agent !== "codex" || (input.serviceTier !== null && !selected?.serviceTiers?.some(tier => tier.id === input.serviceTier))) throw fail("This service tier is not available for the selected model");
      extra.serviceTier = input.serviceTier;
    }
    if (Object.hasOwn(input, "personality")) {
      if (agent !== "codex" || !selected?.supportsPersonality || !["friendly", "pragmatic", "none"].includes(input.personality)) throw fail("Choose a supported personality: friendly, pragmatic, or none");
      extra.personality = input.personality;
    }
    return { model, effort, ...extra };
  }
  async selected(chat) {
    const catalog = await this.list(chat.agent);
    const model = chat.model || catalog.configuredDefault;
    return catalog.models.find(item => item.id === model) || (!model ? catalog.models.find(item => item.isDefault) : null);
  }
  async fastSettings(chat, action = "toggle") {
    const selected = await this.selected(chat);
    const tier = selected?.serviceTiers?.find(item => /^fast$/i.test(item.name || "") || item.id === "fast" || item.id === "priority");
    if (!tier) throw fail("The selected model does not advertise a Fast service tier");
    return { serviceTier: action === "off" || (action === "toggle" && chat.serviceTier === tier.id) ? null : tier.id };
  }
  async turnSettings(chat) {
    if (chat.agent === "mock") return {};
    const catalog = await this.list(chat.agent);
    const target = chat.model || catalog.configuredDefault;
    const selected = catalog.models.find(item => item.id === target) || (!target ? catalog.models.find(item => item.isDefault) : null);
    if (target && !selected) throw fail(`Model ${target} is not available. Choose another model before sending a message.`);
    const effort = chat.agent === "claude" && chat.effort === "auto" ? null : chat.effort || (selected?.efforts.includes(catalog.configuredDefaultEffort) ? catalog.configuredDefaultEffort : selected?.defaultEffort) || null;
    return { model: chat.model || catalog.configuredDefault || selected?.id || (chat.agent === "claude" ? "default" : null), effort, resetEffort: !effort,
      ...(chat.agent === "claude" && typeof chat.claudeFastMode === "boolean" ? { fastMode: chat.claudeFastMode && chat.claudeFastScope === claudeFastScope(chat), fastCredential: chat.claudeFastCredential, fastCooldown: chat.claudeFastCooldown,
        ...(chat.claudeFastStatus?.selectionRevision === chat.modelSettingsRevision ? { fastState: chat.claudeFastStatus?.state } : {}) } : {}),
      ...(chat.agent === "codex" && Object.hasOwn(chat, "serviceTier") ? { serviceTier: selected?.serviceTiers?.some(tier => tier.id === chat.serviceTier) ? chat.serviceTier : null } : {}),
      ...(chat.agent === "codex" && chat.personality ? { personality: selected?.supportsPersonality ? chat.personality : "none" } : {}) };
  }
}
