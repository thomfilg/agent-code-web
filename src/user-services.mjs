import { GitHubConnection } from "./github.mjs";
import { McpConnections } from "./mcp-connections.mjs";
import { Environments } from "./environments.mjs";
import { ChatOrganization } from "./chat-organization.mjs";

// Keep IDs and encrypted payloads intact. Only the record namespace changes;
// there is deliberately no fallback to another user's credentials or settings.
export function userRecords(records, ownerId) {
  const kindFor = kind => `user:${ownerId}:${kind}`;
  return {
    kind: records.kind,
    get: (kind, id) => records.get(kindFor(kind), id),
    list: kind => records.list(kindFor(kind)),
    put: (kind, id, value) => records.put(kindFor(kind), id, value),
    delete: (kind, id) => records.delete(kindFor(kind), id),
  };
}

export class UserServices {
  constructor({ records, config, identity, store, legacy, changed, githubChanged = () => {} }) {
    Object.assign(this, { records, config, identity, store, legacy, changed, githubChanged });
    this.entries = new Map();
    this.ready = new Map();
    legacy.github.onChange = id => {
      // The pre-Google namespace belongs only to its explicit migrated owner
      // (or local-mode owners), never every user's identically named record.
      const owners = new Set([null, identity.legacyOwnerId || null,
        ...store.list().filter(chat => this.isLegacy(chat.ownerId)).map(chat => chat.ownerId || null)]);
      for (const ownerId of owners) this.githubChanged(ownerId, id);
    };
  }
  isLegacy(ownerId) { return !this.identity.enabled || !ownerId || ownerId === this.identity.legacyOwnerId; }
  async forOwner(ownerId) {
    if (this.isLegacy(ownerId)) return this.legacy;
    if (!this.entries.has(ownerId)) this.entries.set(ownerId, this.create(ownerId).catch(error => { this.entries.delete(ownerId); throw error; }));
    return this.entries.get(ownerId);
  }
  async create(ownerId) {
    const records = userRecords(this.records, ownerId);
    const github = new GitHubConnection({ records, config: this.config.github });
    github.onChange = id => this.githubChanged(ownerId, id);
    const mcps = new McpConnections(records, { ttlMs: this.config.sessionCapabilityTtlMs });
    const environments = new Environments(records, this.config.workerBackend, mcps);
    const organization = new ChatOrganization({ records, store: this.store, changed: this.changed });
    environments.onSaved = environment => {
      for (const chat of this.store.list()) if (chat.ownerId === ownerId && chat.environmentId === environment.id) mcps.restrictChat(chat.id, []);
    };
    await environments.initialize();
    const services = { records, github, mcps, environments, organization };
    this.ready.set(ownerId, services); return services;
  }
  all() { return [this.legacy, ...this.ready.values()]; }
  async handleMcp(request, response, url) {
    if (!url.pathname.startsWith("/gateway/mcp/")) return false;
    const token = /^Bearer\s+(.+)$/i.exec(request.headers.authorization || "")?.[1];
    for (const entry of this.all()) if (entry.mcps.broker.validate(token, "mcp")) return entry.mcps.handle(request, response, url);
    return this.legacy.mcps.handle(request, response, url);
  }
  oauthFor(state) {
    for (const entry of this.all()) if (entry.mcps.oauth.flows.has(state)) return entry.mcps.oauth;
    return this.legacy.mcps.oauth;
  }
  revokeChat(chatId) { for (const entry of this.all()) entry.mcps.revokeChat(chatId); }
  githubForMonitor() {
    if (!this.identity.enabled) return this.legacy.github;
    return Object.fromEntries(["request", "requireConnection"].map(method => [method, async (...args) => {
      const options = method === "request" ? args[1] : args[0];
      const services = await this.forOwner(options?.ownerId);
      return services.github[method](...args);
    }]));
  }
}
