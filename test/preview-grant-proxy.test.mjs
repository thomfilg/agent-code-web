import assert from "node:assert/strict";
import test from "node:test";
import { createServer, request } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import WebSocket, { WebSocketServer } from "ws";
import { PreviewGrants } from "../src/preview-grants.mjs";
import { createWorkerPreviewProxy } from "../src/worker-preview-proxy.mjs";
import { WORKER_TCP_BRIDGE } from "../src/worker-tcp-bridge.mjs";
import { SSH_WORKER_LAUNCHER, sshWorkerRequest } from "../src/ssh-worker-launcher.mjs";
import { temporaryDirectory, waitFor } from "./helpers.mjs";

// Component-contract fixtures only: loopback HTTP/WS and the unchanged launcher
// in disposable local processes. No public routing, real SSH, AWS or account.
async function fixture(t, { grantTtlMs = 10000 } = {}) {
  const root = await temporaryDirectory(t), heartbeat = path.join(root, ".heartbeat");
  await writeFile(heartbeat, "");
  const current = new Map(), sites = [], tasks = new Set(), requests = new Set(), clients = new Set();
  let checks = 0;
  const grants = new PreviewGrants({ grantTtlMs, isCurrent: saved => {
    checks++;
    const selected = current.get(saved.hostname);
    return Boolean(selected) && Object.keys(selected).every(key => saved[key] === selected[key]);
  } });
  const listen = async server => {
    const sockets = new Set();
    server.on("connection", socket => {
      sockets.add(socket); socket.on("error", () => {}); socket.once("close", () => sockets.delete(socket));
    });
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    return { server, sockets, port: server.address().port };
  };
  t.after(async () => {
    grants.close();
    for (const client of clients) client.terminate();
    for (const req of requests) req.destroy();
    await Promise.all(tasks);
    for (const site of sites) {
      for (const client of site.wss.clients) client.terminate();
      await new Promise(resolve => site.wss.close(resolve));
      for (const endpoint of [site.front, site.upstream]) {
        for (const socket of endpoint.sockets) socket.destroy();
        await new Promise(resolve => endpoint.server.close(resolve));
      }
      for (const child of site.children) assert.ok(child.exitCode !== null || child.signalCode !== null, "exact fixture child reaped");
    }
  });
  const site = async name => {
    const state = { name, children: [], receipts: [], streams: new Set() };
    state.upstream = await listen(createServer((_req, response) => {
      state.streams.add(response); response.once("close", () => state.streams.delete(response));
      response.writeHead(200, { "content-type": "text/event-stream" }); response.write("data: first\n\n");
    }));
    state.wss = new WebSocketServer({ server: state.upstream.server });
    state.wss.on("connection", socket => socket.on("message", (value, binary) => socket.send(value, { binary })));
    state.binding = Object.freeze({ ownerId: `owner-${name}`, sessionId: `session-${name}`, chatId: `chat-${name}`,
      hostname: `${name}.preview.example`, port: state.upstream.port, runtimeGeneration: 1 });
    current.set(state.binding.hostname, state.binding);
    ({ ticket: state.ticket } = grants.issueTicket(state.binding));
    ({ grant: state.grant } = grants.exchangeTicket(state.ticket, state.binding.hostname));
    const executor = { workspace: root, spawn(command, args, options) {
      assert.equal(command, "/usr/bin/node"); assert.deepEqual(args, ["--input-type=module", "-e", WORKER_TCP_BRIDGE]);
      assert.deepEqual(options.env, {});
      assert.ok(!JSON.stringify({ command, args, options }).includes(state.grant));
      const child = spawn(process.execPath, ["--input-type=module", "-e", SSH_WORKER_LAUNCHER], { ...options, env: {} });
      state.children.push(child);
      child.stdin.write(sshWorkerRequest({ command: process.execPath, args, env: {}, cwd: root, heartbeat }));
      return child;
    } };
    const proxy = createWorkerPreviewProxy();
    const context = req => ({ executor, lease: grants.authorize(state.grant, req.headers.host) });
    const track = promise => {
      tasks.add(promise);
      void promise.then(receipt => state.receipts.push(receipt)).finally(() => tasks.delete(promise));
    };
    state.front = await listen(createServer((req, response) => {
      try { track(proxy.http(req, response, context(req))); }
      catch { response.writeHead(403, { connection: "close" }); response.end("denied"); }
    }));
    state.front.server.on("upgrade", (req, socket, head) => {
      try { track(proxy.upgrade(req, socket, head, context(req))); }
      catch { socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n", () => socket.destroySoon()); }
    });
    sites.push(state); return state;
  };
  const http = (state, host = state.binding.hostname) => new Promise((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port: state.front.port, path: "/events", headers: { host }, agent: false }, response => {
      const received = { response, text: "" };
      response.on("data", chunk => { received.text += chunk; }); response.on("error", () => {}); resolve(received);
    });
    requests.add(req); req.once("close", () => requests.delete(req)); req.on("error", reject); req.end();
  });
  const websocket = state => {
    const client = new WebSocket(`ws://127.0.0.1:${state.front.port}/echo`, { headers: { host: state.binding.hostname } });
    clients.add(client); client.on("error", () => {}); client.once("close", () => clients.delete(client)); return client;
  };
  return { grants, site, http, websocket, get checks() { return checks; } };
}

test("real preview grants stream SSE incrementally and session revocation preserves another owner's proxy", { timeout: 15000 }, async t => {
  const f = await fixture(t), alice = await f.site("alice"), bob = await f.site("bob");
  const a = await f.http(alice), b = await f.http(bob);
  await waitFor(() => a.text.includes("first") && b.text.includes("first"));
  assert.equal(a.response.complete, false); assert.equal(b.response.complete, false);
  for (const response of alice.streams) response.write("data: incremental\n\n");
  await waitFor(() => a.text.includes("incremental"));
  assert.equal(a.response.complete, false, "second event arrived without ending the SSE response");
  assert.equal(f.grants.revokeSession(alice.binding.ownerId, alice.binding.sessionId), 1);
  await waitFor(() => alice.receipts.length === 1, { timeoutMs: 6000 });
  assert.deepEqual(alice.receipts[0], { ok: false, code: "revoked", cleanupConfirmed: true });
  assert.equal(b.response.destroyed, false); assert.equal(bob.receipts.length, 0);
  for (const response of bob.streams) response.write("data: sibling-still-live\n\n");
  await waitFor(() => b.text.includes("sibling-still-live"));
  assert.throws(() => f.grants.authorize(alice.grant, alice.binding.hostname), /Preview access is unavailable/);
  assert.equal(alice.children.length, 1); assert.equal(bob.children.length, 1);
});

test("a real grant expires during binary WebSocket traffic without another authorization or prune", { timeout: 10000 }, async t => {
  const f = await fixture(t, { grantTtlMs: 1200 }), state = await f.site("expiry"), client = f.websocket(state);
  await once(client, "open");
  const bytes = Buffer.from([0, 255, 13, 10, 87]), echoed = once(client, "message");
  client.send(bytes); assert.deepEqual((await echoed)[0], bytes);
  const before = f.checks;
  await once(client, "close");
  await waitFor(() => state.receipts.length === 1, { timeoutMs: 6000 });
  assert.equal(f.checks, before, "expiry did not need another request, authorize or prune");
  assert.deepEqual(state.receipts[0], { ok: false, code: "revoked", cleanupConfirmed: true });
  assert.equal(state.children.length, 1);
  assert.throws(() => f.grants.authorize(state.grant, state.binding.hostname), /Preview access is unavailable/);
});

test("wrong observed hosts and replayed tickets cannot admit or spawn a preview proxy", { timeout: 5000 }, async t => {
  const f = await fixture(t), state = await f.site("authority");
  for (const host of ["other.preview.example", "localhost", "169.254.169.254"]) {
    const denied = await f.http(state, host);
    assert.equal(denied.response.statusCode, 403);
  }
  assert.throws(() => f.grants.exchangeTicket(state.ticket, state.binding.hostname), /Preview access is unavailable/);
  assert.equal(state.children.length, 0); assert.equal(state.receipts.length, 0);
  const client = new WebSocket(`ws://127.0.0.1:${state.front.port}/echo`, { headers: { host: "wrong.preview.example" } });
  client.on("error", () => {}); t.after(() => client.terminate());
  await once(client, "error");
  assert.equal(state.children.length, 0);
});
