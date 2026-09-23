import { createHash } from "node:crypto";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { CapabilityBroker } from "./capabilities.mjs";

const PREFIX = "/gateway/npm/";
const MAX_JSON_BYTES = 32 * 1024 * 1024;
const MAX_TARBALL_BYTES = 512 * 1024 * 1024;
const HOP_BY_HOP = new Set(["authorization", "connection", "content-length", "cookie", "host", "keep-alive", "proxy-authenticate", "proxy-authorization", "set-cookie", "te", "trailer", "transfer-encoding", "upgrade"]);
const fail = (statusCode = 403) => Object.assign(new Error("Protected npm access is unavailable. Stop and restart this chat after checking its environment."), { statusCode });
const tokenHash = token => createHash("sha256").update(token).digest("hex");

function fixedOrigin(value, { registry = false } = {}) {
  let url; try { url = new URL(value); } catch { throw fail(400); }
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || !(url.protocol === "https:" || url.protocol === "http:" && loopback)) throw fail(400);
  if (!registry && url.pathname !== "/") throw fail(400);
  url.pathname = registry ? `${url.pathname.replace(/\/$/, "")}/` : "/";
  return url;
}

function gatewaySettings(origin, capability, userConfigPath) {
  const root = new URL(PREFIX, fixedOrigin(origin)).href;
  const endpoint = new URL(root);
  const config = [
    `registry=${root}`,
    `//${endpoint.host}${endpoint.pathname}:_authToken=\${NODE_AUTH_TOKEN}`,
    "always-auth=true",
    "audit=false",
    "fund=false",
    "update-notifier=false",
    "",
  ].join("\n");
  return {
    config,
    environmentVariables: {
      // This is a revocable, read-only Relay capability — never the upstream
      // NODE_AUTH_TOKEN stored in the environment record.
      NODE_AUTH_TOKEN: capability,
      NPM_CONFIG_USERCONFIG: userConfigPath,
      NPM_CONFIG_REGISTRY: root,
      NPM_CONFIG_AUDIT: "false",
      NPM_CONFIG_FUND: "false",
      NPM_CONFIG_UPDATE_NOTIFIER: "false",
    },
  };
}

function bearer(request) {
  const authorizationHeaders = request.rawHeaders?.filter((_, index) => index % 2 === 0 && request.rawHeaders[index].toLowerCase() === "authorization").length || 0;
  if (request.headers.origin !== undefined || authorizationHeaders !== 1) throw fail(401);
  const match = /^Bearer (cap_[A-Za-z0-9_-]{43})$/.exec(request.headers.authorization || "");
  if (!match) throw fail(401);
  return match[1];
}

function requestHeaders(request, token) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (!value || HOP_BY_HOP.has(name.toLowerCase()) || name.toLowerCase().startsWith("x-forwarded-")) continue;
    headers.set(name, Array.isArray(value) ? value.join(", ") : value);
  }
  headers.set("authorization", `Bearer ${token}`);
  headers.set("user-agent", "agent-relay-npm-gateway/1");
  return headers;
}

function responseHeaders(upstream, response, entry) {
  for (const [name, value] of upstream.headers) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower) || ["content-encoding", "content-length", "location"].includes(lower)) continue;
    response.setHeader(name, value);
  }
  const location = upstream.headers.get("location");
  if (location) response.setHeader("location", rewriteRegistryUrl(location, entry));
  response.setHeader("cache-control", "private, no-store");
}

function targetUrl(entry, url) {
  const target = new URL(entry.registry.href);
  const base = entry.registry.pathname.replace(/\/$/, "");
  target.pathname = `${base}/${url.pathname.slice(PREFIX.length)}`;
  target.search = url.search;
  target.hash = "";
  return target;
}

function rewriteRegistryUrl(value, entry) {
  let url; try { url = new URL(value, entry.registry); } catch { return value; }
  const base = entry.registry.pathname.replace(/\/$/, "");
  if (url.origin !== entry.registry.origin || base && url.pathname !== base && !url.pathname.startsWith(`${base}/`)) return value;
  const suffix = base ? url.pathname.slice(base.length).replace(/^\//, "") : url.pathname.replace(/^\//, "");
  return `${entry.gatewayRoot}${suffix}${url.search}`;
}

function rewriteMetadata(value, entry) {
  if (Array.isArray(value)) return value.map(item => rewriteMetadata(item, entry));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, key === "tarball" && typeof item === "string" ? rewriteRegistryUrl(item, entry) : rewriteMetadata(item, entry)]));
}

async function boundedBody(body, maximum) {
  if (!body) return Buffer.alloc(0);
  const chunks = []; let size = 0;
  for await (const chunk of Readable.fromWeb(body)) {
    size += chunk.length;
    if (size > maximum) throw fail(502);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

// Independent broker: issuing npm authority must never replace the model,
// GitHub, browser or MCP capability belonging to the same chat.
export class NpmRegistryGateway {
  constructor({ ttlMs = 300_000, upstreamBaseUrl = "https://registry.npmjs.org", fetchImpl = fetch, now = Date.now } = {}) {
    this.registry = fixedOrigin(upstreamBaseUrl, { registry: true });
    this.fetch = fetchImpl;
    this.broker = new CapabilityBroker({ ttlMs, now });
    this.entries = new Map(); this.generations = new Map(); this.active = 0; this.closed = false;
  }

  revokeChat(chatId) {
    this.generations.set(chatId, (this.generations.get(chatId) || 0) + 1);
    const entry = this.entries.get(chatId);
    if (entry) { this.entries.delete(chatId); for (const controller of entry.controllers) controller.abort(); }
    this.broker.revokeChat(chatId);
  }

  shutdown() { this.closed = true; for (const chatId of [...this.entries.keys()]) this.revokeChat(chatId); }

  sameEntry(entry) {
    try { return !this.closed && this.entries.get(entry.chatId) === entry && this.generations.get(entry.chatId) === entry.generation && entry.validWhile() === true; }
    catch { return false; }
  }

  runtime(chatId, origin, credential, userConfigPath, { validWhile = () => true } = {}) {
    this.revokeChat(chatId);
    if (!credential || typeof credential.token !== "string" || !credential.token || /[\0\r\n]/.test(credential.token)
      || typeof credential.environmentId !== "string" || !Number.isSafeInteger(credential.revision)) throw fail(400);
    const gatewayRoot = new URL(PREFIX, fixedOrigin(origin)).href;
    const generation = this.generations.get(chatId);
    const fingerprint = JSON.stringify({ environmentId: credential.environmentId, revision: credential.revision, tokenHash: tokenHash(credential.token), registry: this.registry.href });
    const entry = { chatId, generation, validWhile, fingerprint, token: credential.token, registry: new URL(this.registry), gatewayRoot, controllers: new Set() };
    this.entries.set(chatId, entry);
    const capability = this.broker.issue({ chatId, provider: "npm-registry", renewable: true, validWhile: () => this.sameEntry(entry) });
    entry.capability = capability;
    return { token: capability, fingerprint, userConfigPath, ...gatewaySettings(origin, capability, userConfigPath) };
  }

  suspendRuntime(chatId) {
    const entry = this.entries.get(chatId);
    if (!entry || !this.sameEntry(entry) || !this.broker.validate(entry.capability, "npm-registry")) throw fail();
    return { schema: 1, token: entry.capability, fingerprint: entry.fingerprint };
  }

  resumeRuntime(chatId, origin, credential, userConfigPath, snapshot, { validWhile = () => true } = {}) {
    if (snapshot?.schema !== 1 || !/^cap_[A-Za-z0-9_-]{43}$/.test(snapshot.token || "") || typeof snapshot.fingerprint !== "string") throw fail();
    this.revokeChat(chatId);
    if (!credential || typeof credential.token !== "string" || !credential.token || /[\0\r\n]/.test(credential.token)
      || typeof credential.environmentId !== "string" || !Number.isSafeInteger(credential.revision)) throw fail();
    const fingerprint = JSON.stringify({ environmentId: credential.environmentId, revision: credential.revision, tokenHash: tokenHash(credential.token), registry: this.registry.href });
    if (fingerprint !== snapshot.fingerprint) throw fail();
    const gatewayRoot = new URL(PREFIX, fixedOrigin(origin)).href, generation = this.generations.get(chatId);
    const entry = { chatId, generation, validWhile, fingerprint, token: credential.token, registry: new URL(this.registry), gatewayRoot, controllers: new Set(), capability: snapshot.token };
    this.entries.set(chatId, entry);
    this.broker.restoreToken({ token: snapshot.token, chatId, provider: "npm-registry", renewable: true, validWhile: () => this.sameEntry(entry) });
    return { token: snapshot.token, fingerprint, userConfigPath, restored: true, ...gatewaySettings(origin, snapshot.token, userConfigPath) };
  }

  entry(capability) {
    const grant = this.broker.validate(capability, "npm-registry"), entry = grant && this.entries.get(grant.chatId);
    if (!entry || !this.sameEntry(entry) || entry.capability !== capability) throw fail(401);
    return entry;
  }

  async handle(request, response, url) {
    if (url.pathname !== "/gateway/npm" && !url.pathname.startsWith(PREFIX)) return false;
    if (url.pathname === "/gateway/npm") {
      response.writeHead(308, { location: PREFIX, "cache-control": "no-store" }); response.end(); return true;
    }
    let entry, controller;
    try {
      if (!['GET', 'HEAD'].includes(request.method || "GET") || request.url !== url.pathname + url.search || request.url.length > 16_384) throw fail(403);
      const capability = bearer(request); entry = this.entry(capability);
      if (entry.controllers.size >= 4 || this.active >= 16) throw fail(429);
      controller = new AbortController(); entry.controllers.add(controller); this.active++;
      request.once("aborted", () => controller.abort());
      const upstream = await this.fetch(targetUrl(entry, url), { method: request.method, headers: requestHeaders(request, entry.token), redirect: "manual", signal: controller.signal });
      if (!this.sameEntry(entry) || controller.signal.aborted) throw fail(403);
      response.statusCode = upstream.status; responseHeaders(upstream, response, entry);
      if (request.method === "HEAD" || !upstream.body) { response.end(); return true; }
      const contentType = upstream.headers.get("content-type") || "";
      if (/^application\/(?:json|.*\+json)(?:;|$)/i.test(contentType)) {
        const declared = Number(upstream.headers.get("content-length") || 0);
        if (declared > MAX_JSON_BYTES) throw fail(502);
        const body = await boundedBody(upstream.body, MAX_JSON_BYTES);
        if (!this.sameEntry(entry) || controller.signal.aborted) throw fail(403);
        let parsed; try { parsed = JSON.parse(body.toString("utf8")); } catch { throw fail(502); }
        response.end(JSON.stringify(rewriteMetadata(parsed, entry))); return true;
      }
      let bytes = 0;
      const limit = new Transform({ transform(chunk, _encoding, callback) { bytes += chunk.length; callback(bytes > MAX_TARBALL_BYTES ? fail(502) : null, chunk); } });
      await pipeline(Readable.fromWeb(upstream.body), limit, response); return true;
    } catch (error) {
      if (!response.headersSent) response.writeHead(error?.statusCode || (error?.name === "AbortError" ? 403 : 502), { "content-type": "application/json", "cache-control": "no-store" });
      if (!response.writableEnded) response.end('{"error":"protected npm gateway request failed"}\n');
      return true;
    } finally {
      if (controller) { controller.abort(); entry?.controllers.delete(controller); this.active--; }
    }
  }
}

