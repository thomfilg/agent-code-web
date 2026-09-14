import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { JsonRpcProcess } from "./json-rpc-process.mjs";
const exec = promisify(execFile);
const fail = message => Object.assign(new Error(message), { statusCode: 400 });

export class ModelCatalog {
  constructor(config) { this.config = config; this.cache = new Map(); this.pending = new Map(); }
  async list(agent) {
    if (agent === "mock") return { models: [], source: "mock", note: "Mock mode does not use a model or effort level." };
    if (!["codex", "claude"].includes(agent)) throw fail("Invalid agent");
    const cached = this.cache.get(agent);
    if (cached?.expires > Date.now()) return cached.value;
    if (this.pending.has(agent)) return this.pending.get(agent);
    const promise = (agent === "codex" ? this.codex() : this.claude()).then(value => { this.cache.set(agent, { value, expires: Date.now() + 300000 }); return value; }).finally(() => this.pending.delete(agent));
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
        models.push(...result.data.map(model => ({ id: model.model, label: model.displayName || model.model, description: model.description || "", isDefault: model.isDefault, defaultEffort: model.defaultReasoningEffort, efforts: model.supportedReasoningEfforts.map(e => e.reasoningEffort) })));
        cursor = result.nextCursor;
      } while (cursor);
      return { models, source: "codex-app-server", note: "Models and effort levels reported by the installed Codex CLI.", configuredDefault: this.config.codex.model || null };
    } catch (error) { throw fail(`Could not load Codex models: ${spawnError?.message || error.message}`); }
    finally { await rpc.stop(); await rm(directory, { recursive: true, force: true }); }
  }
  async claude() {
    const { stdout } = await exec(this.config.claude.bin, ["--help"], { timeout: 15000, env: { PATH: process.env.PATH, HOME: os.homedir() } });
    const advertised = /--effort[^\n]*\n?\s*\(([^)]+)\)/.exec(stdout)?.[1]?.split(",").map(value => value.trim()) || [];
    const efforts = ["low", "medium", "high", "xhigh", "max"].filter(value => advertised.includes(value));
    const aliases = ["opus", "sonnet", "haiku"];
    if (stdout.includes("fable")) aliases.unshift("fable");
    return { models: aliases.map(id => ({ id, label: id[0].toUpperCase() + id.slice(1), efforts: id === "haiku" ? [] : efforts, defaultEffort: null })), source: "claude-cli-aliases", configuredDefault: this.config.claude.model || null, note: "CLI model aliases. The resolved version and account availability are checked by Claude when you send a message; Fable may require usage credits." };
  }
  async validate(agent, input) {
    const model = input.model || null; const effort = input.effort || null;
    if (model !== null && (typeof model !== "string" || model.length > 150 || !/^[a-zA-Z0-9_.\[\]-]+$/.test(model))) throw fail("Invalid model name");
    if (effort !== null && typeof effort !== "string") throw fail("Invalid effort level");
    if (!model && !effort) return { model: null, effort: null };
    const catalog = await this.list(agent);
    const selected = catalog.models.find(item => item.id === (model || catalog.configuredDefault)) || (!model ? catalog.models.find(item => item.isDefault) : null);
    if (agent === "mock" || (model && !selected)) throw fail("Choose a model from the available models list");
    const allowed = selected?.efforts || (agent === "claude" ? catalog.models.find(item => item.id === "opus")?.efforts : []);
    if (effort && !allowed?.includes(effort)) throw fail("This effort level is not supported by the selected model");
    return { model, effort };
  }
  async turnSettings(chat) {
    if (!chat.model && !chat.effort && !chat.modelSelectionSet) return {};
    const catalog = await this.list(chat.agent);
    const selected = catalog.models.find(item => item.id === chat.model) || catalog.models.find(item => item.id === catalog.configuredDefault) || catalog.models.find(item => item.isDefault);
    return { model: chat.model || catalog.configuredDefault || selected?.id || (chat.agent === "claude" ? "default" : null), effort: chat.effort || (chat.agent === "codex" ? selected?.defaultEffort : null) || null, resetEffort: !chat.effort };
  }
}
