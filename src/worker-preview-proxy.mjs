import { Agent, request as httpRequest } from "node:http";
import { createHash } from "node:crypto";
import { Transform } from "node:stream";
import { openWorkerTcp } from "./worker-tcp-bridge.mjs";
import { closeIncompleteRequestAfterResponse } from "./http-request-lifecycle.mjs";

const fail = (code, status = 502) => Object.assign(new Error("Preview transport failed"), { code, status });
const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const LOCAL = new Set(["localhost", "127.0.0.1", "[::1]"]);
const HOP = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"]);
const DEFAULTS = Object.freeze({ requestBytes: 32 * 1024 * 1024, responseBytes: 256 * 1024 * 1024, websocketBytes: 256 * 1024 * 1024,
  connectTimeoutMs: 15000, headersTimeoutMs: 30000, idleTimeoutMs: 60000, maxLifetimeMs: 300000,
  maxActive: 32, maxPerOwner: 12, maxPerChat: 8 });
const active = { total: 0, owners: new Map(), chats: new Map() };
const id = value => typeof value === "string" && value.length > 0 && value.length <= 256 &&
  /^[A-Za-z0-9]/.test(value) && !/[^A-Za-z0-9_.:-]/.test(value);
function reserve(binding, limits) {
  const owner = binding.ownerId, chat = JSON.stringify([owner, binding.chatId]);
  if (active.total >= limits.maxActive || (active.owners.get(owner) || 0) >= limits.maxPerOwner || (active.chats.get(chat) || 0) >= limits.maxPerChat) throw fail("overloaded", 429);
  active.total++; active.owners.set(owner, (active.owners.get(owner) || 0) + 1); active.chats.set(chat, (active.chats.get(chat) || 0) + 1);
  let released = false;
  return () => {
    if (released) return; released = true; active.total--;
    for (const [map, key] of [[active.owners, owner], [active.chats, chat]]) { const count = map.get(key) - 1; if (count) map.set(key, count); else map.delete(key); }
  };
}

function reservedCookie(name) {
  return /^(?:__Host-)?relay\.auth\./i.test(name) || /^(?:agent_web_session|relay_browser_identity|__Host-relay-preview)$/i.test(name) || /^relay_mcp_/i.test(name);
}
function filteredCookies(value) {
  if (!value) return undefined;
  const kept = [];
  for (const part of String(value).split(";")) {
    const index = part.indexOf("="), name = part.slice(0, index).trim(), cookie = part.slice(index + 1).trim();
    if (index < 1 || !TOKEN.test(name) || /[\x00-\x20\x7f;,]/.test(cookie)) throw fail("invalid-cookie", 400);
    if (!reservedCookie(name)) kept.push(name + "=" + cookie);
  }
  return kept.length ? kept.join("; ") : undefined;
}
function filteredSetCookie(value, hostname) {
  if (typeof value !== "string" || /[\r\n\x00]/.test(value)) return null;
  const parts = value.split(";").map(part => part.trim()), first = parts.shift(), index = first.indexOf("=");
  const name = first.slice(0, index);
  if (index < 1 || !TOKEN.test(name) || reservedCookie(name) || /[\x00-\x20\x7f;,]/.test(first.slice(index + 1))) return null;
  let domain = false, secure = false, path = null;
  const attributes = [];
  for (const part of parts) {
    const equal = part.indexOf("="), key = (equal < 0 ? part : part.slice(0, equal)).toLowerCase(), val = equal < 0 ? "" : part.slice(equal + 1).trim();
    if (!TOKEN.test(key)) return null;
    if (key === "domain") {
      if (domain || ![hostname, "localhost", "127.0.0.1"].includes(val.toLowerCase().replace(/^\./, ""))) return null;
      domain = true; continue; // Always emit host-only app cookies.
    }
    if (key === "secure") secure = true;
    if (key === "path") path = val;
    attributes.push(part);
  }
  if (name.startsWith("__Host-") && path !== "/") return null;
  if (!secure) attributes.push("Secure");
  return [first, ...attributes].join("; ");
}
function rawCount(message, name) {
  return (message.rawHeaders || []).filter((value, index) => index % 2 === 0 && value.toLowerCase() === name).length;
}
function cleanHeaders(headers) {
  const nominated = String(headers.connection || "").split(",").map(value => value.trim().toLowerCase()).filter(Boolean);
  if (nominated.some(value => !TOKEN.test(value))) throw fail("invalid-headers", 400);
  const result = Object.create(null);
  for (const [key, value] of Object.entries(headers)) {
    const name = key.toLowerCase();
    if (HOP.has(name) || nominated.includes(name) || name === "forwarded" || name === "x-real-ip" || name.startsWith("x-forwarded-") ||
        /^(?:x-)?(?:relay|agent-relay)[-_]/.test(name) || name === "clear-site-data" || name === "set-cookie2") continue;
    result[name] = value;
  }
  return result;
}
function location(value, binding) {
  if (typeof value !== "string" || /[\x00-\x20\x7f\\]/.test(value)) throw fail("invalid-redirect");
  if (value.startsWith("/") && !value.startsWith("//") || value.startsWith("?") || value.startsWith("#")) return value;
  let parsed;
  try { parsed = new URL(value, "https://" + binding.hostname); } catch { throw fail("invalid-redirect"); }
  if (parsed.username || parsed.password) throw fail("invalid-redirect");
  if (LOCAL.has(parsed.hostname)) {
    if (!["http:", "https:"].includes(parsed.protocol) || Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80)) !== binding.port) throw fail("invalid-redirect");
    return "https://" + binding.hostname + parsed.pathname + parsed.search + parsed.hash;
  }
  if (parsed.protocol !== "https:" || parsed.hostname === binding.hostname && parsed.port) throw fail("invalid-redirect");
  return value;
}
function responseHeaders(headers, binding) {
  const result = cleanHeaders(headers);
  const originalCookies = result["set-cookie"];
  delete result["set-cookie"];
  const cookies = (Array.isArray(originalCookies) ? originalCookies : originalCookies ? [originalCookies] : [])
    .map(value => filteredSetCookie(value, binding.hostname)).filter(Boolean);
  if (cookies.length) result["set-cookie"] = cookies;
  if (result.location !== undefined) result.location = location(result.location, binding);
  return result;
}
function admission(request, lease, upgrade, limits) {
  const binding = lease?.binding, signal = lease?.signal;
  if (!binding || !Object.isFrozen(binding) || !(signal instanceof AbortSignal) || signal.aborted ||
      !id(binding.ownerId) || !id(binding.chatId) || typeof binding.hostname !== "string" || binding.hostname.length > 253 ||
      /[^a-z0-9.-]/.test(binding.hostname) ||
      !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$/.test(binding.hostname) ||
      !Number.isInteger(binding.port) || binding.port < 1024 || binding.port > 65535) throw fail("invalid-lease", 403);
  if (rawCount(request, "host") !== 1 || request.headers.host !== binding.hostname ||
      rawCount(request, "origin") > 1 || request.headers.origin !== undefined && request.headers.origin !== "https://" + binding.hostname) throw fail("origin-denied", 403);
  if (typeof request.url !== "string" || request.url.length > 8192 || !request.url.startsWith("/") || request.url.startsWith("//") ||
      /[\x00-\x20\x7f\\#]/.test(request.url) || !["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"].includes(request.method)) throw fail("invalid-request", 400);
  if ((request.rawHeaders || []).join("").length > 16384 || rawCount(request, "authorization") > 1 ||
      rawCount(request, "content-length") > 1 || rawCount(request, "transfer-encoding") > 1 ||
      request.headers["content-length"] !== undefined && request.headers["transfer-encoding"] !== undefined ||
      request.headers.expect !== undefined) throw fail("invalid-headers", 400);
  const length = request.headers["content-length"];
  if (length !== undefined && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)))) throw fail("invalid-length", 400);
  if (Number(length || 0) > limits.requestBytes) throw fail("request-too-large", 413);
  const headers = cleanHeaders(request.headers);
  const originalCookie = headers.cookie;
  delete headers.cookie; delete headers["set-cookie"]; delete headers["sec-websocket-extensions"];
  // Application Basic/Bearer auth is not Relay authority and is preserved.
  // The product's recognizable capability bearer is never an app credential.
  if (/^Bearer[\t ]+cap_[A-Za-z0-9_-]{43}[\t ]*$/i.test(headers.authorization || "")) delete headers.authorization;
  const cookie = filteredCookies(originalCookie);
  if (cookie) headers.cookie = cookie;
  headers.host = binding.hostname;
  headers["x-forwarded-host"] = binding.hostname; headers["x-forwarded-proto"] = "https";
  if (upgrade) {
    if (request.method !== "GET" || length !== undefined && length !== "0" || request.headers["transfer-encoding"] !== undefined ||
        rawCount(request, "upgrade") !== 1 || request.headers.upgrade?.toLowerCase() !== "websocket" ||
        !String(request.headers.connection || "").toLowerCase().split(",").map(value => value.trim()).includes("upgrade") ||
        rawCount(request, "sec-websocket-key") !== 1 || !/^[A-Za-z0-9+/]{22}==$/.test(request.headers["sec-websocket-key"] || "") ||
        rawCount(request, "sec-websocket-version") !== 1 || request.headers["sec-websocket-version"] !== "13") throw fail("invalid-upgrade", 400);
    const protocols = String(request.headers["sec-websocket-protocol"] || "").split(",").map(value => value.trim()).filter(Boolean);
    if (protocols.some(value => !TOKEN.test(value)) || new Set(protocols).size !== protocols.length) throw fail("invalid-upgrade", 400);
    headers.connection = "Upgrade"; headers.upgrade = "websocket";
  } else {
    if (request.headers.upgrade !== undefined) throw fail("invalid-upgrade", 400);
    headers.connection = "close";
  }
  return { binding, signal, headers };
}
function limiter(max, code, initial = 0) {
  let count = initial;
  return new Transform({ transform(chunk, _encoding, callback) {
    count += chunk.length; callback(count > max ? fail(code, code === "request-too-large" ? 413 : 502) : null, count > max ? undefined : chunk);
  } });
}
function settings(input) {
  if (!input || typeof input !== "object" || Object.keys(input).some(key => !Object.hasOwn(DEFAULTS, key))) throw fail("invalid-limits", 400);
  const result = { ...DEFAULTS, ...input };
  for (const [key, value] of Object.entries(result)) if (!Number.isSafeInteger(value) || value < 1 || value > DEFAULTS[key]) throw fail("invalid-limits", 400);
  return result;
}

export function createWorkerPreviewProxy({ limits: supplied = {} } = {}) {
  const limits = settings(supplied);
  async function run(request, destination, context, upgrade, head = Buffer.alloc(0)) {
    let bridge, upstream, agent, headerTimer, deadline, input, output, connection, result, release;
    let settled = false, switched = false, resolveDone;
    const done = new Promise(resolve => { resolveDone = resolve; });
    const controller = new AbortController();
    const finish = error => {
      if (settled) return; settled = true;
      const code = error?.code || (error ? "upstream-failed" : "complete"), status = [400, 403, 413, 429, 502, 504].includes(error?.status) ? error.status : 502;
      result = { ok: !error, code };
      if (error && !destination.destroyed) {
        if (upgrade) {
          if (!switched) destination.end("HTTP/1.1 " + status + " Preview request failed\r\nConnection: close\r\nContent-Length: 0\r\nCache-Control: no-store\r\n\r\n",
            () => { if (!destination.destroyed) destination.destroySoon(); });
          else destination.destroy();
        } else if (!destination.headersSent) {
          const payload = '{"error":"Preview request failed"}';
          destination.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(payload), "cache-control": "no-store", connection: "close" });
          destination.end(payload);
        } else destination.destroy();
      }
      controller.abort();
      resolveDone();
    };
    const revoked = () => finish(fail("revoked", 403));
    const aborted = () => finish(fail("client-closed", 400));
    const closed = () => {
      if (upgrade) { if (switched && destination.writableFinished && destination.readableEnded) finish(); else aborted(); }
      else if (!destination.writableFinished) aborted();
    };
    try {
      if (!upgrade) closeIncompleteRequestAfterResponse(request, destination);
      const grant = admission(request, context?.lease, upgrade, limits);
      if (!Buffer.isBuffer(head) || head.length > 65536) throw fail("invalid-upgrade", 400);
      release = reserve(grant.binding, limits);
      grant.signal.addEventListener("abort", revoked, { once: true });
      request.once("aborted", aborted); request.once("error", aborted);
      destination.once("error", aborted); destination.once("close", closed);
      if (!upgrade) destination.once("finish", () => finish());
      deadline = setTimeout(() => finish(fail("lifetime-timeout", 504)), limits.maxLifetimeMs);
      connection = grant;
      bridge = openWorkerTcp(context.executor, { port: grant.binding.port, signal: AbortSignal.any([grant.signal, controller.signal]),
        connectTimeoutMs: limits.connectTimeoutMs, idleTimeoutMs: limits.idleTimeoutMs, maxLifetimeMs: limits.maxLifetimeMs });
      bridge.on("error", () => finish(fail("upstream-failed")));
      await bridge.ready;
      if (settled || grant.signal.aborted) throw fail("revoked", 403);
      agent = new Agent({ keepAlive: false, maxSockets: 1 });
      agent.createConnection = () => bridge;
      upstream = httpRequest({ hostname: grant.binding.hostname, port: grant.binding.port, method: request.method, path: request.url,
        headers: grant.headers, agent, maxHeaderSize: 16384, insecureHTTPParser: false,
        lookup: () => { throw fail("dns-forbidden"); } });
      upstream.on("error", () => finish(fail("upstream-failed")));
      upstream.on("connect", (_response, socket) => { socket.destroy(); finish(fail("invalid-upgrade")); });
      headerTimer = setTimeout(() => finish(fail("headers-timeout", 504)), limits.headersTimeoutMs);
      upstream.on("response", response => {
        clearTimeout(headerTimer);
        if (settled) { response.destroy(); return; }
        if (upgrade) { response.destroy(); finish(fail("upgrade-rejected")); return; }
        try {
          const headers = responseHeaders(response.headers, grant.binding);
          if (response.statusCode < 200 || response.statusCode > 599 || request.method !== "HEAD" && Number(headers["content-length"] || 0) > limits.responseBytes) throw fail("invalid-response");
          headers.connection = "close";
          destination.writeHead(response.statusCode, headers); destination.flushHeaders();
          output = limiter(limits.responseBytes, "response-too-large");
          response.on("error", () => finish(fail("upstream-failed"))); response.on("aborted", () => finish(fail("upstream-failed")));
          output.on("error", finish); response.pipe(output).pipe(destination);
        } catch { response.destroy(); finish(fail("invalid-response")); }
      });
      upstream.on("upgrade", (response, socket, upstreamHead) => {
        clearTimeout(headerTimer);
        if (settled) { socket.destroy(); return; }
        try {
          const expected = createHash("sha1").update(request.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
          const protocol = response.headers["sec-websocket-protocol"];
          if (!upgrade || response.statusCode !== 101 || response.headers.upgrade?.toLowerCase() !== "websocket" ||
              response.headers["sec-websocket-accept"] !== expected || response.headers["sec-websocket-extensions"] !== undefined ||
              response.headers["content-length"] !== undefined || response.headers["transfer-encoding"] !== undefined ||
              protocol !== undefined && !String(request.headers["sec-websocket-protocol"] || "").split(",").map(value => value.trim()).includes(protocol) ||
              upstreamHead.length > 65536 || upstreamHead.length > limits.websocketBytes || head.length > limits.websocketBytes) throw fail("invalid-upgrade");
          const headers = responseHeaders(response.headers, grant.binding);
          headers.connection = "Upgrade"; headers.upgrade = "websocket";
          let message = "HTTP/1.1 101 Switching Protocols\r\n";
          for (const [name, values] of Object.entries(headers)) for (const value of Array.isArray(values) ? values : [values]) message += name + ": " + value + "\r\n";
          destination.write(message + "\r\n"); switched = true;
          input = limiter(limits.websocketBytes, "websocket-too-large", head.length);
          output = limiter(limits.websocketBytes, "websocket-too-large", upstreamHead.length);
          input.on("error", finish); output.on("error", finish); socket.on("error", () => finish(fail("upstream-failed")));
          const flushed = () => { if (socket.closed && destination.writableFinished) finish(); };
          destination.once("finish", flushed);
          socket.once("close", () => {
            if (!socket.readableEnded) { finish(fail("upstream-failed")); return; }
            // Source EOF is not downstream completion: its last bytes can still
            // be buffered in the limiter or the slow client's writable queue.
            flushed();
          });
          if (head.length) socket.write(head);
          if (upstreamHead.length) destination.write(upstreamHead);
          destination.pipe(input).pipe(socket); socket.pipe(output).pipe(destination);
        } catch { socket.destroy(); finish(fail("invalid-upgrade")); }
      });
      if (upgrade) upstream.end();
      else {
        input = limiter(limits.requestBytes, "request-too-large");
        input.on("error", finish); request.pipe(input).pipe(upstream);
      }
      await done;
    } catch (error) { finish(error?.code && error.message === "Preview transport failed" ? error : fail("upstream-failed")); }
    finally {
      clearTimeout(headerTimer); clearTimeout(deadline);
      connection?.signal.removeEventListener("abort", revoked);
      request.removeListener("aborted", aborted); request.removeListener("error", aborted);
      destination.removeListener("error", aborted); destination.removeListener("close", closed);
      request.unpipe(input); input?.unpipe(); output?.unpipe();
      input?.destroy(); output?.destroy(); upstream?.destroy(); agent?.destroy(); controller.abort();
      if (bridge) {
        const ended = bridge.closed ? Promise.resolve() : new Promise(resolve => bridge.once("close", resolve));
        bridge.destroy(); await ended;
      }
    }
    const cleanupConfirmed = !bridge || bridge.cleanupConfirmed === true;
    // Unknown child death cannot create reusable capacity for more unknown
    // children. Retain this small reservation until operator recovery/restart.
    if (cleanupConfirmed) release?.();
    return Object.freeze({ ...(result || { ok: false, code: "upstream-failed" }),
      ...(result?.ok && !cleanupConfirmed ? { ok: false, code: "cleanup-unconfirmed" } : {}), cleanupConfirmed });
  }
  return Object.freeze({
    http: (request, response, context) => run(request, response, context, false),
    upgrade: (request, socket, head, context) => run(request, socket, context, true, head),
  });
}

const proxy = createWorkerPreviewProxy();
export const proxyWorkerHttp = proxy.http;
export const proxyWorkerUpgrade = proxy.upgrade;
