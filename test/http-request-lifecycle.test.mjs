import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { EventEmitter } from "node:events";
import { createAgentWebServer } from "../src/server.mjs";
import { closeIncompleteRequestAfterResponse } from "../src/http-request-lifecycle.mjs";
import { temporaryDirectory, testConfig, waitFor } from "./helpers.mjs";

const token = "synthetic-http-lifecycle-only";
async function appFixture(t) {
  const root = await temporaryDirectory(t), app = await createAgentWebServer({ config: testConfig(root, { AGENT_WEB_AUTH_TOKEN: token }) });
  const { url } = await app.start(), requests = new Set(), agents = new Set();
  t.after(async () => { for (const req of requests) req.destroy(); for (const agent of agents) agent.destroy(); await app.stop(); });
  return { app, url, requests, agents };
}
function outgoing(f, path, { method = "GET", headers = {}, body, incomplete = false, agent, pauseMs = 0 } = {}) {
  agent ||= new http.Agent({ keepAlive: true, maxSockets: 1 }); f.agents.add(agent);
  const state = { socket: null, socketClosed: false, status: null, text: null, response: null };
  const requestHeaders = Object.fromEntries(Object.entries({ ...(incomplete ? { "Content-Length": "1000" } : {}), ...headers }).filter(([, value]) => value !== undefined));
  const req = http.request(f.url + path, { method, agent, headers: requestHeaders });
  f.requests.add(req); req.once("close", () => f.requests.delete(req));
  req.once("socket", socket => { state.socket = socket; socket.once("close", () => { state.socketClosed = true; }); });
  const result = new Promise((resolve, reject) => {
    req.once("error", reject);
    req.once("response", res => {
      state.response = res; state.status = res.statusCode;
      const chunks = []; res.on("data", chunk => chunks.push(chunk)); res.once("error", reject);
      res.once("end", () => { state.text = Buffer.concat(chunks).toString(); resolve(state); });
      if (pauseMs) { res.pause(); setTimeout(() => res.resume(), pauseMs); }
    });
  });
  // Prevent an intentional test cleanup from surfacing as an unhandled failure.
  void result.catch(() => {});
  if (incomplete) req.write(body || "{"); else req.end(body);
  return { req, state, result, agent };
}

test("generic early denial, static, readiness and operator responses flush then close only their unfinished input", async t => {
  const f = await appFixture(t);
  const cases = [
    ["/api/chats", "POST", {}, 401, /authentication required/],
    ["/api/chats", "POST", { Authorization: `Bearer ${token}`, Origin: "https://foreign.example" }, 403, /cross-origin/],
    ["/", "GET", {}, 200, /Agent Relay/], ["/styles.css", "HEAD", {}, 200, /^$/],
    ["/no-such-file", "GET", {}, 404, /not found/], ["/readyz", "GET", {}, 200, /"ok":true/],
    ["/internal/deploy/resume", "POST", {}, 200, /"ok":true/],
    ["/internal/deploy/missing", "POST", {}, 404, /Not found/],
    ["/internal/deploy/drain", "POST", { Origin: "https://foreign.example" }, 404, /Not found/],
    ["/api/chats", "POST", { Host: "[" }, 400, /Invalid request URL/],
  ];
  for (const [path, method, headers, status, content] of cases) {
    const pending = outgoing(f, path, { method, headers, incomplete: true }), result = await pending.result;
    assert.equal(result.status, status, path); assert.match(result.text, content, path);
    assert.equal(result.response.complete, true, "the full response arrived before connection close");
    if (method !== "HEAD" && result.response.headers["content-length"]) assert.equal(Buffer.byteLength(result.text), Number(result.response.headers["content-length"]));
    await waitFor(() => pending.state.socketClosed);
  }
  const drain = outgoing(f, "/internal/deploy/drain", { method: "POST", incomplete: true });
  assert.equal((await drain.result).status, 200); await waitFor(() => drain.state.socketClosed);
  let stopped = false; const stopping = f.app.stop().then(() => { stopped = true; });
  await waitFor(() => stopped); await stopping;
});

test("chunked incomplete input is closed after a complete fixed denial", async t => {
  const f = await appFixture(t);
  const pending = outgoing(f, "/api/chats", { method: "POST", incomplete: true,
    headers: { "Content-Length": undefined, "Transfer-Encoding": "chunked" } });
  assert.equal((await pending.result).status, 401); assert.equal(pending.state.response.complete, true);
  await waitFor(() => pending.state.socketClosed);
});

test("complete authenticated POST and subsequent requests preserve the same keepalive socket", async t => {
  const f = await appFixture(t), agent = new http.Agent({ keepAlive: true, maxSockets: 1 }); f.agents.add(agent);
  const immediate = outgoing(f, "/internal/deploy/resume", { method: "POST", agent });
  assert.equal((await immediate.result).status, 200);
  const body = JSON.stringify({ agent: "mock", title: "Complete keepalive save" });
  const first = outgoing(f, "/api/chats", { method: "POST", agent, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }, body });
  const saved = await first.result; assert.equal(saved.status, 201); assert.equal(first.state.socket, immediate.state.socket);
  for (const path of ["/readyz", "/", "/api/chats"]) {
    const next = outgoing(f, path, { agent, headers: { Authorization: `Bearer ${token}` } });
    assert.equal((await next.result).status, 200); assert.equal(next.state.socket, first.state.socket); assert.equal(next.state.socketClosed, false);
  }
  assert.equal(f.app.store.get(JSON.parse(saved.text).chat.id).title, "Complete keepalive save");
});

test("slow authenticated bodies and gated durable saves remain open and keep drain busy", async t => {
  const f = await appFixture(t), original = f.app.manager.createChat.bind(f.app.manager);
  let entered = false, release; const gate = new Promise(resolve => { release = resolve; });
  f.app.manager.createChat = async (...args) => { entered = true; await gate; return original(...args); };
  const body = JSON.stringify({ agent: "mock", title: "Slow input and save" });
  const pending = outgoing(f, "/api/chats", { method: "POST", incomplete: true, body: body.slice(0, 2),
    headers: { Authorization: `Bearer ${token}`, "Content-Length": Buffer.byteLength(body), "Content-Type": "application/json" } });
  try {
    await waitFor(() => pending.state.socket !== null);
    assert.equal((await outgoing(f, "/internal/deploy/drain", { method: "POST" }).result).status, 409);
    assert.equal(entered, false); assert.equal(pending.state.socketClosed, false); assert.equal(pending.state.status, null);
    pending.req.end(body.slice(2)); await waitFor(() => entered);
    const denied = outgoing(f, "/api/chats", { method: "POST", incomplete: true });
    assert.equal((await denied.result).status, 401); await waitFor(() => denied.state.socketClosed);
    assert.equal((await outgoing(f, "/internal/deploy/drain", { method: "POST" }).result).status, 409);
    assert.equal(pending.state.socketClosed, false); assert.equal(pending.state.status, null);
    release(); const response = await pending.result; assert.equal(response.status, 201);
    assert.equal(f.app.store.get(JSON.parse(response.text).chat.id).title, "Slow input and save");
  } finally { release(); pending.req.destroy(); }
});

test("authenticated SSE remains live until normal Relay shutdown", async t => {
  const f = await appFixture(t), headers = { Authorization: `Bearer ${token}` };
  const stream = outgoing(f, "/api/sidebar/events", { headers });
  await waitFor(() => stream.state.response !== null);
  let text = ""; stream.state.response.on("data", chunk => { text += chunk; });
  const created = await outgoing(f, "/api/chats", { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ agent: "mock", title: "SSE lifecycle" }) }).result;
  assert.equal(created.status, 201); await waitFor(() => text.includes("sidebar_changed"));
  assert.equal(stream.state.socketClosed, false); assert.equal(stream.state.response.complete, false);
  await f.app.stop(); const result = await stream.result;
  assert.equal(result.response.complete, true); await waitFor(() => stream.state.socketClosed);
});

test("large early response survives a paused consumer before its unfinished request socket closes", async t => {
  const payload = Buffer.from("x".repeat(4 * 1024 * 1024) + "END-OF-FIXTURE");
  const server = http.createServer((request, response) => {
    closeIncompleteRequestAfterResponse(request, response);
    response.writeHead(401, { "Content-Length": payload.length }); response.end(payload);
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const f = { url: `http://127.0.0.1:${server.address().port}`, requests: new Set(), agents: new Set() };
  t.after(async () => { for (const request of f.requests) request.destroy(); for (const agent of f.agents) agent.destroy(); await new Promise(resolve => server.close(resolve)); });
  const pending = outgoing(f, "/", { method: "POST", incomplete: true, pauseMs: 50 });
  const result = await pending.result;
  assert.equal(result.status, 401); assert.equal(result.response.complete, true); assert.equal(result.text, payload.toString());
  await waitFor(() => pending.state.socketClosed);
});

test("helper installs no method patches, removes listeners and waits for actual completion", () => {
  const response = new EventEmitter(), request = { complete: false, socket: { destroyed: false, destroySoon() { this.closes = (this.closes || 0) + 1; } } };
  const writeHead = () => {}; response.writeHead = writeHead;
  closeIncompleteRequestAfterResponse(request, response);
  assert.equal(response.writeHead, writeHead); assert.equal(request.socket.closes, undefined);
  response.emit("finish"); assert.equal(request.socket.closes, 1); assert.equal(response.listenerCount("finish"), 0); assert.equal(response.listenerCount("close"), 0);
  response.emit("finish"); assert.equal(request.socket.closes, 1);
  const closed = new EventEmitter(); closeIncompleteRequestAfterResponse(request, closed); closed.emit("close"); closed.emit("finish");
  assert.equal(request.socket.closes, 1); assert.equal(closed.listenerCount("finish"), 0);
});
