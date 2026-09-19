import os from "node:os";
import path from "node:path";
import { mkdir } from "node:fs/promises";
import { JsonRpcProcess } from "./json-rpc-process.mjs";
import { spawnWorker, terminateWorker } from "./worker-process.mjs";
import readline from "node:readline";
import { webCommands } from "../public/web-commands.js";
import { newChatCommands } from "../public/new-chat-commands.js";

const clean = item => ({ name: String(item.name || "").replace(/^\//, "").slice(0, 160), description: String(item.description || "").slice(0, 600), kind: item.kind || "CLI command", aliases: (item.aliases || []).filter(n => typeof n === "string"), ...(item.path ? { path: item.path } : {}) });

// Native initialize metadata, not an invented list of terminal commands. Keep
// only display fields: private account details and paths never enter this cache.
export function claudeCommandMetadata(value) {
  if (!Array.isArray(value) || value.length > 5000) return null;
  const validName = name => typeof name === "string" && name.length > 0 && name.length <= 160 && !/[^\w:.-]/.test(name) && !name.startsWith("__");
  const commands = new Map();
  for (const raw of value) {
    const item = typeof raw === "string" ? { name: raw } : raw;
    if (!item || !validName(item.name)) continue;
    commands.set(item.name, { name: item.name, description: typeof item.description === "string" ? item.description.slice(0, 600) : "",
      aliases: Array.isArray(item.aliases) ? item.aliases.slice(0, 100).filter(validName) : [], kind: "CLI command" });
  }
  return [...commands.values()];
}

const reportedCommands = chat => Array.isArray(chat.commandCatalog) && chat.commandCatalog.length ? [...chat.commandCatalog]
  : (Array.isArray(chat.slashCommands) ? chat.slashCommands : []).filter(name => typeof name === "string").map(name => ({ name }));
export class CommandCatalog {
  constructor(config, models = null) { this.config = config; this.models = models; this.cache = new Map(); this.pending = new Map(); }
  async newChat(context) {
    // Read existing selected-account metadata only. Never call discover(),
    // models.selected(), or a host CLI for an unsaved draft.
    let native = [];
    if (context.agentAccountId) {
      if (!this.models?.accounts) throw new Error("Selected account commands are unavailable");
      if (context.agent === "claude") native = (await this.models.accounts.cachedCommands(context.ownerId, context.agentAccountId, context)).commands;
      else await this.models.accounts.select(context.ownerId, context.agentAccountId, context);
    } else if (this.config.google?.enabled && context.agent !== "mock") throw new Error("Choose an agent account first");
    return newChatCommands(context.agent, native);
  }
  async list(chat) {
    // Admission is repeated even on cache hits. Merely opening the menu never
    // launches a selected-account CLI, provider request or sleeping worker.
    const account = chat.agent === "claude" && chat.agentAccountId && this.models?.accounts?.cachedCommands
      ? await this.models.accounts.cachedCommands(chat.ownerId, chat.agentAccountId, chat) : null;
    const key = `${chat.id}:${chat.agent}:${chat.model || "default"}:${chat.commandCatalogRevision || 0}:${chat.ownerId || ""}:${chat.agentAccountId || ""}:${account?.revision || ""}`;
    if (this.cache.get(key)?.expires > Date.now()) return this.cache.get(key).value;
    if (this.pending.has(key)) return this.pending.get(key);
    const promise = this.discover(chat, account).then(value => { if (this.pending.get(key) === promise) this.cache.set(key, { value, expires: Date.now() + 60000 }); return value; }).finally(() => { if (this.pending.get(key) === promise) this.pending.delete(key); });
    this.pending.set(key, promise); return promise;
  }
  invalidate(chatId) {
    for (const map of [this.cache, this.pending]) for (const key of map.keys()) if (key.startsWith(`${chatId}:`)) map.delete(key);
  }
  async discover(chat, account = null) {
    let items = [], note = "";
    if (chat.agent === "mock") items = [];
    else if (this.config.workerBackend === "ec2" || chat.agent === "claude" && chat.agentAccountId) {
      items = reportedCommands(chat);
      // A worker's inventory (including an explicitly reported empty list) is
      // authoritative. Account discovery supplies only the pre-worker fallback.
      if (!items.length && !chat.commandCatalogRevision && account?.commands?.length) {
        items = [...account.commands];
        note = "Commands reported by Claude for the selected account. Workspace commands appear after its worker reports them.";
      } else note = "Last worker-reported commands. Sleeping cloud workers are not started to refresh this list.";
    } else {
      try { items = chat.agent === "codex" ? await this.codex(chat) : await this.claude(chat); }
      catch { items = reportedCommands(chat); note = "Command discovery unavailable. Showing web controls and last reported commands."; }
    }
    // skills/list gives executable Codex skills, not terminal UI settings. Old
    // cached terminal placeholders must not return as broken menu entries.
    if (chat.agent === "codex") items = items.filter(item => item.kind === "Skill" && item.path);
    // The installed Claude omits its terminal-only reload callback from SDK
    // discovery. Relay implements this action through reload_plugins instead.
    if (chat.agent === "claude") items.push({ name: "reload-plugins", description: "Reload installed plugins and refresh this session's commands through the native SDK", kind: "SDK control" });
    let model;
    if (chat.agent === "codex" && this.models) try { model = await this.models.selected(chat); } catch { /* Model-only controls wait for successful catalog discovery. */ }
    items.push(...webCommands(chat.agent, { personality: model?.supportsPersonality, fast: model?.serviceTiers?.some(tier => /^fast$/i.test(tier.name || "") || ["fast", "priority"].includes(tier.id)) }));
    const map = new Map();
    for (const raw of items) { const item = clean(raw); if (!/^[\w:.-]+$/.test(item.name) || item.name.startsWith("__")) continue; map.set(item.name, { ...item, web: item.kind === "Web control" }); for (const alias of item.aliases) if (/^[\w:.-]+$/.test(alias)) map.set(alias, { ...item, name: alias, aliasFor: item.name, web: item.kind === "Web control" }); }
    return { commands: [...map.values()].sort((a, b) => a.name.localeCompare(b.name)), note };
  }
  async env(agent, chat) {
    // Never inherit API keys or the control-plane environment.
    const host = !this.config.google?.enabled && !chat.agentAccountId && this.config[agent]?.authMode === "host";
    const home = host ? os.homedir() : path.join(path.dirname(chat.workspace), "runtime-home");
    const env = { HOME: home, PATH: process.env.PATH, LANG: "C.UTF-8" };
    if (!host) { const directory = path.join(home, agent); await mkdir(directory, { recursive: true, mode: 0o700 }); env[agent === "codex" ? "CODEX_HOME" : "CLAUDE_CONFIG_DIR"] = directory; }
    if (host) { if (agent === "codex" && process.env.CODEX_HOME) env.CODEX_HOME = process.env.CODEX_HOME; if (agent === "claude" && process.env.CLAUDE_CONFIG_DIR) env.CLAUDE_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR; }
    return env;
  }
  async codex(chat) {
    const rpc = new JsonRpcProcess({ command: this.config.codex.bin, args: ["app-server", ...(chat.agentAccountId || this.config.google?.enabled ? ["-c", 'cli_auth_credentials_store="ephemeral"'] : [])], spawnOptions: { cwd: chat.workspace, env: await this.env("codex", chat) }, isolation: this.config.processIsolation, requestTimeoutMs: 15000 });
    rpc.on("error", () => {});
    try {
      rpc.start(); await rpc.request("initialize", { clientInfo: { name: "agent_relay_commands", version: "1" }, capabilities: { experimentalApi: true } }); rpc.notify("initialized", {});
      const result = await rpc.request("skills/list", { cwds: [chat.workspace], forceReload: true });
      return (result.data || []).flatMap(entry => (entry.skills || []).filter(s => s.enabled !== false).map(s => ({ name: s.name, description: s.description || s.shortDescription, path: s.path, kind: "Skill" })));
    } finally { await rpc.stop(); }
  }
  async claude(chat) {
    const child = spawnWorker(this.config.claude.bin, ["--print", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"], { cwd: chat.workspace, env: await this.env("claude", chat), isolation: this.config.processIsolation, stdio: ["pipe", "pipe", "pipe"] });
    const lines = readline.createInterface({ input: child.stdout }); child.stderr.resume();
    try {
      return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Command discovery timed out")), 15000);
        const finish = (error, commands) => { clearTimeout(timer); error ? reject(error) : resolve(commands); };
        child.once("error", error => finish(error)); child.once("exit", () => finish(new Error("Command discovery stopped")));
        lines.on("line", line => { try { const event = JSON.parse(line); if (event.type === "control_response" && event.request_id === "catalog") finish(null, event.response?.response?.commands || []); else if (event.type === "control_response" && event.response?.request_id === "catalog") finish(null, event.response?.response?.commands || []); } catch {} });
        child.stdin.write(`${JSON.stringify({ type: "control_request", request_id: "catalog", request: { subtype: "initialize" } })}\n`);
      });
    } finally { lines.close(); await terminateWorker(child); }
  }
}
