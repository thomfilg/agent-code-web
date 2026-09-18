import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { performance } from "node:perf_hooks";
import { closeIncompleteRequestAfterResponse } from "./http-request-lifecycle.mjs";

export const PREVIEW_COOKIE = "__Host-relay-preview";
export const PREVIEW_BOOTSTRAP_PATH = "/__relay_preview/";
const LAUNCH_PATH = "/app-preview/open", AUTHORIZE_PATH = "/api/app-preview/bootstrap";
const fields = ["ownerId", "sessionId", "chatId", "hostname", "port", "runtimeGeneration"];
const token = () => randomBytes(32).toString("base64url");
const hash = value => createHash("sha256").update(value).digest();
const validToken = value => typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
const same = (value, digest) => typeof value === "string" && value.length <= 128 && timingSafeEqual(hash(value), digest);
const nonceName = launch => `${PREVIEW_COOKIE}-browser-${launch}`;
const fail = () => { throw new PreviewBootstrapError(); };
const json = value => JSON.stringify(value).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
export class PreviewBootstrapError extends Error {
  constructor() { super("Preview access is unavailable. Open it again from Relay."); this.name = "PreviewBootstrapError"; }
}
function cookie(request, name) {
  if (typeof request.headers.cookie !== "string" || request.headers.cookie.length > 16384) fail();
  const matches = request.headers.cookie.split(";").map(part => part.trim()).filter(part => part.slice(0, part.indexOf("=")) === name);
  if (matches.length !== 1) fail();
  return matches[0].slice(name.length + 1);
}
function count(request, name) { return (request.rawHeaders || []).filter((value, index) => index % 2 === 0 && value.toLowerCase() === name).length; }
function exactRequest(request, hostname) {
  if (count(request, "host") !== 1 || request.headers.host !== hostname || count(request, "origin") > 1 ||
      typeof request.url !== "string" || !request.url.startsWith("/") || request.url.startsWith("//") || /[\\\x00-\x20\x7f]/.test(request.url)) fail();
}
export function previewAppPath(path, hostname) {
  if (typeof path !== "string" || path.length > 4096 || !path.startsWith("/") || path.startsWith("//") || /[\\\x00-\x20\x7f]/.test(path)) fail();
  let parsed;
  try { parsed = new URL(path, `https://${hostname}`); } catch { fail(); }
  if (parsed.origin !== `https://${hostname}` || parsed.pathname.startsWith(PREVIEW_BOOTSTRAP_PATH) || /%(?:0[0-9a-f]|1[0-9a-f]|7f|5c)/i.test(parsed.pathname)) fail();
  return parsed.pathname + parsed.search + parsed.hash;
}
function setCookie(name, value, seconds) { return `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=None; Max-Age=${seconds}`; }
function headers(response) {
  response.setHeader("Cache-Control", "no-store"); response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Content-Type-Options", "nosniff"); response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
}
function send(response, status, value) {
  if (response.destroyed || response.writableEnded) return;
  headers(response); response.statusCode = status;
  if (value === undefined) { response.end(); return; }
  response.setHeader("Content-Type", "application/json; charset=utf-8"); response.end(json(value));
}

/** Trusted-origin bootstrap only. This module registers no routes/listeners.
 * The caller supplies current controller-owned bindings and actual login users.
 * Preview CORS requests must originate in the Relay document, never an app page.
 */
export class PreviewBootstrap {
  #origin; #grants; #lookup; #isCurrent; #authenticate; #now; #flows = new Map(); #requests = new Set(); #closed = false;
  #limit; #ownerLimit; #ttl;
  constructor({ relayOrigin, grants, lookupHost, isCurrent, authenticate,
    now = () => performance.timeOrigin + performance.now(), ttlMs = 60000, maxFlows = 256, maxPerOwner = 16 } = {}) {
    let parsed; try { parsed = new URL(relayOrigin); } catch { fail(); }
    if (parsed.protocol !== "https:" || parsed.origin !== relayOrigin || !grants || typeof lookupHost !== "function" ||
        typeof isCurrent !== "function" || typeof authenticate !== "function" || typeof now !== "function" ||
        !Number.isInteger(ttlMs) || ttlMs < 1 || ttlMs > 60000 || !Number.isInteger(maxFlows) || maxFlows < 1 || maxFlows > 1024 ||
        !Number.isInteger(maxPerOwner) || maxPerOwner < 1 || maxPerOwner > maxFlows) fail();
    this.#origin = parsed; this.#grants = grants; this.#lookup = lookupHost; this.#isCurrent = isCurrent;
    this.#authenticate = authenticate; this.#now = now; this.#ttl = ttlMs; this.#limit = maxFlows; this.#ownerLimit = maxPerOwner;
  }
  #drop(flow, completed = false) {
    if (this.#flows.get(flow.key) !== flow) return;
    this.#flows.delete(flow.key); clearTimeout(flow.timer);
    for (const pending of [...this.#requests]) if (pending.flow === flow) pending.cancel();
    if (!completed && flow.grant) this.#grants.revokeGrant(flow.grant);
  }
  #current(binding) {
    try {
      const host = this.#lookup(binding.hostname);
      return !this.#closed && binding.hostname !== this.#origin.hostname && host && host.hostname === binding.hostname &&
        host.ownerId === binding.ownerId && host.chatId === binding.chatId && host.port === binding.port && this.#isCurrent(binding) === true;
    } catch { return false; }
  }
  #find(launch) {
    if (!validToken(launch) || this.#closed) fail();
    const flow = this.#flows.get(hash(launch).toString("hex"));
    if (!flow || flow.expiresAt <= this.#now() || !this.#current(flow.binding)) { if (flow) this.#drop(flow); fail(); }
    return flow;
  }
  #user(flow, user) {
    if (!user || user.id !== flow.binding.ownerId || user.sessionId !== flow.binding.sessionId ||
        !Number.isFinite(user.expiresAt) || user.expiresAt <= this.#now()) fail();
  }
  start({ binding, user, path = "/" } = {}) {
    if (this.#closed || !binding || Object.keys(binding).length !== fields.length || fields.some(field => !Object.hasOwn(binding, field))) fail();
    const saved = Object.freeze(Object.fromEntries(fields.map(field => [field, binding[field]])));
    if (!this.#current(saved)) fail();
    const destination = previewAppPath(path, saved.hostname);
    for (const flow of this.#flows.values()) if (flow.expiresAt <= this.#now()) this.#drop(flow);
    if (this.#flows.size >= this.#limit || [...this.#flows.values()].filter(flow => flow.binding.ownerId === saved.ownerId).length >= this.#ownerLimit) fail();
    const launch = token(), flow = { key: hash(launch).toString("hex"), binding: saved, path: destination,
      expiresAt: this.#now() + this.#ttl, stage: "new", attempts: 0 };
    this.#user(flow, user);
    // Reuse the grant primitive's strict plain-binding validation and capacity
    // admission. This ticket stays server-side until the authenticated Relay
    // document supplies its preview-cookie challenge; it is never in a URL.
    try { const issued = this.#grants.issueTicket(saved); flow.ticket = issued.ticket; flow.ticketHash = hash(issued.ticket); }
    catch { fail(); }
    this.#flows.set(flow.key, flow);
    flow.timer = setTimeout(() => this.#drop(flow), this.#ttl); flow.timer.unref();
    return Object.freeze({ url: `${this.#origin.origin}${LAUNCH_PATH}?launch=${launch}` });
  }
  async #body(request, flow) {
    if (this.#closed || this.#requests.size >= 32 || request.headers["content-type"] !== "application/json" ||
        Number(request.headers["content-length"] || 0) > 4096) fail();
    return new Promise((resolve, reject) => {
      let data = "", bytes = 0;
      const cleanup = () => { clearTimeout(timer); this.#requests.delete(pending); request.off("data", onData); request.off("end", onEnd); request.off("error", cancel); request.off("aborted", cancel); };
      const cancel = () => { cleanup(); reject(new PreviewBootstrapError()); };
      const onData = chunk => { bytes += chunk.length; if (bytes > 4096) { cancel(); request.pause(); } else data += chunk.toString("utf8"); };
      const onEnd = () => { cleanup(); try { const value = JSON.parse(data); if (!value || Array.isArray(value) || typeof value !== "object") fail(); resolve(value); } catch { reject(new PreviewBootstrapError()); } };
      const timer = setTimeout(cancel, 5000), pending = { flow, cancel }; timer.unref(); this.#requests.add(pending);
      request.on("data", onData); request.once("end", onEnd); request.once("error", cancel); request.once("aborted", cancel);
    });
  }
  #cors(request, response) {
    if (request.headers.origin !== this.#origin.origin || count(request, "origin") !== 1) fail();
    response.setHeader("Access-Control-Allow-Origin", this.#origin.origin);
    response.setHeader("Access-Control-Allow-Credentials", "true"); response.setHeader("Vary", "Origin");
    if (request.method === "OPTIONS") {
      if (request.headers["access-control-request-method"] !== "POST" ||
          String(request.headers["access-control-request-headers"] || "").toLowerCase().split(",").map(value => value.trim()).sort().join(",") !== "content-type,x-relay-preview-launch") fail();
      response.setHeader("Access-Control-Allow-Methods", "POST"); response.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Relay-Preview-Launch");
      send(response, 204); return true;
    }
    if (request.method !== "POST") fail();
    return false;
  }
  async handleRelay(request, response, url) {
    if (![LAUNCH_PATH, AUTHORIZE_PATH].includes(url.pathname)) return false;
    closeIncompleteRequestAfterResponse(request, response);
    try {
      exactRequest(request, this.#origin.host);
      if (url.pathname === LAUNCH_PATH) {
        if (request.method !== "GET" || url.searchParams.size !== 1 || !url.searchParams.has("launch")) fail();
        const launch = url.searchParams.get("launch"), flow = this.#find(launch);
        const user = await this.#authenticate(request); this.#user(this.#find(launch), user);
        this.#page(response, flow, launch); return true;
      }
      if (request.method !== "POST" || url.search || request.headers.origin !== this.#origin.origin || count(request, "origin") !== 1) fail();
      if (count(request, "x-relay-preview-launch") !== 1) fail();
      const launch = request.headers["x-relay-preview-launch"], flow = this.#find(launch);
      const user = await this.#authenticate(request); this.#user(this.#find(launch), user);
      const body = await this.#body(request, flow);
      if (Object.keys(body).sort().join(",") !== "challenge,launch") fail();
      if (body.launch !== launch || this.#find(launch) !== flow) fail(); this.#user(flow, user);
      if (flow.stage !== "challenged" || !validToken(body.challenge) || !same(body.challenge, flow.challenge)) fail();
      flow.stage = "authorized";
      send(response, 200, { ticket: flow.ticket }); return true;
    } catch { send(response, 403, { error: new PreviewBootstrapError().message }); return true; }
  }
  async handlePreview(request, response, url) {
    if (!url.pathname.startsWith(PREVIEW_BOOTSTRAP_PATH)) return false;
    closeIncompleteRequestAfterResponse(request, response);
    try {
      const hostname = request.headers.host; exactRequest(request, hostname);
      const assigned = this.#lookup(hostname);
      if (!assigned || assigned.hostname !== hostname || hostname === this.#origin.hostname || url.search ||
          !["challenge", "exchange", "probe"].some(action => url.pathname === PREVIEW_BOOTSTRAP_PATH + action)) fail();
      if (this.#cors(request, response)) return true;
      if (count(request, "x-relay-preview-launch") !== 1) fail();
      const launch = request.headers["x-relay-preview-launch"], flow = this.#find(launch);
      if (flow.binding.hostname !== hostname) fail();
      const body = await this.#body(request, flow);
      if (body.launch !== launch || this.#find(launch) !== flow) fail();
      if (url.pathname.endsWith("/challenge")) {
        if (Object.keys(body).join(",") !== "launch" || !["new", "challenged"].includes(flow.stage) || ++flow.attempts > 4) fail();
        const nonce = token(), challenge = token(); flow.nonce = hash(nonce); flow.challenge = hash(challenge); flow.stage = "challenged";
        response.setHeader("Set-Cookie", setCookie(nonceName(body.launch), nonce, Math.max(1, Math.ceil((flow.expiresAt - this.#now()) / 1000))));
        send(response, 200, { challenge }); return true;
      }
      if (url.pathname.endsWith("/exchange")) {
        if (Object.keys(body).sort().join(",") !== "launch,ticket" || flow.stage !== "authorized" || !same(body.ticket, flow.ticketHash) ||
            !same(cookie(request, nonceName(body.launch)), flow.nonce)) fail();
        const issued = this.#grants.exchangeTicket(body.ticket, hostname); flow.grant = issued.grant; flow.stage = "exchanged";
        response.setHeader("Set-Cookie", [setCookie(PREVIEW_COOKIE, issued.grant, Math.max(1, Math.floor((issued.expiresAt - this.#now()) / 1000))), setCookie(nonceName(body.launch), "", 0)]);
        send(response, 200, { ok: true }); return true;
      }
      if (Object.keys(body).join(",") !== "launch" || flow.stage !== "exchanged" || !same(cookie(request, PREVIEW_COOKIE), hash(flow.grant))) fail();
      const lease = this.authorize(request, hostname);
      if (fields.some(field => lease.binding[field] !== flow.binding[field])) fail();
      this.#drop(flow, true); send(response, 200, { ok: true }); return true;
    } catch { send(response, 403, { error: new PreviewBootstrapError().message }); return true; }
  }
  authorize(request, hostname) {
    exactRequest(request, hostname);
    const lease = this.#grants.authorize(cookie(request, PREVIEW_COOKIE), hostname);
    if (!this.#current(lease.binding)) { this.#grants.revokeGrant(cookie(request, PREVIEW_COOKIE)); fail(); }
    return lease;
  }
  #page(response, flow, launch) {
    const nonce = token(), config = json({ launch, preview: `https://${flow.binding.hostname}`, destination: `https://${flow.binding.hostname}${flow.path}` });
    headers(response); response.statusCode = 200; response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.setHeader("Content-Security-Policy", `default-src 'none'; script-src 'nonce-${nonce}'; connect-src 'self' https://${flow.binding.hostname}; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`);
    response.end(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Opening app · Relay</title><h1>Opening your app…</h1><p id="status">Checking private browser access. Access expires after five minutes; reopen from Relay when needed.</p><script nonce="${nonce}">
const config=${config};
async function post(url,body){const response=await fetch(url,{method:'POST',credentials:'include',cache:'no-store',redirect:'error',headers:{'Content-Type':'application/json','X-Relay-Preview-Launch':config.launch},body:JSON.stringify(body)});if(!response.ok)throw new Error('denied');return response.json();}
(async()=>{try{const c=await post(config.preview+'${PREVIEW_BOOTSTRAP_PATH}challenge',{launch:config.launch});const a=await post('${AUTHORIZE_PATH}',{launch:config.launch,challenge:c.challenge});await post(config.preview+'${PREVIEW_BOOTSTRAP_PATH}exchange',{launch:config.launch,ticket:a.ticket});await post(config.preview+'${PREVIEW_BOOTSTRAP_PATH}probe',{launch:config.launch});location.replace(config.destination);}catch{document.querySelector('h1').textContent='App access could not be opened';document.querySelector('#status').textContent='Your browser may be blocking cross-site cookies, or this launch expired. Allow cross-site cookies for Relay and this preview, then reopen from Relay. No less-secure fallback is used.';}})();
</script></html>`);
  }
  #revoke(predicate) { for (const flow of [...this.#flows.values()]) if (predicate(flow.binding)) this.#drop(flow); }
  revokeOwner(ownerId) { this.#revoke(binding => binding.ownerId === ownerId); this.#grants.revokeOwner(ownerId); }
  revokeSession(ownerId, sessionId) { this.#revoke(binding => binding.ownerId === ownerId && binding.sessionId === sessionId); this.#grants.revokeSession(ownerId, sessionId); }
  revokeChat(ownerId, chatId) { this.#revoke(binding => binding.ownerId === ownerId && binding.chatId === chatId); this.#grants.revokeChat(ownerId, chatId); }
  revokeHostname(hostname) { this.#revoke(binding => binding.hostname === hostname); this.#grants.revokeHostname(hostname); }
  close() { this.#closed = true; for (const pending of [...this.#requests]) pending.cancel(); for (const flow of [...this.#flows.values()]) this.#drop(flow); this.#grants.close(); }
}
