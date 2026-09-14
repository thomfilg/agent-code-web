import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { CapabilityBroker } from "./capabilities.mjs";
const fail = message => Object.assign(new Error(message), { statusCode: 400 });
const publicConnection = ({ headers, ...connection }) => ({ ...connection, headerNames: Object.keys(headers || {}), hasCredentials: Boolean(Object.keys(headers || {}).length) });

export class McpConnections {
  constructor(records, { ttlMs = 86400000, fetchImpl = fetch } = {}) {
    this.records = records; this.fetch = fetchImpl; this.broker = new CapabilityBroker({ ttlMs }); this.grants = new Map(); this.queue = Promise.resolve();
  }
  async list() { return (await this.records.list("mcp")).map(publicConnection); }
  async get(id) { const value = await this.records.get("mcp", id); if (!value) throw Object.assign(new Error("MCP connection not found"), { statusCode: 404 }); return value; }
  save(input, id = null) { const result = this.queue.then(() => this.saveUnlocked(input, id)); this.queue = result.catch(() => {}); return result; }
  async saveUnlocked(input, id) {
    const old = id ? await this.get(id) : null;
    if (old && input.revision !== old.revision) throw Object.assign(new Error("Connection changed; reload before saving"), { statusCode: 409 });
    const name = String(input.name || "").trim();
    if (!/^[a-zA-Z][\w-]{0,63}$/.test(name)) throw fail("MCP name must start with a letter and use up to 64 letters, numbers, underscores or hyphens");
    if ((await this.list()).some(c => c.id !== id && c.name.toLowerCase() === name.toLowerCase())) throw fail("An MCP connection with this name already exists");
    if (!["http", "stdio"].includes(input.type)) throw fail("Choose HTTP or stdio transport");
    let data;
    if (input.type === "http") {
      let url; try { url = new URL(input.url); } catch { throw fail("Enter a valid MCP endpoint URL"); }
      // Explicit administrator-selected private services are allowed. Plain HTTP
      // is only allowed on loopback; cloud endpoints must use TLS.
      if (!(url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) || url.username || url.password || url.hash || url.search) throw fail("Use an HTTPS MCP endpoint (HTTP only on localhost), without credentials, query strings or fragments");
      const headers = input.headers === undefined ? old?.headers || {} : input.headers;
      if (!headers || typeof headers !== "object" || Array.isArray(headers) || Object.keys(headers).length > 20) throw fail("Headers must be a JSON object of up to 20 entries");
      for (const [key, value] of Object.entries(headers)) if (!/^[A-Za-z][A-Za-z0-9-]*$/.test(key) || /^(host|cookie|origin|connection|content-length|transfer-encoding|mcp-session-id)$/i.test(key) || typeof value !== "string" || value.length > 8192 || /[\r\n\0]/.test(value)) throw fail("Invalid MCP authentication header");
      data = { url: url.href, headers };
    } else {
      if (typeof input.command !== "string" || !input.command.trim() || input.command.length > 1024 || /[\n\r\0]/.test(input.command)) throw fail("Enter an executable name or path, with arguments in the separate JSON list");
      if (!Array.isArray(input.args) || input.args.length > 100 || input.args.some(a => typeof a !== "string" || a.length > 8192 || a.includes("\0"))) throw fail("Arguments must be a JSON array of strings");
      if (input.headers && Object.keys(input.headers).length || input.env && Object.keys(input.env).length) throw fail("Protected credentials are supported with HTTP MCP connections. Do not put secrets in stdio commands or arguments.");
      data = { command: input.command.trim(), args: input.args };
    }
    const value = { id: id || `mcp_${randomUUID()}`, name, type: input.type, ...data, revision: (old?.revision || 0) + 1, updatedAt: new Date().toISOString() };
    await this.records.put("mcp", value.id, value); return publicConnection(value);
  }
  async validateSelection(ids) {
    if (!Array.isArray(ids) || ids.length > 30 || new Set(ids).size !== ids.length || ids.some(id => !/^mcp_[a-f0-9-]{36}$/.test(id))) throw fail("Choose up to 30 saved MCP connections");
    for (const id of ids) await this.get(id); return ids;
  }
  async remove(id) {
    await this.get(id);
    if ((await this.records.list("environment")).some(env => env.mcpIds?.includes(id))) throw fail("Remove this MCP from its environments before deleting it");
    await this.records.delete("mcp", id);
  }
  async runtime(chatId, ids, origin) {
    await this.validateSelection(ids); this.revokeChat(chatId);
    const token = ids.length ? this.broker.issue({ chatId, provider: "mcp" }) : null;
    const connections = await Promise.all(ids.map(id => this.get(id)));
    this.grants.set(chatId, new Map(connections.map(connection => [connection.id, { connection, sessions: new Set() }])));
    return Object.fromEntries(connections.map(c => [`relay_${c.name}`, c.type === "http"
      ? { type: "http", url: `${origin}/gateway/mcp/${c.id}`, headers: { Authorization: `Bearer ${token}` } }
      : { type: "stdio", command: c.command, args: c.args }]));
  }
  revokeChat(chatId) { this.broker.revokeChat(chatId); this.grants.delete(chatId); }
  async handle(request, response, url) {
    const match = /^\/gateway\/mcp\/(mcp_[a-f0-9-]{36})$/.exec(url.pathname); if (!match) return false;
    const finish = (status, message) => { response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); response.end(JSON.stringify({ error: message })); return true; };
    if (!["GET", "POST", "DELETE"].includes(request.method) || url.search || request.headers.origin) return finish(403, "MCP request not allowed");
    const token = /^Bearer (.+)$/i.exec(request.headers.authorization || "")?.[1];
    const grant = this.broker.validate(token, "mcp"), selected = grant && this.grants.get(grant.chatId)?.get(match[1]), connection = selected?.connection;
    if (!connection || connection.type !== "http") return finish(401, "Invalid, expired or out-of-scope MCP capability");
    if (request.headers["mcp-session-id"] && !selected.sessions.has(request.headers["mcp-session-id"])) return finish(403, "MCP session belongs to a different worker connection");
    // Re-check deletion on every request; changed credentials apply next start.
    if (!await this.records.get("mcp", connection.id)) return finish(401, "MCP connection removed");
    const headers = new Headers(connection.headers || {});
    for (const key of ["accept", "content-type", "mcp-session-id", "mcp-protocol-version", "last-event-id"]) if (request.headers[key]) headers.set(key, request.headers[key]);
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 3600000);
    response.once("close", () => { clearTimeout(timer); controller.abort(); });
    try {
      const upstream = await this.fetch(connection.url, { method: request.method, headers, body: request.method === "POST" ? request : undefined, duplex: request.method === "POST" ? "half" : undefined, redirect: "manual", signal: controller.signal });
      if (upstream.status >= 300 && upstream.status < 400) { await upstream.body?.cancel(); return finish(502, "MCP redirects are blocked; configure the final endpoint URL"); }
      if (upstream.ok && upstream.headers.has("mcp-session-id")) selected.sessions.add(upstream.headers.get("mcp-session-id"));
      for (const key of ["content-type", "mcp-session-id", "mcp-protocol-version", "retry-after"]) if (upstream.headers.has(key)) response.setHeader(key, upstream.headers.get(key));
      response.setHeader("cache-control", "no-store"); response.statusCode = upstream.status;
      if (upstream.body) Readable.fromWeb(upstream.body).on("error", () => response.destroy()).pipe(response); else response.end();
    } catch { if (!response.headersSent) finish(502, "MCP connection failed. Check its endpoint and authentication."); else response.end(); }
    return true;
  }
}

export function codexMcpArgs(servers = {}) {
  const toml = value => Array.isArray(value) ? `[${value.map(toml).join(",")}]` : typeof value === "object" ? `{${Object.entries(value).map(([key, v]) => `${JSON.stringify(key)}=${toml(v)}`).join(",")}}` : JSON.stringify(value);
  return Object.entries(servers).flatMap(([name, server]) => {
    const fields = server.type === "http" ? { url: server.url, http_headers: server.headers } : { command: server.command, args: server.args };
    return Object.entries(fields).flatMap(([key, value]) => ["-c", `mcp_servers.${name}.${key}=${toml(value)}`]);
  });
}
