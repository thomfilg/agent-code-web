import assert from "node:assert/strict";
import test from "node:test";
import { createServer, request } from "node:http";
import { createConnection } from "node:net";
import { spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { PassThrough } from "node:stream";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import WebSocket, { WebSocketServer } from "ws";
import { createWorkerPreviewProxy } from "../src/worker-preview-proxy.mjs";
import { SSH_WORKER_LAUNCHER, sshWorkerRequest } from "../src/ssh-worker-launcher.mjs";
import { temporaryDirectory, waitFor } from "./helpers.mjs";

async function listen(t, server) {
  const sockets = new Set();
  server.on("connection", socket => { sockets.add(socket); socket.on("error", () => {}); socket.on("close", () => sockets.delete(socket)); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); });
  return server.address().port;
}
async function fixture(t, { handler = (_request, response) => response.end("ok"), limits, launcher = false, hostname = "one.preview.example", ownerId = "owner1", chatId = "chat1", context } = {}) {
  const root = await temporaryDirectory(t), upstream = createServer(handler), upstreamPort = await listen(t, upstream);
  const heartbeat = path.join(root, ".heartbeat"); if (launcher) await writeFile(heartbeat, "");
  const abort = new AbortController(), children = [], calls = [], receipts = [], tasks = new Set();
  const executor = { workspace: root, spawn(command, args, options) {
    assert.equal(command, "/usr/bin/node"); assert.deepEqual(options.env, {});
    calls.push({ command, args, options });
    const child = spawn(process.execPath, launcher ? ["--input-type=module", "-e", SSH_WORKER_LAUNCHER] : args, { ...options, env: {} });
    if (launcher) child.stdin.write(sshWorkerRequest({ command: process.execPath, args, env: {}, cwd: root, heartbeat }));
    children.push(child); return child;
  } };
  const lease = Object.freeze({ binding: Object.freeze({ hostname, port: upstreamPort, ownerId, chatId }), signal: abort.signal });
  const proxy = createWorkerPreviewProxy({ limits });
  const options = context ? context({ executor, lease }) : { executor, lease };
  const track = promise => { tasks.add(promise); promise.then(receipt => receipts.push(receipt)).finally(() => tasks.delete(promise)); };
  const front = createServer((req, res) => track(proxy.http(req, res, options)));
  front.on("upgrade", (req, socket, head) => track(proxy.upgrade(req, socket, head, options)));
  const port = await listen(t, front);
  t.after(async () => { abort.abort(); await Promise.all(tasks); for (const child of children) assert.ok(child.exitCode !== null || child.signalCode, "fixture child was reaped"); });
  return { port, front, upstream, upstreamPort, executor, lease, abort, receipts, children, calls, hostname, tasks };
}
async function send(f, { method = "GET", path = "/original?q=one%20two", headers = {}, body, onData } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port: f.port, method, path, headers: { host: f.hostname, ...headers } }, res => {
      const chunks = []; res.on("data", chunk => { chunks.push(chunk); onData?.(chunk); });
      res.on("error", reject); res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject); req.end(body);
  });
}

test("HTTP preserves binary upload/raw path and app auth while removing all Relay authority and spoofed forwarding", async t => {
  let observed;
  const f = await fixture(t, { launcher: true, handler: async (req, res) => {
    const parts = []; for await (const bytes of req) parts.push(bytes);
    observed = { headers: req.headers, path: req.url, body: Buffer.concat(parts) };
    res.setHeader("content-type", "application/octet-stream"); res.end(observed.body);
  } });
  const body = Buffer.from([0, 255, 13, 10, 90]), result = await send(f, { method: "POST", path: "/raw%2fpath?x=%26one", body, headers: {
    authorization: "Basic APP-AUTH", "proxy-authorization": "PRIVATE-PROXY", "x-relay-capability": "PRIVATE-CAP",
    forwarded: "host=evil", "x-forwarded-host": "evil", "x-forwarded-proto": "http", "x-forwarded-for": "private",
    "x-real-ip": "private", connection: "close, x-private-hop", "x-private-hop": "private",
    origin: "https://" + f.hostname,
    cookie: "app=kept; agent_web_session=PRIVATE; relay_browser_identity=PRIVATE; relay_mcp_token=PRIVATE; relay.auth.state=PRIVATE; __Host-relay.auth.sessionToken.0=PRIVATE; __Host-relay-preview=PRIVATE",
  } });
  assert.equal(result.status, 200); assert.deepEqual(result.body, body); assert.equal(observed.path, "/raw%2fpath?x=%26one");
  assert.equal(observed.headers.authorization, "Basic APP-AUTH"); assert.equal(observed.headers.cookie, "app=kept");
  assert.equal(observed.headers.host, f.hostname); assert.equal(observed.headers.origin, "https://" + f.hostname);
  assert.equal(observed.headers["x-forwarded-host"], f.hostname); assert.equal(observed.headers["x-forwarded-proto"], "https");
  for (const key of ["forwarded", "x-forwarded-for", "x-real-ip", "proxy-authorization", "x-relay-capability", "x-private-hop"]) assert.equal(observed.headers[key], undefined);
  assert.doesNotMatch(JSON.stringify(observed.headers), /PRIVATE/);
  await waitFor(() => f.receipts.length === 1, { timeoutMs: 6000 }); assert.deepEqual(f.receipts[0], { ok: true, code: "complete", cleanupConfirmed: true });
});

test("SSE is flushed incrementally, not buffered until response completion", async t => {
  let finished = false, firstBeforeEnd = false;
  const f = await fixture(t, { handler: (_req, res) => {
    res.setHeader("content-type", "text/event-stream"); res.write("data: first\n\n");
    setTimeout(() => { finished = true; res.end("data: second\n\n"); }, 60);
  } });
  const result = await send(f, { onData: chunk => { if (chunk.includes("first")) firstBeforeEnd = !finished; } });
  assert.equal(firstBeforeEnd, true); assert.equal(result.body.toString(), "data: first\n\ndata: second\n\n");
});

test("Relay capability auth whitespace variants are stripped while app Bearer remains", async t => {
  const values = [];
  const f = await fixture(t, { handler: (req, res) => { values.push(req.headers.authorization); res.end(); } });
  for (const separator of [" ", "  ", "\t", " \t"]) await send(f, { headers: { authorization: "Bearer" + separator + "cap_" + "A".repeat(43) } });
  await send(f, { headers: { authorization: "Bearer application-token" } });
  assert.deepEqual(values, [undefined, undefined, undefined, undefined, "Bearer application-token"]);
});

test("Set-Cookie reserves platform names, removes only exact/localhost Domain, and does not forward hop-nominated cookies", async t => {
  const f = await fixture(t, { handler: (req, res) => {
    res.setHeader("set-cookie", req.url === "/hop" ? ["app=no; Path=/"] : [
      "app=one; Domain=one.preview.example; Path=/; HttpOnly",
      "local=two; Domain=localhost; Path=/", "foreign=no; Domain=preview.example; Path=/",
      "other=no; Domain=other.preview.example; Path=/", "__Host-relay-preview=PRIVATE; Secure; Path=/",
      "agent_web_session=PRIVATE; Path=/", "relay_browser_identity=PRIVATE; Path=/", "relay_mcp_test=PRIVATE; Path=/",
      "relay.auth.state=PRIVATE; Path=/", "__Host-relay.auth.sessionToken.1=PRIVATE; Path=/",
      "duplicate=no; Domain=localhost; Domain=one.preview.example", "__Host-app=three; Path=/",
    ]);
    if (req.url === "/hop") res.setHeader("connection", "close, set-cookie");
    res.setHeader("clear-site-data", '"cookies"'); res.end("ok");
  } });
  const result = await send(f);
  assert.deepEqual(result.headers["set-cookie"], ["app=one; Path=/; HttpOnly; Secure", "local=two; Path=/; Secure", "__Host-app=three; Path=/; Secure"]);
  assert.equal(result.headers["clear-site-data"], undefined);
  assert.equal((await send(f, { path: "/hop" })).headers["set-cookie"], undefined);
});

test("redirect rewriting is exact-port only and preserves relative/external HTTPS navigation", async t => {
  const f = await fixture(t, { handler: (req, res) => {
    const urls = { "/local": "http://localhost:" + f.upstreamPort + "/same?q=1#x", "/relative": "/same?q=1",
      "/external": "https://login.example/oauth", "/wrong": "http://localhost:1024/private", "/credentials": "https://private:secret@login.example" };
    res.writeHead(302, { location: urls[req.url] }); res.end();
  } });
  assert.equal((await send(f, { path: "/local" })).headers.location, "https://" + f.hostname + "/same?q=1#x");
  assert.equal((await send(f, { path: "/relative" })).headers.location, "/same?q=1");
  assert.equal((await send(f, { path: "/external" })).headers.location, "https://login.example/oauth");
  for (const path of ["/wrong", "/credentials"]) assert.equal((await send(f, { path })).status, 502);
});

test("wrong host/origin, absolute paths, reserved methods and invalid leases cannot spawn", async t => {
  const f = await fixture(t);
  for (const options of [{ headers: { host: "two.preview.example" } }, { headers: { origin: "https://evil.example" } },
    { path: "http://localhost:8787/api" }, { path: "//other/path" }, { method: "TRACE" }, { headers: { expect: "100-continue" } }]) {
    assert.ok([400, 403].includes((await send(f, options)).status));
  }
  assert.equal(f.calls.length, 0);
  const other = await fixture(t, { context: ({ executor, lease }) => ({ executor, lease: { ...lease, binding: { ...lease.binding } } }) });
  assert.equal((await send(other)).status, 403); assert.equal(other.calls.length, 0);
});

test("denied incomplete bodies/upgrades flush then close their exact server socket despite client half-open", { timeout: 8000 }, async t => {
  async function raw(f, wire, status, body) {
    const accepted = once(f.front, "connection");
    const socket = createConnection({ host: "127.0.0.1", port: f.port, allowHalfOpen: true });
    t.after(() => socket.destroy());
    let response = ""; socket.on("data", data => response += data); socket.on("error", () => {});
    const ended = once(socket, "end"), [serverSocket] = await accepted, closed = once(serverSocket, "close");
    socket.write(wire); await Promise.all([ended, closed]);
    assert.equal(serverSocket.destroyed, true); assert.equal(socket.writableEnded, false, "client never supplied EOF");
    assert.match(response, new RegExp("HTTP/1.1 " + status)); assert.match(response, /Connection: close/i);
    if (body) assert.ok(response.endsWith('{"error":"Preview request failed"}'), "complete response flushed before close");
  }
  const f = await fixture(t);
  await raw(f, "POST / HTTP/1.1\r\nHost: wrong.preview.example\r\nContent-Length: 1000\r\n\r\n{", 403, true);
  await raw(f, "GET / HTTP/1.1\r\nHost: wrong.preview.example\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: AAAAAAAAAAAAAAAAAAAAAA==\r\n\r\n", 403, false);
  assert.equal(f.calls.length, 0);
  const small = await fixture(t, { limits: { requestBytes: 8 } });
  await raw(small, "POST / HTTP/1.1\r\nHost: " + small.hostname + "\r\nContent-Length: 1000\r\n\r\n{", 413, true);
  assert.equal(small.calls.length, 0);
  const busy = await fixture(t, { limits: { maxPerChat: 1 }, handler: (_req, res) => { res.writeHead(200); res.write("held"); } });
  const started = Promise.withResolvers();
  const ongoing = send(busy, { onData: () => started.resolve() }).catch(() => {});
  await started.promise;
  await raw(busy, "POST / HTTP/1.1\r\nHost: " + busy.hostname + "\r\nContent-Length: 1000\r\n\r\n{", 429, true);
  assert.equal(busy.calls.length, 1); busy.abort.abort(); await ongoing;
});

test("scope identity separators and control characters fail before worker admission", async t => {
  for (const values of [{ ownerId: "owner\n" }, { ownerId: "owner\u2028" }, { chatId: "chat\n" }, { chatId: "chat\u2029" }]) {
    const f = await fixture(t, values);
    assert.equal((await send(f)).status, 403); assert.equal(f.calls.length, 0);
  }
});

test("declared and streamed body limits and header deadlines fail safely", async t => {
  const f = await fixture(t, { limits: { requestBytes: 8 }, handler: (req, res) => { req.on("error", () => {}); req.on("end", () => res.end("ok")); req.resume(); } });
  assert.equal((await send(f, { method: "POST", headers: { "content-length": "9" }, body: "123456789" })).status, 413);
  assert.equal(f.calls.length, 0);
  assert.equal((await send(f, { method: "POST", headers: { "transfer-encoding": "chunked" }, body: "123456789" })).status, 413);
  const huge = await fixture(t, { limits: { responseBytes: 8 }, handler: (_req, res) => res.end("123456789") });
  assert.equal((await send(huge)).status, 502);
  const stalled = await fixture(t, { limits: { headersTimeoutMs: 25 }, handler: () => {} });
  assert.equal((await send(stalled)).status, 504);
});

test("lease revocation closes a live SSE stream but not another lease's connection", async t => {
  const handler = (_req, res) => { res.setHeader("content-type", "text/event-stream"); res.write("data: open\n\n"); };
  const first = await fixture(t, { handler }), other = await fixture(t, { hostname: "two.preview.example" });
  const opened = Promise.withResolvers();
  const result = send(first, { onData: () => opened.resolve() }).catch(error => error);
  await opened.promise; first.abort.abort();
  await result; await waitFor(() => first.receipts.length === 1);
  assert.equal(first.receipts[0].ok, false); assert.equal(first.receipts[0].code, "revoked"); assert.equal(first.receipts[0].cleanupConfirmed, true);
  assert.equal((await send(other)).body.toString(), "ok");
});

test("WebSocket binary/subprotocol traffic and immediate server frames survive sanitized upgrade", async t => {
  const f = await fixture(t, { launcher: true }), wss = new WebSocketServer({ server: f.upstream, perMessageDeflate: true });
  let headers;
  wss.on("connection", (client, req) => { headers = req.headers; client.send(Buffer.from([7, 0, 255])); client.on("message", (value, binary) => client.send(value, { binary })); });
  t.after(() => { for (const client of wss.clients) client.terminate(); wss.close(); });
  const ws = new WebSocket("ws://127.0.0.1:" + f.port + "/ws?q=1", ["echo"], { headers: { host: f.hostname, origin: "https://" + f.hostname,
    cookie: "__Host-relay-preview=PRIVATE; app=kept", authorization: "Bearer APP", "x-forwarded-host": "evil" }, perMessageDeflate: true });
  t.after(() => ws.terminate()); const initial = once(ws, "message"); await once(ws, "open");
  assert.deepEqual((await initial)[0], Buffer.from([7, 0, 255]));
  assert.equal(ws.protocol, "echo"); assert.equal(ws.extensions, ""); assert.equal(headers.cookie, "app=kept");
  assert.equal(headers.authorization, "Bearer APP"); assert.equal(headers.host, f.hostname);
  const response = once(ws, "message"), value = Buffer.from([255, 0, 13, 10]); ws.send(value);
  assert.deepEqual((await response)[0], value); const closed = once(ws, "close"); ws.close(); await closed;
});

test("WebSocket rejects bad upstream handshake and lease revocation terminates active frames", async t => {
  const bad = await fixture(t);
  bad.upstream.on("upgrade", (_req, socket) => socket.end("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: PRIVATE-BAD\r\n\r\n"));
  const socket = createConnection({ host: "127.0.0.1", port: bad.port }); let text = ""; socket.on("data", data => text += data);
  const closed = once(socket, "close"); socket.write("GET / HTTP/1.1\r\nHost: " + bad.hostname + "\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: AAAAAAAAAAAAAAAAAAAAAA==\r\n\r\n");
  await closed; assert.match(text, /502/); assert.doesNotMatch(text, /PRIVATE/);
  const f = await fixture(t), wss = new WebSocketServer({ server: f.upstream });
  t.after(() => { for (const client of wss.clients) client.terminate(); wss.close(); });
  const ws = new WebSocket("ws://127.0.0.1:" + f.port, { headers: { host: f.hostname } }); ws.on("error", () => {});
  t.after(() => ws.terminate()); await once(ws, "open");
  const end = once(ws, "close"); f.abort.abort(); await end;
  await waitFor(() => f.receipts.length === 1); assert.equal(f.receipts[0].code, "revoked");
});

test("a slow downstream receives the complete final WebSocket frame before upstream EOF", { timeout: 12000 }, async t => {
  const f = await fixture(t), wss = new WebSocketServer({ server: f.upstream });
  const payload = Buffer.alloc(4 * 1024 * 1024, 237), connected = Promise.withResolvers();
  wss.on("connection", client => connected.resolve(client));
  t.after(() => { for (const client of wss.clients) client.terminate(); wss.close(); });
  const ws = new WebSocket("ws://127.0.0.1:" + f.port, { headers: { host: f.hostname }, perMessageDeflate: false });
  ws.on("error", () => {}); t.after(() => ws.terminate());
  await once(ws, "open"); const upstream = await connected.promise;
  ws._socket.pause();
  const value = once(ws, "message"), closed = once(ws, "close");
  upstream.send(payload, { binary: true }, () => upstream._socket.end());
  await new Promise(resolve => setTimeout(resolve, 70)); ws._socket.resume();
  assert.deepEqual((await value)[0], payload); await closed;
});

test("streamed response overflow and premature upstream EOF do not claim success", async t => {
  const f = await fixture(t, { limits: { responseBytes: 8 }, handler: (_req, res) => {
    res.writeHead(200); res.write("1234"); setTimeout(() => res.end("56789"), 20);
  } });
  await assert.rejects(send(f));
  await waitFor(() => f.receipts.length === 1); assert.equal(f.receipts[0].ok, false); assert.equal(f.receipts[0].code, "response-too-large");
  const broken = await fixture(t, { handler: (_req, res) => {
    res.writeHead(200, { "content-length": 10 }); res.write("one");
    setTimeout(() => res.socket.destroy(), 20);
  } });
  await assert.rejects(send(broken));
  await waitFor(() => broken.receipts.length === 1); assert.equal(broken.receipts[0].ok, false);
});

test("WebSocket byte limits and cancellation still tear down a backpressured downstream", { timeout: 12000 }, async t => {
  const f = await fixture(t, { limits: { websocketBytes: 64 } }), wss = new WebSocketServer({ server: f.upstream });
  wss.on("connection", client => client.on("message", value => client.send(value)));
  t.after(() => { for (const client of wss.clients) client.terminate(); wss.close(); });
  const ws = new WebSocket("ws://127.0.0.1:" + f.port, { headers: { host: f.hostname } }); ws.on("error", () => {});
  t.after(() => ws.terminate()); await once(ws, "open"); const closed = once(ws, "close"); ws.send(Buffer.alloc(128)); await closed;
  await waitFor(() => f.receipts.length === 1); assert.equal(f.receipts[0].code, "websocket-too-large"); assert.equal(f.receipts[0].ok, false);
  const slow = await fixture(t), slowWss = new WebSocketServer({ server: slow.upstream });
  const connected = Promise.withResolvers(); slowWss.on("connection", client => connected.resolve(client));
  t.after(() => { for (const client of slowWss.clients) client.terminate(); slowWss.close(); });
  const client = new WebSocket("ws://127.0.0.1:" + slow.port, { headers: { host: slow.hostname } }); client.on("error", () => {});
  t.after(() => client.terminate()); await once(client, "open");
  client._socket.pause(); (await connected.promise).send(Buffer.alloc(8 * 1024 * 1024));
  await new Promise(resolve => setTimeout(resolve, 30)); slow.abort.abort();
  await waitFor(() => slow.receipts.length === 1, { timeoutMs: 6000 }); assert.equal(slow.receipts[0].code, "revoked");
  assert.equal(slow.receipts[0].cleanupConfirmed, true); client._socket.resume();
});

test("shared pre-spawn limits bound chats/owners/global fanout and release only after cleanup", async t => {
  const limits = { maxActive: 3, maxPerOwner: 2, maxPerChat: 1 };
  const handler = (_req, res) => { res.writeHead(200, { "content-type": "text/event-stream" }); res.write("data: held\n\n"); };
  const first = await fixture(t, { limits, handler, ownerId: "owner-a", chatId: "chat-a" });
  const same = await fixture(t, { limits, ownerId: "owner-a", chatId: "chat-a", hostname: "same.preview.example" });
  const second = await fixture(t, { limits, handler, ownerId: "owner-a", chatId: "chat-b", hostname: "second.preview.example" });
  const third = await fixture(t, { limits, handler, ownerId: "owner-b", chatId: "chat-a", hostname: "third.preview.example" });
  const deniedOwner = await fixture(t, { limits, ownerId: "owner-a", chatId: "chat-c", hostname: "owner.preview.example" });
  const deniedGlobal = await fixture(t, { limits, ownerId: "owner-c", chatId: "chat-d", hostname: "global.preview.example" });
  // Do not await the held request itself; wait only for its first streamed byte.
  const opened = [];
  for (const f of [first, second]) {
    const ready = Promise.withResolvers(); opened.push(send(f, { onData: () => ready.resolve() }).catch(() => {})); await ready.promise;
  }
  assert.equal((await send(same)).status, 429); assert.equal(same.calls.length, 0);
  assert.equal((await send(deniedOwner)).status, 429); assert.equal(deniedOwner.calls.length, 0);
  const ready = Promise.withResolvers(); opened.push(send(third, { onData: () => ready.resolve() }).catch(() => {})); await ready.promise;
  assert.equal(third.calls.length, 1, "another owner retains admission capacity");
  assert.equal((await send(deniedGlobal)).status, 429); assert.equal(deniedGlobal.calls.length, 0);
  first.abort.abort(); await waitFor(() => first.receipts.length === 1);
  assert.equal((await send(same)).status, 200, "same-scope slot is reusable after observed cleanup");
  second.abort.abort(); third.abort.abort(); await Promise.all(opened);
});

test("unconfirmed child cleanup cannot return success or recycle shared capacity", { timeout: 9000 }, async t => {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => false;
  const frame = (type, value = Buffer.alloc(0)) => { const header = Buffer.alloc(5); header[0] = type; header.writeUInt32BE(value.length, 1); return Buffer.concat([header, value]); };
  let input = "", answered = false;
  child.stdin.on("data", bytes => {
    input += bytes.toString();
    if (!answered && input.includes("\r\n\r\n")) {
      answered = true;
      child.stdout.write(Buffer.concat([frame(2, Buffer.from("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok")), frame(3)]));
    }
  });
  const limits = { maxActive: 1 };
  const f = await fixture(t, { limits, ownerId: "uncertain-owner", chatId: "uncertain-chat", context: ({ lease }) => ({
    lease, executor: { workspace: "/", spawn: () => { queueMicrotask(() => child.stdout.write(frame(1))); return child; } },
  }) });
  assert.equal((await send(f)).status, 200);
  await waitFor(() => f.receipts.length === 1, { timeoutMs: 7000 });
  assert.deepEqual(f.receipts[0], { ok: false, code: "cleanup-unconfirmed", cleanupConfirmed: false });
  const other = await fixture(t, { limits, ownerId: "different-owner", chatId: "different-chat" });
  assert.equal((await send(other)).status, 429); assert.equal(other.calls.length, 0);
});
