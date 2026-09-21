import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { companyForChat } from "../public/company-scope.js";
import { captureWorker } from "./software.mjs";

const execFileAsync = promisify(execFile);
const fail = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const validName = value => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,119}$/.test(value);
const clean = (value, limit = 600) => typeof value === "string" ? value.replace(/[\x00-\x1f\x7f]/g, " ").trim().slice(0, limit) : "";

export function normalizePluginSource(value) {
  const source = String(value || "").trim().replace(/^https:\/\/github\.com\//i, "").replace(/\.git\/?$/i, "");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(source)) throw fail("Use a public GitHub marketplace in owner/repository format.");
  return source;
}

const httpsSource = source => `https://github.com/${normalizePluginSource(source)}.git`;

async function jsonFile(filename, limit = 512 * 1024) {
  const info = await lstat(filename);
  if (!info.isFile() || info.isSymbolicLink() || info.size > limit) throw fail("The plugin marketplace manifest is invalid or too large.");
  try { return JSON.parse(await readFile(filename, "utf8")); }
  catch { throw fail("The plugin marketplace manifest is not valid JSON."); }
}

function frontmatter(text) {
  if (!text.startsWith("---\n")) return null;
  const end = text.indexOf("\n---", 4);
  if (end < 0) return null;
  const values = {};
  for (const line of text.slice(4, end).split("\n")) {
    const match = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*?)\s*$/.exec(line);
    if (!match) continue;
    let value = match[2];
    if ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"'))) value = value.slice(1, -1);
    values[match[1]] = value;
  }
  return values;
}

async function pluginSkills(directory, pluginName) {
  const root = path.join(directory, "skills"), result = [];
  let entries;
  try {
    const rootInfo = await lstat(root);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) return result;
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) { if (error.code === "ENOENT") return result; throw error; }
  if (entries.length > 500) throw fail(`Plugin ${pluginName} contains too many skills.`);
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const filename = path.join(root, entry.name, "SKILL.md");
    let info; try { info = await lstat(filename); } catch (error) { if (error.code === "ENOENT") continue; throw error; }
    if (!info.isFile() || info.isSymbolicLink() || info.size > 512 * 1024) continue;
    const metadata = frontmatter(await readFile(filename, "utf8"));
    const name = clean(metadata?.name || entry.name, 160);
    if (!validName(name) || String(metadata?.["user-invocable"] || "true").toLowerCase() === "false") continue;
    result.push({ name: `${pluginName}:${name}`, aliases: [name], description: clean(metadata?.description || `${pluginName} skill`) });
  }
  return result.sort((a, b) => a.name.localeCompare(b.name));
}

export async function inspectPluginCheckout(root, source, revision = "") {
  const marketplaceFile = path.join(root, ".claude-plugin", "marketplace.json");
  const marketplace = await jsonFile(marketplaceFile);
  if (!validName(marketplace.name) || !Array.isArray(marketplace.plugins) || marketplace.plugins.length > 200) throw fail("The repository does not contain a supported Claude/Codex marketplace.");
  const canonicalRoot = await realpath(root), plugins = [];
  for (const raw of marketplace.plugins) {
    if (!validName(raw?.name) || typeof raw?.source !== "string" || !raw.source.startsWith("./")) throw fail("The marketplace contains an unsupported plugin entry.");
    const directory = path.resolve(root, raw.source), canonical = await realpath(directory).catch(() => null);
    if (!canonical || !(canonical === canonicalRoot || canonical.startsWith(`${canonicalRoot}${path.sep}`))) throw fail(`Plugin ${raw.name} points outside its marketplace.`);
    const manifest = await jsonFile(path.join(canonical, ".claude-plugin", "plugin.json"));
    if (manifest.name !== raw.name || !validName(manifest.name)) throw fail(`Plugin ${raw.name} has an invalid manifest.`);
    plugins.push({ name: raw.name, version: clean(manifest.version, 80), description: clean(raw.description || manifest.description, 1000), commands: await pluginSkills(canonical, raw.name) });
  }
  return { source: normalizePluginSource(source), revision: clean(revision, 80), marketplace: { name: marketplace.name, description: clean(marketplace.metadata?.description, 1000) }, plugins };
}

export async function inspectPluginSource(source) {
  const normalized = normalizePluginSource(source), directory = await mkdtemp(path.join(os.tmpdir(), "relay-plugin-marketplace-"));
  const checkout = path.join(directory, "checkout");
  try {
    try {
      await execFileAsync("git", ["-c", "credential.helper=", "clone", "--quiet", "--depth=1", "--", httpsSource(normalized), checkout], {
        timeout: 120_000, maxBuffer: 1024 * 1024, env: { PATH: process.env.PATH, LANG: "C.UTF-8", GIT_TERMINAL_PROMPT: "0" },
      });
    } catch { throw fail("Could not download this public GitHub marketplace. Check the repository name and try again.", 502); }
    const { stdout } = await execFileAsync("git", ["-C", checkout, "rev-parse", "HEAD"], { timeout: 10_000, maxBuffer: 1000, env: { PATH: process.env.PATH, LANG: "C.UTF-8" } });
    return await inspectPluginCheckout(checkout, normalized, stdout.trim());
  } finally { await rm(directory, { recursive: true, force: true }); }
}

function publicRecord(record) {
  return { id: record.id, companyId: record.companyId, source: record.source, revision: record.revision, sourceRevision: record.sourceRevision,
    marketplace: record.marketplace, plugins: record.plugins, targets: record.targets, createdAt: record.createdAt, updatedAt: record.updatedAt };
}

function targetSelection(input, snapshot) {
  const available = new Set(snapshot.plugins.map(plugin => plugin.name)), targets = {};
  for (const provider of ["claude", "codex"]) {
    const values = input?.[provider] || [];
    if (!Array.isArray(values) || values.length > 200 || values.some(name => !available.has(name))) throw fail(`Choose valid ${provider === "claude" ? "Claude" : "Codex"} plugins from this marketplace.`);
    targets[provider] = [...new Set(values)].sort();
  }
  if (!targets.claude.length && !targets.codex.length) throw fail("Install at least one plugin for Claude or Codex.");
  return targets;
}

export class CompanyPlugins {
  constructor(records, { companies, config, inspect = inspectPluginSource, capture = captureWorker } = {}) {
    Object.assign(this, { records, companies, config, inspect, capture }); this.queue = Promise.resolve();
  }
  async list(companyId = null) {
    if (companyId) await this.companies.get(companyId);
    return (await this.records.list("company-plugin")).filter(record => !companyId || record.companyId === companyId).map(publicRecord).sort((a, b) => a.marketplace.name.localeCompare(b.marketplace.name));
  }
  preview(source) { return this.inspect(source); }
  save(input, id = null) {
    const operation = this.queue.then(async () => {
      const old = id ? await this.records.get("company-plugin", id) : null;
      if (id && !old) throw fail("Plugin marketplace not found.", 404);
      if (old && input.revision !== old.revision) throw fail("These plugin settings changed in another tab. Reload before saving.", 409);
      const companyId = input.companyId ?? old?.companyId; await this.companies.get(companyId);
      const snapshot = await this.inspect(input.source ?? old?.source), targets = targetSelection(input.targets, snapshot);
      const all = await this.records.list("company-plugin");
      if (all.some(record => record.id !== id && record.companyId === companyId && (record.source === snapshot.source || record.marketplace.name === snapshot.marketplace.name))) throw fail("This marketplace is already configured for the company.", 409);
      const now = new Date().toISOString(), record = { id: id || `plugin_${randomUUID()}`, companyId, source: snapshot.source, sourceRevision: snapshot.revision,
        marketplace: snapshot.marketplace, plugins: snapshot.plugins, targets, revision: (old?.revision || 0) + 1, createdAt: old?.createdAt || now, updatedAt: now };
      await this.records.put("company-plugin", record.id, record);
      const scope = await this.records.get("company-plugin-scope", companyId) || { id: companyId, companyId, providers: {} };
      scope.providers = { claude: scope.providers.claude === true || targets.claude.length > 0, codex: scope.providers.codex === true || targets.codex.length > 0 };
      await this.records.put("company-plugin-scope", companyId, scope);
      return publicRecord(record);
    });
    this.queue = operation.catch(() => {}); return operation;
  }
  async remove(id) {
    const old = await this.records.get("company-plugin", id);
    if (!old) throw fail("Plugin marketplace not found.", 404);
    await this.records.delete("company-plugin", id);
  }
  async commands(companyId, provider) {
    if (!companyId || !["claude", "codex"].includes(provider)) return [];
    const records = await this.list(companyId), commands = [];
    for (const record of records) for (const plugin of record.plugins) if (record.targets[provider].includes(plugin.name)) commands.push(...plugin.commands);
    const aliases = new Map();
    for (const command of commands) for (const alias of command.aliases) aliases.set(alias, (aliases.get(alias) || 0) + 1);
    return commands.map(command => ({ ...command, aliases: command.aliases.filter(alias => aliases.get(alias) === 1) }));
  }
  async configured(chat) {
    const companyId = companyForChat(chat);
    if (!companyId || !["claude", "codex"].includes(chat.agent)) return false;
    if ((await this.list(companyId)).some(record => record.targets[chat.agent].length)) return true;
    return (await this.records.get("company-plugin-scope", companyId))?.providers?.[chat.agent] === true;
  }
  async prepare(executor, chat) {
    const provider = chat.agent;
    if (!executor || !["claude", "codex"].includes(provider)) return;
    const companyId = companyForChat(chat), records = companyId ? await this.list(companyId) : [];
    const desired = records.filter(record => record.targets[provider].length).map(record => ({ source: record.source, sourceRevision: record.sourceRevision,
      marketplace: record.marketplace.name, plugins: record.targets[provider] }));
    if (desired.reduce((total, record) => total + record.plugins.length, 0) > 200) throw new Error(`This company has too many ${provider === "claude" ? "Claude" : "Codex"} plugins configured.`);
    const home = path.posix.join(executor.runtimeHome, provider), env = { HOME: executor.runtimeHome, PATH: executor.environmentPath || executor.backend?.config.ec2.remotePath || process.env.PATH, LANG: "C.UTF-8", CI: "1", NO_COLOR: "1",
      [provider === "claude" ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME"]: home };
    await executor.mkdir(home);
    const statePath = path.posix.join(home, ".relay-company-plugins.json"), fingerprint = createHash("sha256").update(JSON.stringify(desired)).digest("hex");
    let previous = null;
    try {
      const raw = await this.capture(executor, "/bin/sh", ["-c", 'test -f "$1" && cat -- "$1" || true', "plugin-state", statePath], { cwd: executor.workspace, env, maxOutput: 128 * 1024 });
      const parsed = raw ? JSON.parse(raw) : null;
      if (parsed?.version === 1 && parsed.provider === provider && Array.isArray(parsed.marketplaces)) previous = parsed;
    } catch { previous = null; }
    if (!desired.length && !previous) return;
    if (previous?.fingerprint === fingerprint) return;
    const previousMarkets = new Map((previous?.marketplaces || []).filter(item => validName(item?.marketplace) && Array.isArray(item.plugins)).map(item => [item.marketplace, item]));
    const desiredMarkets = new Map(desired.map(item => [item.marketplace, item]));
    const removePlugin = async (name, market) => {
      const args = provider === "claude" ? ["plugin", "uninstall", `${name}@${market}`, "--scope", "user", "--yes"] : ["plugin", "remove", `${name}@${market}`, "--json"];
      try { await this.capture(executor, this.config[provider].bin, args, { cwd: executor.workspace, env }); }
      catch (error) { if (!/not found|not installed/i.test(error.message)) throw error; }
    };
    const removeMarketplace = async market => {
      const args = provider === "claude" ? ["plugin", "marketplace", "remove", market, "--scope", "user"] : ["plugin", "marketplace", "remove", market, "--json"];
      try { await this.capture(executor, this.config[provider].bin, args, { cwd: executor.workspace, env }); }
      catch (error) { if (!/not found|not configured or installed/i.test(error.message)) throw error; }
    };
    try {
      for (const old of previousMarkets.values()) {
        const next = desiredMarkets.get(old.marketplace), replace = !next || next.source !== old.source;
        for (const name of old.plugins.filter(name => validName(name) && (replace || !next.plugins.includes(name)))) await removePlugin(name, old.marketplace);
        if (replace) await removeMarketplace(old.marketplace);
      }
      for (const record of desired) {
        const source = httpsSource(record.source), market = record.marketplace;
        const old = previousMarkets.get(market), marketplaceChanged = !old || old.source !== record.source;
        if (marketplaceChanged) {
          // A prior interrupted install can leave an unrecorded partial marketplace.
          for (const name of record.plugins) await removePlugin(name, market);
          await removeMarketplace(market);
        }
        if (provider === "claude") {
          if (marketplaceChanged) await this.capture(executor, this.config.claude.bin, ["plugin", "marketplace", "add", source, "--scope", "user"], { cwd: executor.workspace, env });
          await this.capture(executor, this.config.claude.bin, ["plugin", "marketplace", "update", market], { cwd: executor.workspace, env });
          for (const name of record.plugins) {
            if (!old?.plugins.includes(name) || old.sourceRevision !== record.sourceRevision) {
              if (old?.plugins.includes(name)) await this.capture(executor, this.config.claude.bin, ["plugin", "update", `${name}@${market}`, "--scope", "user"], { cwd: executor.workspace, env });
              else await this.capture(executor, this.config.claude.bin, ["plugin", "install", `${name}@${market}`, "--scope", "user"], { cwd: executor.workspace, env });
            }
          }
        } else {
          if (marketplaceChanged) await this.capture(executor, this.config.codex.bin, ["plugin", "marketplace", "add", source, "--json"], { cwd: executor.workspace, env });
          await this.capture(executor, this.config.codex.bin, ["plugin", "marketplace", "upgrade", market, "--json"], { cwd: executor.workspace, env });
          for (const name of record.plugins) if (!old?.plugins.includes(name) || old.sourceRevision !== record.sourceRevision) await this.capture(executor, this.config.codex.bin, ["plugin", "add", `${name}@${market}`, "--json"], { cwd: executor.workspace, env });
        }
      }
      const state = JSON.stringify({ version: 1, provider, fingerprint, marketplaces: desired });
      await this.capture(executor, "/bin/sh", ["-c", 'umask 077; printf %s "$2" > "$1.tmp" && mv -- "$1.tmp" "$1"', "plugin-state", statePath, state], { cwd: executor.workspace, env });
    } catch { throw new Error(`Could not install this company's ${provider === "claude" ? "Claude" : "Codex"} plugins. Open Settings → Plugins, verify the public GitHub marketplace, and retry.`); }
  }
}
