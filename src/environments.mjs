import { randomUUID } from "node:crypto";
import { companyForChat, companyScope, normalizeCompanyScope, scopeAllows } from "../public/company-scope.js";

export const SOFTWARE_CATALOG = [
  { id: "chrome", name: "Google Chrome", version: "Stable", description: "Shared live browser and agent tools; a separate profile without your saved logins", check: "google-chrome --version" },
  { id: "docker", name: "Docker", version: "Engine + Compose", description: "Containers and builds on a dedicated EC2 worker only; never the control-plane socket", check: "docker info --format '{{.ServerVersion}}' && docker compose version && docker buildx version", backends: ["ec2"] },
  { id: "node", name: "Node.js", version: "22", description: "JavaScript runtime and npm", check: "node --version" },
  { id: "python", name: "Python", version: "3", description: "Private virtualenv using the base Python 3 runtime", check: "python3 --version" },
  { id: "pnpm", name: "pnpm", version: "10", description: "Fast JavaScript package manager", check: "pnpm --version" },
  { id: "yarn", name: "Yarn", version: "1", description: "Yarn Classic package manager", check: "yarn --version" },
  { id: "typescript", name: "TypeScript", version: "5", description: "TypeScript compiler", check: "tsc --version" },
  { id: "jq", name: "jq", version: "1.7.1", description: "Command-line JSON processor", check: "jq --version" },
];
const RESERVED = /^(?:HOME|USER|LOGNAME|PATH|SHELL|TMPDIR|CI|NODE_OPTIONS|LD_.*|DYLD_.*|BASH_ENV|ENV|DOCKER_.*|COMPOSE_.*|GIT_.*|GH_.*|GITHUB_.*|AWS_.*|AGENT_.*|CODEX_.*|CLAUDE_.*|ANTHROPIC_.*|OPENAI_.*|DATABASE_URL|PG.*)$/;
export function validateVariables(input, previous = []) {
  if (!Array.isArray(input) || input.length > 1000) throw new Error("Variables must be a list of at most 1,000 entries");
  const seen = new Set();
  return input.map(variable => {
    const key = String(variable.key || "").trim();
    if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) throw new Error(`Invalid variable name: ${key}`);
    if (RESERVED.test(key)) throw new Error(`${key} is managed by Agent Relay and cannot be overridden`);
    if (seen.has(key)) throw new Error(`Duplicate variable: ${key}`);
    seen.add(key);
    const old = previous.find(item => item.key === key);
    const value = variable.value === undefined ? old?.value : variable.value;
    if (typeof value !== "string" || value.length > 65536 || value.includes("\0")) throw new Error(`A valid value is required for ${key}`);
    const secret = variable.secret !== false;
    if (old?.secret && !secret && variable.value === undefined) throw new Error(`Re-enter ${key} to make it visible to the agent`);
    return { key, value, secret, enabled: variable.enabled !== false };
  });
}

function publicEnvironment(environment) {
  return { ...environment, ...companyScope(environment), scopeNeedsReview: !Array.isArray(environment.companies), variables: environment.variables.map(({ value, ...v }) => ({ ...v, ...(v.secret ? { hasValue: true } : { value }) })) };
}

export class Environments {
  constructor(records, defaultBackend = "local", mcps = null) { this.records = records; this.defaultBackend = defaultBackend; this.mcps = mcps; this.queue = Promise.resolve(); }
  async initialize() {
    if (!(await this.records.list("environment")).length) {
      await this.save({ name: "Default", backend: this.defaultBackend, allowUnassigned: true, variablesEnabled: true, software: [], variables: [] });
    }
  }
  async list() { return (await this.records.list("environment")).map(publicEnvironment); }
  async get(id, { reveal = false } = {}) {
    const env = await this.records.get("environment", id);
    if (!env) throw Object.assign(new Error("Environment not found"), { statusCode: 404 });
    return reveal ? env : publicEnvironment(env);
  }
  save(input, id = null) {
    const result = this.queue.then(() => this.saveUnlocked(input, id));
    this.queue = result.catch(() => {});
    return result;
  }
  async saveUnlocked(input, id = null) {
    const old = id ? await this.get(id, { reveal: true }) : null;
    if (old && input.revision !== old.revision) throw Object.assign(new Error("This environment changed in another tab. Reload before saving."), { statusCode: 409 });
    const name = String(input.name || "").trim();
    if (!name || name.length > 80) throw new Error("Environment name must contain 1–80 characters");
    if (!["local", "ec2"].includes(input.backend)) throw new Error("Choose a local or cloud environment");
    const software = [...new Set(input.software || [])];
    if (software.some(id => !SOFTWARE_CATALOG.some(p => p.id === id))) throw new Error("Unsupported software package");
    if (software.includes("docker") && input.backend !== "ec2") throw new Error("Docker requires a dedicated EC2 worker. Sharing the control-plane Docker socket with agents is not supported.");
    const setupScript = input.setupScript ?? old?.setupScript ?? "";
    if (typeof setupScript !== "string" || setupScript.length > 50000 || setupScript.includes("\0")) throw new Error("Setup script must be text, at most 50,000 characters");
    if (input.networkAccess && input.networkAccess !== "worker_default") throw new Error("Network restrictions must be enforced by the worker infrastructure; this backend cannot enforce a custom network policy");
    if (input.archived !== undefined && typeof input.archived !== "boolean") throw new Error("Archived must be true or false");
    const all = await this.records.list("environment");
    const mcpIds = input.mcpIds ?? old?.mcpIds ?? [];
    if (this.mcps) await this.mcps.validateSelection(mcpIds);
    else if (mcpIds.length) throw new Error("MCP connections are unavailable");
    if (all.some(env => env.id !== id && env.name.toLowerCase() === name.toLowerCase())) throw new Error("An environment with this name already exists");
    const value = {
      id: id || `env_${randomUUID()}`, name, backend: input.backend, ...normalizeCompanyScope(input, old || {}),
      mcpIds,
      description: String(input.description || "").slice(0, 500),
      variablesEnabled: input.variablesEnabled !== false,
      variables: validateVariables(input.variables || [], old?.variables), software,
      setupScript, networkAccess: "worker_default", archived: input.archived ?? old?.archived ?? false,
      revision: (old?.revision || 0) + 1, createdAt: old?.createdAt || new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    await this.records.put("environment", value.id, value);
    await this.onSaved?.(value);
    return publicEnvironment(value);
  }
  async remove(id, chats) {
    await this.get(id);
    if ((await this.list()).length <= 1) throw new Error("Keep at least one environment");
    if (chats.some(chat => chat.environmentId === id)) throw new Error("This environment is used by a conversation. Delete its conversations first.");
    await this.records.delete("environment", id);
  }
  async runtime(id, chat = {}) {
    const env = await this.get(id, { reveal: true });
    const company = companyForChat(chat);
    if (!scopeAllows(env, company)) throw Object.assign(new Error(`Environment “${env.name}” is not available for ${company || "unassigned chats"}. Select that company in its settings first.`), { statusCode: 403 });
    return {
      id: env.id, name: env.name, revision: env.revision, backend: env.backend, software: env.software,
      ...companyScope(env),
      mcpIds: env.mcpIds || [],
      setupScript: env.setupScript || "", archived: Boolean(env.archived),
      variables: Object.fromEntries(env.variables.filter(v => env.variablesEnabled && v.enabled && !v.secret).map(v => [v.key, v.value])),
      protectedKeys: env.variables.filter(v => env.variablesEnabled && v.enabled && v.secret).map(v => v.key),
    };
  }
}
