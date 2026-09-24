import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { createServer as tcpServer } from "node:net";
import { Agent, createServer as httpServer, request } from "node:http";
import { EventEmitter, once } from "node:events";
import { PassThrough } from "node:stream";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import WebSocket, { WebSocketServer } from "ws";
import { WORKER_TCP_BRIDGE, openWorkerTcp } from "../src/worker-tcp-bridge.mjs";
import { SSH_WORKER_LAUNCHER, sshWorkerRequest } from "../src/ssh-worker-launcher.mjs";
import { temporaryDirectory, waitFor } from "./helpers.mjs";

const frame = (type, data = Buffer.alloc(0)) => { const prefix = Buffer.alloc(5); prefix[0] = type; prefix.writeUInt32BE(data.length, 1); return Buffer.concat([prefix, data]); };
async function listen(t, server) {
  const sockets = new Set(); server.on("connection", socket => { sockets.add(socket); socket.on("error", () => {}); socket.on("close", () => sockets.delete(socket)); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); });
  return server.address().port;
}
async function fixture(t, { script, launcher = false } = {}) {
  const root = await temporaryDirectory(t), children = [], calls = [], errors = [];
  const heartbeat = path.join(root, ".heartbeat"); if (launcher) await writeFile(heartbeat, "");
  const executor = { workspace: root, spawn(command, args, options) {
    calls.push({ command, args, options });
    assert.equal(command, "/usr/bin/node"); assert.deepEqual(args, ["--input-type=module", "-e", WORKER_TCP_BRIDGE]);
    assert.deepEqual(options.env, {}); assert.equal(options.cwd, root);
    const child = spawn(process.execPath, ["--input-type=module", "-e", script || (launcher ? SSH_WORKER_LAUNCHER : WORKER_TCP_BRIDGE)], { ...options, env: {} });
    children.push(child);
    if (launcher) child.stdin.write(sshWorkerRequest({ command: process.execPath, args, env: {}, cwd: root, heartbeat }));
    return child;
  } };
  const bridges = [];
  const open = options => {
    const bridge = openWorkerTcp(executor, options); bridges.push(bridge); bridge.on("error", error => errors.push(error));
    bridge.closedReceipt = new Promise(resolve => bridge.once("close", resolve));
    return bridge;
  };
  t.after(async () => { for (const bridge of bridges) bridge.destroy(); await Promise.all(bridges.map(bridge => bridge.closedReceipt)); });
  return { open, executor, calls, children, errors };
}
const collect = async stream => { const chunks = []; for await (const chunk of stream) chunks.push(chunk); return Buffer.concat(chunks); };

test("port/config validation refuses alternate hosts, shell text and privileged destinations before spawning", async t => {
  const f = await fixture(t);
  for (const port of [undefined, null, "8080", "8080;private", 0, 22, 80, 1023, 65536, 1.5, NaN]) assert.throws(() => f.open({ port }), { code: "invalid-options" });
  for (const options of [{ port: 8080, host: "169.254.169.254" }, { port: 8080, command: "private" }, { port: 8080, idleTimeoutMs: 0 }, { port: 8080, maxLifetimeMs: 900001 }, { port: 8080, signal: {} }]) assert.throws(() => f.open(options));
  const cancelled = f.open({ port: 8080, signal: AbortSignal.abort() }); await assert.rejects(cancelled.ready); await cancelled.closedReceipt;
  assert.equal(f.calls.length, 0);
});

for (const launcher of [false, true]) test(`binary passthrough and client half-close preserve exact bytes (${launcher ? "existing SSH launcher" : "direct worker"})`, { timeout: 8000 }, async t => {
  const port = await listen(t, tcpServer({ allowHalfOpen: true }, socket => { const parts = []; socket.on("data", chunk => parts.push(chunk)); socket.on("end", () => socket.end(Buffer.concat(parts))); }));
  const f = await fixture(t, { launcher }), stream = f.open({ port }), input = Buffer.from([0, 255, 13, 10, 128, 42]);
  const result = collect(stream); await stream.ready; stream.end(input);
  assert.deepEqual(await result, input); await stream.closedReceipt;
  assert.equal(f.errors.length, 0); assert.equal(f.children[0].exitCode, 0);
  assert.ok(f.calls[0].args.every(arg => !arg.includes(String(port))));
});

test("server half-close is delivered before client EOF, and more client bytes still reach the server", { timeout: 8000 }, async t => {
  const received = Promise.withResolvers();
  const port = await listen(t, tcpServer({ allowHalfOpen: true }, socket => { const chunks = []; socket.end("server-finished"); socket.on("data", data => chunks.push(data)); socket.on("end", () => received.resolve(Buffer.concat(chunks).toString())); }));
  const f = await fixture(t, { launcher: true }), stream = f.open({ port }); await stream.ready;
  stream.write("before-");
  const parts = []; stream.on("data", bytes => parts.push(bytes)); await once(stream, "end");
  assert.equal(Buffer.concat(parts).toString(), "server-finished"); assert.equal(stream.writable, true);
  stream.end("after-FIN"); assert.equal(await received.promise, "before-after-FIN"); await stream.closedReceipt;
  assert.equal(f.errors.length, 0);
});

test("HTTP path/upload/streaming response travel as unmodified application bytes", { timeout: 8000 }, async t => {
  let observed;
  const server = httpServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    observed = { url: req.url, method: req.method, body: Buffer.concat(chunks).toString() };
    res.writeHead(200, { "content-type": "text/event-stream", connection: "close" }); res.write("data: first\n\n");
    setTimeout(() => res.end("data: second\n\n"), 30);
  });
  const port = await listen(t, server), f = await fixture(t, { launcher: true }), bridge = f.open({ port }); await bridge.ready;
  const agent = new Agent({ keepAlive: false }); agent.createConnection = () => bridge; t.after(() => agent.destroy());
  const chunks = [];
  const result = new Promise((resolve, reject) => {
    const req = request({ host: "worker.invalid", port, path: "/exact/path?x=one%20two", method: "POST", agent,
      lookup: (_name, _options, callback) => callback(Error("Unexpected network lookup")) }, res => {
      res.on("data", bytes => chunks.push(bytes)); res.on("end", resolve); res.on("error", reject);
    });
    t.after(() => req.destroy());
    req.on("error", reject); req.end("upload\u0000payload");
  });
  result.catch(() => {});
  await waitFor(() => chunks.length > 0); assert.equal(chunks[0].toString(), "data: first\n\n");
  await result; assert.equal(Buffer.concat(chunks).toString(), "data: first\n\ndata: second\n\n");
  assert.deepEqual(observed, { url: "/exact/path?x=one%20two", method: "POST", body: "upload\u0000payload" });
});

test("WebSocket upgrade and binary messages work through the same dormant Duplex", { timeout: 8000 }, async t => {
  const server = httpServer(), wss = new WebSocketServer({ server });
  wss.on("connection", client => client.on("message", (data, binary) => client.send(data, { binary })));
  t.after(() => { for (const client of wss.clients) client.terminate(); wss.close(); });
  const port = await listen(t, server), f = await fixture(t, { launcher: true }), bridge = f.open({ port }); await bridge.ready;
  const ws = new WebSocket(`ws://worker.invalid:${port}/ws?unchanged=1`, { createConnection: () => bridge, perMessageDeflate: false });
  t.after(() => ws.terminate()); await once(ws, "open");
  const payload = Buffer.from([255, 0, 13, 10, 31]), response = once(ws, "message"); ws.send(payload);
  const [actual, binary] = await response; assert.equal(binary, true); assert.deepEqual(actual, payload);
  const closed = once(ws, "close"); ws.close(); await closed;
});

test("slow consumers bound controller buffering and resume without losing bytes", { timeout: 10000 }, async t => {
  const size = 4 * 1024 * 1024, data = Buffer.alloc(size, 231); let blocked = false;
  const port = await listen(t, tcpServer({ allowHalfOpen: true }, socket => {
    blocked = !socket.write(data); socket.end(); socket.on("data", () => {});
  }));
  const f = await fixture(t), stream = f.open({ port }); await stream.ready;
  await new Promise(resolve => setTimeout(resolve, 70));
  assert.equal(blocked, true); assert.ok(stream.readableLength <= 131072); assert.ok(stream.buffer.length <= 196608);
  const result = collect(stream); stream.end(); assert.deepEqual(await result, data); await stream.closedReceipt;
  assert.equal(f.errors.length, 0);
});

test("slow upstream writing observes backpressure and explicit cancellation reaps only this child", { timeout: 8000 }, async t => {
  const port = await listen(t, tcpServer(socket => { socket.pause(); }));
  const f = await fixture(t), signal = new AbortController(), stream = f.open({ port, signal: signal.signal }); await stream.ready;
  assert.equal(stream.write(Buffer.alloc(2 * 1024 * 1024)), false);
  signal.abort(); await stream.closedReceipt;
  assert.equal(f.errors[0].code, "cancelled"); assert.ok(f.children[0].exitCode !== null || f.children[0].signalCode);
});

test("cancellation remains responsive with unread downstream frames and leaves another connection alive", { timeout: 8000 }, async t => {
  const port = await listen(t, tcpServer(socket => { const block = Buffer.alloc(65536, 91); const send = () => { while (!socket.destroyed && socket.write(block)) {} }; socket.on("drain", send); send(); }));
  const echoPort = await listen(t, tcpServer({ allowHalfOpen: true }, socket => socket.pipe(socket)));
  const f = await fixture(t), signal = new AbortController(), slow = f.open({ port, signal: signal.signal }), other = f.open({ port: echoPort });
  await Promise.all([slow.ready, other.ready]); await waitFor(() => slow.readableLength >= 65536);
  signal.abort(); await slow.closedReceipt;
  assert.equal(other.destroyed, false); assert.equal(f.errors[0].code, "cancelled");
  const result = collect(other); other.end("still-owned"); assert.equal((await result).toString(), "still-owned");
});

test("fragmented frame headers and payloads are decoded without application-visible framing", { timeout: 8000 }, async t => {
  const output = Buffer.concat([frame(1), frame(2, Buffer.from([0, 255, 13, 10])), frame(3)]);
  const script = `process.stdin.resume(); const data=Buffer.from('${output.toString("hex")}','hex');let i=0;const timer=setInterval(()=>{process.stdout.write(data.subarray(i,i+1));if(++i===data.length)clearInterval(timer);},1);process.stdin.on('end',()=>{});`;
  const f = await fixture(t, { script }), stream = f.open({ port: 8080 });
  const result = collect(stream); await stream.ready; stream.end();
  assert.deepEqual(await result, Buffer.from([0, 255, 13, 10])); await stream.closedReceipt; assert.equal(f.errors.length, 0);
});

test("idle and lifetime deadlines close healthy but unused or endlessly active connections", { timeout: 8000 }, async t => {
  const port = await listen(t, tcpServer(socket => { const interval = setInterval(() => socket.write("tick"), 5); socket.on("close", () => clearInterval(interval)); }));
  const f = await fixture(t), lifetime = f.open({ port, idleTimeoutMs: 1000, maxLifetimeMs: 100 }); lifetime.resume();
  await lifetime.ready; await lifetime.closedReceipt; assert.equal(f.errors.at(-1).code, "lifetime-timeout");
  const silentPort = await listen(t, tcpServer(() => {})), idle = f.open({ port: silentPort, idleTimeoutMs: 30 });
  await idle.ready; await idle.closedReceipt; assert.equal(f.errors.at(-1).code, "idle-timeout");
});

test("malformed remote frames and incomplete/early child exits never inject control bytes or private errors", { timeout: 10000 }, async t => {
  const oversize = Buffer.alloc(5); oversize[0] = 2; oversize.writeUInt32BE(65537, 1);
  for (const bytes of [frame(2, Buffer.from("PRIVATE")), frame(3), Buffer.concat([frame(1), frame(1)]), Buffer.concat([frame(1), frame(3), frame(3)]),
    Buffer.concat([frame(1), frame(3), frame(2, Buffer.from("PRIVATE"))]), frame(99), oversize, Buffer.from([1, 0]), Buffer.concat([frame(1), Buffer.from([2, 0, 0, 0, 10, 11])]), Buffer.alloc(0)]) {
    const script = `process.stdin.resume();process.stdout.write(Buffer.from('${bytes.toString("hex")}','hex'));process.stderr.write('PRIVATE-NATIVE-DIAGNOSTIC');process.stdin.destroy();`;
    const f = await fixture(t, { script }), stream = f.open({ port: 8080 }), output = [];
    stream.on("data", bytes => output.push(bytes));
    await stream.closedReceipt; assert.equal(f.errors.length, 1); assert.doesNotMatch(f.errors[0].message, /PRIVATE/);
    assert.doesNotMatch(Buffer.concat(output).toString(), /PRIVATE/);
  }
});

test("connection timeout, refused port, synchronous spawn failure and async child failure are bounded", { timeout: 8000 }, async t => {
  const f = await fixture(t, { script: "process.stdin.resume();setInterval(()=>{},1000);" }), stalled = f.open({ port: 8080, connectTimeoutMs: 30 });
  await assert.rejects(stalled.ready); await stalled.closedReceipt; assert.equal(f.errors[0].code, "connect-timeout");
  for (const spawnFn of [() => { throw Error("PRIVATE-SPAWN"); }, () => spawn("/missing-private-worker-node", [], { stdio: ["pipe", "pipe", "pipe"] })]) {
    const stream = openWorkerTcp({ workspace: "/", spawn: spawnFn }, { port: 8080 }); stream.on("error", () => {});
    const done = new Promise(resolve => stream.once("close", resolve)); await assert.rejects(stream.ready, error => !error.message.includes("PRIVATE")); await done;
  }
  const server = tcpServer(), port = await listen(t, server); await new Promise(resolve => server.close(resolve));
  const real = await fixture(t), refused = real.open({ port }); await assert.rejects(refused.ready); await refused.closedReceipt;
  assert.equal(real.errors[0].code, "child-failed");
});

test("worker independently rejects malformed, oversized and alternate-host configuration", { timeout: 8000 }, async t => {
  const config = { version: 1, port: 8080, connectTimeoutMs: 100, idleTimeoutMs: 100, maxLifetimeMs: 100 };
  for (const input of ["{PRIVATE\n", "x".repeat(514), ...[{ ...config, host: "169.254.169.254" }, ...[22, 0, 65536, "8080"].map(port => ({ ...config, port }))].map(value => JSON.stringify(value) + "\n")]) {
    const child = spawn(process.execPath, ["--input-type=module", "-e", WORKER_TCP_BRIDGE], { env: {}, stdio: ["pipe", "pipe", "pipe"] });
    t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
    let output = "", error = ""; child.stdout.on("data", data => output += data); child.stderr.on("data", data => error += data); child.stdin.on("error", () => {});
    const done = once(child, "close"); child.stdin.end(input); const [code] = await done;
    assert.equal(code, 1); assert.equal(output, ""); assert.equal(error, "Worker TCP bridge failed\n");
  }
});

test("unobserved child death fails with bounded cleanup uncertainty instead of reporting success", { timeout: 7000 }, async () => {
  const child = new EventEmitter(), signals = [], errors = [];
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kill = signal => { signals.push(signal); return false; };
  const bridge = openWorkerTcp({ workspace: "/", spawn: () => child }, { port: 8080 });
  bridge.on("error", error => errors.push(error));
  const closed = new Promise(resolve => bridge.once("close", resolve));
  child.stdout.write(frame(1)); await bridge.ready; bridge.destroy(); await closed;
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
  assert.equal(bridge.cleanupConfirmed, false); assert.equal(bridge.childClosed, false);
  assert.equal(errors.length, 1); assert.equal(errors[0].code, "cleanup-unconfirmed");
});
