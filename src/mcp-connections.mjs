import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { CapabilityBroker } from "./capabilities.mjs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpOAuth } from "./mcp-oauth.mjs";
import { isLinearMcp } from "../public/mcp-provider.js";
import { connectionCompany } from "./companies.mjs";
import { companyForChat, companyScope, normalizeCompanyScope, scopeAllows, scopesOverlap } from "../public/company-scope.js";
const fail = message => Object.assign(new Error(message), { statusCode: 400 });
const publicConnection = ({ headers, oauth, oauthClientSecret, authGeneration, ...connection }) => ({ ...connection, ...companyScope(connection), scopeNeedsReview: !Array.isArray(connection.companies) && !connection.organization, authMode: connection.authMode || (Object.keys(headers || {}).length ? "headers" : "none"), headerNames: Object.keys(headers || {}), hasCredentials: Boolean(Object.keys(headers || {}).length), oauthConnected: Boolean(oauth?.tokens), hasClientSecret: Boolean(oauthClientSecret), health: connection.health || { status: "unverified" } });
const recoveryConnection = connection => ({ id: connection.id, revision: connection.revision || 0,
  authGeneration: connection.authGeneration || 0, companyId: connectionCompany(connection) || null });
const sameRecoveryConnections = (left, right) => JSON.stringify([...left].sort((a, b) => a.id.localeCompare(b.id)))
  === JSON.stringify([...right].sort((a, b) => a.id.localeCompare(b.id)));
const runtimeServers = (connections, origin, token) => {
  const names = new Set(connections.filter(c => !companyScope(c).companies.length).map(c => `relay_${c.name}`));
  return Object.fromEntries(connections.map(c => {
    let name = `relay_${c.name}`;
    if (companyScope(c).companies.length) {
      name = `relay_${c.name.slice(0, 20)}_${c.id.slice(4).replaceAll("-", "")}`;
      while (names.has(name)) name += "_";
      names.add(name);
    }
    return [name, c.type === "http"
      ? { type: "http", url: `${origin}/gateway/mcp/${c.id}`, headers: { Authorization: `Bearer ${token}` } }
      : { type: "stdio", command: c.command, args: c.args }];
  }));
};

export class McpConnections {
  constructor(records, { ttlMs = 86400000, fetchImpl = fetch, companies = null } = {}) {
    this.companies = companies;
    this.records = records; this.fetch = fetchImpl; this.broker = new CapabilityBroker({ ttlMs }); this.grants = new Map(); this.runtimeTokens = new Map(); this.queue = Promise.resolve();
    this.oauth = new McpOAuth(this);
  }
  async list() { await this.queue; return (await this.records.list("mcp")).map(connection => ({ ...publicConnection(connection), ...(this.companies ? { companyId: connectionCompany(connection), scopeNeedsReview: !connectionCompany(connection) } : {}), signIn: this.oauth.status(connection.id) })); }
  async get(id) { const value = await this.records.get("mcp", id); if (!value) throw Object.assign(new Error("MCP connection not found"), { statusCode: 404 }); return value; }
  save(input, id = null) { const result = this.queue.then(() => this.saveUnlocked(input, id)); this.queue = result.catch(() => {}); return result; }
  update(id, revision, transform, { guard } = {}) {
    const result = this.queue.then(async () => {
      const current = await this.get(id);
      if (current.revision !== revision) throw Object.assign(new Error("Connection changed; reload and try again"), { statusCode: 409 });
      const value = transform(current);
      const cancelled = () => Object.assign(new Error("Sign-in was cancelled or replaced. No new credentials were saved."), { statusCode: 409 });
      if (guard && !guard()) throw cancelled();
      await this.records.put("mcp", id, value);
      // Cancellation is synchronous but persistence is asynchronous. Keep the
      // queue locked until the previous record is restored; no pending edit or
      // new sign-in may observe this value as its committed starting point.
      if (guard && !guard()) { await this.records.put("mcp", id, current); throw cancelled(); }
      if (value.authGeneration !== current.authGeneration) this.revokeConnection(id);
      return publicConnection(value);
    });
    this.queue = result.catch(() => {}); return result;
  }
  async saveUnlocked(input, id) {
    const old = id ? await this.get(id) : null;
    if (old && input.revision !== old.revision) throw Object.assign(new Error("Connection changed; reload before saving"), { statusCode: 409 });
    const name = String(input.name || "").trim();
    if (!/^[a-zA-Z][\w-]{0,63}$/.test(name)) throw fail("MCP name must start with a letter and use up to 64 letters, numbers, underscores or hyphens");
    const scope = this.companies ? await this.companies.connectionScope(input, old || {}) : normalizeCompanyScope(input, old || {});
    if ((await this.records.list("mcp")).some(c => c.id !== id && c.name.toLowerCase() === name.toLowerCase() && scopesOverlap(c, scope))) throw fail("An MCP connection with this name already exists for one of the selected companies. Use a distinct name or non-overlapping companies.");
    if (!["http", "stdio"].includes(input.type)) throw fail("Choose HTTP or stdio transport");
    let data;
    if (input.type === "http") {
      let url; try { url = new URL(input.url); } catch { throw fail("Enter a valid MCP endpoint URL"); }
      // Explicit administrator-selected private services are allowed. Plain HTTP
      // is only allowed on loopback; cloud endpoints must use TLS.
      if (!(url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) || url.username || url.password || url.hash || url.search) throw fail("Use an HTTPS MCP endpoint (HTTP only on localhost), without credentials, query strings or fragments");
      const authMode = input.authMode || (input.headers && Object.keys(input.headers).length ? "headers" : old?.authMode || (old?.hasCredentials || Object.keys(old?.headers || {}).length ? "headers" : "none"));
      if (!["oauth", "headers", "none"].includes(authMode)) throw fail("Choose OAuth, authentication headers, or no authentication");
      const sameTarget = old?.type === "http" && old.url === url.href;
      const headers = authMode !== "headers" ? {} : input.headers === undefined ? (sameTarget ? old?.headers || {} : {}) : input.headers;
      if (!headers || typeof headers !== "object" || Array.isArray(headers) || Object.keys(headers).length > 20) throw fail("Headers must be a JSON object of up to 20 entries");
      for (const [key, value] of Object.entries(headers)) if (!/^[A-Za-z][A-Za-z0-9-]*$/.test(key) || /^(host|cookie|origin|connection|content-length|transfer-encoding|mcp-session-id)$/i.test(key) || typeof value !== "string" || value.length > 8192 || /[\r\n\0]/.test(value)) throw fail("Invalid MCP authentication header");
      const oauthClientId = String(input.oauthClientId || "").trim(), oauthScopes = String(input.oauthScopes || (isLinearMcp(url.href) && authMode === "oauth" ? "read" : "")).trim();
      if (oauthClientId.length > 2048 || oauthScopes.length > 2048 || /[\r\n\0]/.test(oauthClientId + oauthScopes)) throw fail("Invalid OAuth client ID or scopes");
      const sameOAuth = sameTarget && old.authMode === authMode && (old.oauthClientId || "") === oauthClientId && (old.oauthScopes || "") === oauthScopes && input.oauthClientSecret === undefined;
      const oauthClientSecret = input.oauthClientSecret === undefined ? (sameOAuth ? old?.oauthClientSecret : undefined) : input.oauthClientSecret;
      if (oauthClientSecret !== undefined && (typeof oauthClientSecret !== "string" || oauthClientSecret.length > 8192 || /[\r\n\0]/.test(oauthClientSecret))) throw fail("Invalid OAuth client secret");
      data = { url: url.href, headers, authMode, ...(authMode === "oauth" ? { oauthClientId, oauthScopes, oauthClientSecret, ...(sameOAuth && old?.oauth ? { oauth: old.oauth } : {}) } : {}) };
    } else {
      if (typeof input.command !== "string" || !input.command.trim() || input.command.length > 1024 || /[\n\r\0]/.test(input.command)) throw fail("Enter an executable name or path, with arguments in the separate JSON list");
      if (!Array.isArray(input.args) || input.args.length > 100 || input.args.some(a => typeof a !== "string" || a.length > 8192 || a.includes("\0"))) throw fail("Arguments must be a JSON array of strings");
      if (input.headers && Object.keys(input.headers).length || input.env && Object.keys(input.env).length) throw fail("Protected credentials are supported with HTTP MCP connections. Do not put secrets in stdio commands or arguments.");
      data = { command: input.command.trim(), args: input.args };
    }
    const value = { id: id || `mcp_${randomUUID()}`, name, ...scope, organization: scope.companies.length === 1 ? scope.companies[0] : null, type: input.type, ...data, authGeneration: randomUUID(), health: { status: input.type === "stdio" ? "worker_pending" : data.authMode === "oauth" && !data.oauth ? "needs_auth" : "unverified" }, revision: (old?.revision || 0) + 1, updatedAt: new Date().toISOString() };
    await this.records.put("mcp", value.id, value);
    if (old) { this.oauth.invalidate(value.id); this.revokeConnection(value.id); }
    return publicConnection(value);
  }
  async validateSelection(ids) {
    if (!Array.isArray(ids) || ids.length > 30 || new Set(ids).size !== ids.length || ids.some(id => !/^mcp_[a-f0-9-]{36}$/.test(id))) throw fail("Choose up to 30 saved MCP connections");
    for (const id of ids) await this.get(id); return ids;
  }
  async forCompany(company) {
    if (!this.companies || !company) return [];
    await this.companies.get(company);
    await this.queue;
    return (await this.records.list("mcp")).filter(connection => connectionCompany(connection) === company &&
      (connection.type === "stdio" || connection.authMode === "none" || connection.oauth?.tokens || Object.keys(connection.headers || {}).length)).map(connection => connection.id);
  }
  async remove(id) {
    await this.get(id);
    if (!this.companies && (await this.records.list("environment")).some(env => env.mcpIds?.includes(id))) throw fail("Remove this MCP from its environments before deleting it");
    this.oauth.forget(id);
    const result = this.queue.then(async () => {
      await this.records.delete("mcp", id); this.revokeConnection(id);
    });
    this.queue = result.catch(() => {}); return result;
  }
  async test(id) {
    const connection = await this.get(id);
    if (connection.type === "stdio") return publicConnection(connection); // Never execute user commands on the controller.
    const client = new Client({ name: "Agent Relay connection test", version: "1.0.0" });
    let transport, health;
    const timeout = AbortSignal.timeout(20000);
    try {
      const headers = await this.oauth.headers(connection);
      transport = new StreamableHTTPClientTransport(new URL(connection.url), { requestInit: { headers }, fetch: async (url, options) => {
        const response = await this.fetch(url, { ...options, redirect: "manual", signal: AbortSignal.any([timeout, ...(options?.signal ? [options.signal] : [])]) });
        if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); throw fail("MCP redirects are blocked; configure the final endpoint URL"); }
        return response;
      } });
      await client.connect(transport, { timeout: 20000, signal: timeout });
      const tools = [], cursors = new Set(); let cursor;
      if (client.getServerCapabilities()?.tools) do {
        const page = await client.listTools(cursor ? { cursor } : {}, { timeout: 20000, signal: timeout });
        tools.push(...page.tools.map(tool => ({ name: tool.name.slice(0, 256), description: (tool.description || "").slice(0, 500) })));
        cursor = page.nextCursor;
        if (tools.length > 2000 || (cursor && cursors.has(cursor))) throw fail("Tool inventory is too large or has invalid pagination");
        cursors.add(cursor);
      } while (cursor);
      // Only this known provider/tool is automatically called, never an arbitrary
      // custom server's tool based on its name or claimed readOnly annotation.
      let workspaceRead;
      if (isLinearMcp(connection.url)) {
        if (!headers.has("authorization")) throw Object.assign(fail("Linear requires account authentication."), { statusCode: 401 });
        if (!tools.some(tool => tool.name === "list_teams")) throw fail("Linear workspace verification is unavailable: expected read-only list_teams tool was not advertised.");
        const result = await client.callTool({ name: "list_teams", arguments: { limit: 1 } }, undefined, { timeout: 20000, signal: timeout });
        if (result.isError) throw fail("Linear workspace read failed. Reconnect and check your workspace permissions.");
        // Do not persist workspace data, issues, identities or tool response text.
        workspaceRead = { tool: "list_teams", checkedAt: new Date().toISOString() };
      }
      health = { status: "connected", checkedAt: new Date().toISOString(), tools, toolCount: tools.length, serverName: client.getServerVersion()?.name?.slice(0, 128), ...(workspaceRead ? { workspaceRead, message: this.companies ? "Authenticated workspace read verified. Available to this company's chats on the next agent start." : "Authenticated workspace read verified. Select this connection in an environment; it applies on the next worker start." } : {}) };
    } catch (error) {
      const authError = [401, 403].includes(error.code) || [401, 403].includes(error.statusCode);
      health = { status: authError ? "needs_auth" : "error", checkedAt: new Date().toISOString(), message: authError ? "Authentication required or access denied. Sign in or check your credentials and permissions." : isLinearMcp(connection.url) ? "Linear verification failed. Reconnect, check workspace permissions and retry. Tool discovery alone is not a verified workspace read." : "Could not connect. Check the endpoint, transport and server availability. Redirects are not followed." };
    } finally {
      if (transport?.sessionId) await transport.terminateSession().catch(() => {});
      await client.close().catch(() => {});
    }
    return this.update(id, connection.revision, current => ({ ...current, health }));
  }
  async runtime(chatId, ids, origin, chat = {}) {
    await this.validateSelection(ids); this.revokeChat(chatId);
    const company = companyForChat(chat);
    if (this.companies && company) await this.companies.get(company);
    // Match the primary repository, never secondary repositories or display groups.
    // Filter before granting credentials, including for stdio servers.
    const connections = (await Promise.all(ids.map(id => this.get(id)))).filter(c => this.companies ? connectionCompany(c) === company && Boolean(company) : scopeAllows(c, company));
    const token = connections.length ? this.broker.issue({ chatId, provider: "mcp" }) : null;
    if (token) this.runtimeTokens.set(chatId, token); else this.runtimeTokens.delete(chatId);
    this.grants.set(chatId, new Map(connections.map(connection => [connection.id, { connection, sessions: new Set(), streams: new Set() }])));
    return runtimeServers(connections, origin, token);
  }
  suspendRuntime(chatId) {
    const selected = this.grants.get(chatId);
    if (!selected) return null;
    const token = this.runtimeTokens.get(chatId);
    if (selected.size && (!token || !this.broker.validate(token, "mcp"))) throw new Error("MCP capability expired before hibernation");
    if (!selected.size && token) throw new Error("MCP capability checkpoint is inconsistent");
    return { schema: 1, token: token || null, connections: [...selected.values()].map(item => recoveryConnection(item.connection)) };
  }
  async resumeRuntime(chatId, ids, origin, chat, snapshot) {
    if (snapshot?.schema !== 1 || !Array.isArray(snapshot.connections)
      || snapshot.connections.length && !/^cap_[A-Za-z0-9_-]{43}$/.test(snapshot.token || "")
      || !snapshot.connections.length && snapshot.token !== null) {
      throw new Error("MCP hibernation checkpoint is invalid");
    }
    await this.validateSelection(ids);
    const company = companyForChat(chat);
    if (this.companies && company) await this.companies.get(company);
    const connections = (await Promise.all(ids.map(id => this.get(id)))).filter(c => this.companies ? connectionCompany(c) === company && Boolean(company) : scopeAllows(c, company));
    if (!sameRecoveryConnections(connections.map(recoveryConnection), snapshot.connections)) {
      throw new Error("MCP connections changed while the worker was hibernated; use Stop before continuing");
    }
    this.revokeChat(chatId);
    this.grants.set(chatId, new Map(connections.map(connection => [connection.id, { connection, sessions: new Set(), streams: new Set() }])));
    if (snapshot.token) {
      this.broker.restoreToken({ token: snapshot.token, chatId, provider: "mcp" });
      this.runtimeTokens.set(chatId, snapshot.token);
    } else this.runtimeTokens.delete(chatId);
    return runtimeServers(connections, origin, snapshot.token);
  }
  revokeChat(chatId) { for (const selected of this.grants.get(chatId)?.values() || []) for (const controller of selected.streams) controller.abort(); this.broker.revokeChat(chatId); this.grants.delete(chatId); this.runtimeTokens.delete(chatId); }
  restrictChat(chatId, allowedIds) {
    const connections = this.grants.get(chatId); if (!connections) return;
    for (const [id, selected] of connections) if (!allowedIds.includes(id)) { for (const controller of selected.streams) controller.abort(); connections.delete(id); }
  }
  revokeConnection(id) { for (const connections of this.grants.values()) { for (const controller of connections.get(id)?.streams || []) controller.abort(); connections.delete(id); } }
  async handle(request, response, url) {
    const match = /^\/gateway\/mcp\/(mcp_[a-f0-9-]{36})$/.exec(url.pathname); if (!match) return false;
    const finish = (status, message) => { response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); response.end(JSON.stringify({ error: message })); return true; };
    if (!["GET", "POST", "DELETE"].includes(request.method) || url.search || request.headers.origin) return finish(403, "MCP request not allowed");
    const token = /^Bearer (.+)$/i.exec(request.headers.authorization || "")?.[1];
    const grant = this.broker.validate(token, "mcp"), selected = grant && this.grants.get(grant.chatId)?.get(match[1]), connection = selected?.connection;
    if (!connection || connection.type !== "http") return finish(401, "Invalid, expired or out-of-scope MCP capability");
    if (request.headers["mcp-session-id"] && !selected.sessions.has(request.headers["mcp-session-id"])) return finish(403, "MCP session belongs to a different worker connection");
    // Re-check deletion on every request; changed credentials apply next start.
    const current = await this.records.get("mcp", connection.id);
    if (!current || current.authGeneration !== connection.authGeneration) return finish(401, "MCP connection changed or disconnected. Restart the worker.");
    let headers; try { headers = await this.oauth.headers(connection); } catch { return finish(401, "MCP sign-in expired. Reconnect in MCP connections, then restart the worker."); }
    const authenticated = await this.records.get("mcp", connection.id);
    if (this.grants.get(grant.chatId)?.get(connection.id) !== selected || authenticated?.authGeneration !== connection.authGeneration) return finish(401, "MCP access was revoked while authenticating");
    for (const key of ["accept", "content-type", "mcp-session-id", "mcp-protocol-version", "last-event-id"]) if (request.headers[key]) headers.set(key, request.headers[key]);
    const controller = new AbortController(); selected.streams.add(controller); const timer = setTimeout(() => controller.abort(), 3600000);
    response.once("close", () => { clearTimeout(timer); selected.streams.delete(controller); controller.abort(); });
    try {
      // Credentials are explicit headers, never ambient browser authentication.
      // Omitting ambient credentials also prevents fetch from trying to replay
      // the non-replayable request stream after an upstream 401 challenge.
      const upstream = await this.fetch(connection.url, { method: request.method, headers, body: request.method === "POST" ? request : undefined, duplex: request.method === "POST" ? "half" : undefined, credentials: "omit", redirect: "manual", signal: controller.signal });
      if ([401, 403].includes(upstream.status)) await this.oauth.accessDenied(connection).catch(() => {});
      if (upstream.status >= 300 && upstream.status < 400) { await upstream.body?.cancel(); return finish(502, "MCP redirects are blocked; configure the final endpoint URL"); }
      if (upstream.ok && upstream.headers.has("mcp-session-id")) selected.sessions.add(upstream.headers.get("mcp-session-id"));
      for (const key of ["content-type", "mcp-session-id", "mcp-protocol-version", "retry-after"]) if (upstream.headers.has(key)) response.setHeader(key, upstream.headers.get(key));
      response.setHeader("cache-control", "no-store"); response.statusCode = upstream.status;
      if (upstream.body) Readable.fromWeb(upstream.body).on("error", () => response.destroy()).pipe(response); else response.end();
    } catch { if (!response.headersSent) finish(502, "MCP connection failed. Check its endpoint and authentication."); else response.end(); }
    return true;
  }
}

const RELAY_APPROVED_SERVERS = new Set(["relay_browser", "relay_github"]);
export function codexMcpArgs(servers = {}) {
  const toml = value => Array.isArray(value) ? `[${value.map(toml).join(",")}]` : typeof value === "object" ? `{${Object.entries(value).map(([key, v]) => `${JSON.stringify(key)}=${toml(v)}`).join(",")}}` : JSON.stringify(value);
  return Object.entries(servers).flatMap(([name, server]) => {
    const fields = server.type === "http" ? { url: server.url, ...(server.headers ? { http_headers: server.headers } : {}),
      ...(server.bearerTokenEnvVar ? { bearer_token_env_var: server.bearerTokenEnvVar } : {}),
      // The relay browser and GitHub servers are built-in, scoped capabilities.
      // Auto mode runs Codex with approval_policy=never, where any tool that still
      // asks for approval fails. Arbitrary MCP connections remain unapproved.
      ...(RELAY_APPROVED_SERVERS.has(name) ? { default_tools_approval_mode: "approve", tool_timeout_sec: 120 } : {}) } : { command: server.command, args: server.args };
    return Object.entries(fields).flatMap(([key, value]) => ["-c", `mcp_servers.${name}.${key}=${toml(value)}`]);
  });
}
