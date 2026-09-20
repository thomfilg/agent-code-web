import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import { CapabilityBroker } from "../src/capabilities.mjs";
import { ProviderGateway } from "../src/provider-gateway.mjs";
import { ChatStore } from "../src/store.mjs";
import { redact } from "../src/utils.mjs";
import { buildWorkerEnvironment, spawnWorker } from "../src/worker-process.mjs";
import { temporaryDirectory, testConfig } from "./helpers.mjs";

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

test("controller leases renew only live scopes; ordinary capabilities keep their fixed expiry", t => {
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1000000 });
  const broker = new CapabilityBroker({ ttlMs: 3000 });
  let allowed = true, checks = 0;
  const leased = broker.issue({ chatId: "owned", provider: "anthropic", renewable: true, validWhile: () => { checks++; return allowed; } });
  const fixed = broker.issue({ chatId: "another", provider: "anthropic" });
  t.after(() => broker.revokeChat("owned"));
  const notified = [], off = broker.observeProvider(leased, "anthropic", value => notified.push(value));
  const response = broker.captureProviderObserver(leased, "anthropic");
  for (let i = 0; i < 7; i++) t.mock.timers.tick(1000);
  assert(broker.validate(leased, "anthropic")); assert.equal(broker.validate(leased, "openai"), null);
  assert.equal(broker.validate(fixed, "anthropic"), null);
  response("same request after renewal"); assert.deepEqual(notified, ["same request after renewal"]);
  off(); const later = broker.observeProvider(leased, "anthropic", value => notified.push(value));
  response("do not leak to the later turn"); assert.equal(notified.length, 1); later();
  allowed = false; assert.equal(broker.validate(leased, "anthropic"), null);
  const before = checks; allowed = true; t.mock.timers.tick(3000);
  assert.equal(checks, before); assert.equal(broker.validate(leased, "anthropic"), null); assert.equal(broker.size, 0);
});

test("missed renewal, revocation, guard errors and replacement tokens never resurrect expired authority", t => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let now = 1000000, checks = 0;
  const broker = new CapabilityBroker({ ttlMs: 3000, now: () => now });
  const issue = validWhile => broker.issue({ chatId: "owned", provider: "anthropic", renewable: true, validWhile });
  assert.throws(() => issue(null), /scope guard/);
  const expired = issue(() => { checks++; return true; });
  now += 3001; t.mock.timers.tick(1000);
  assert.equal(broker.validate(expired, "anthropic"), null); assert.equal(checks, 0);
  const broken = issue(() => { throw Error("Private scope error"); });
  assert.equal(broker.validate(broken, "anthropic"), null);
  const previous = issue(() => true), replacement = issue(() => true);
  broker.revoke(previous); assert(broker.validate(replacement, "anthropic"));
  broker.revokeChat("owned"); t.mock.timers.tick(10000);
  assert.equal(broker.validate(previous, "anthropic"), null); assert.equal(broker.validate(replacement, "anthropic"), null);
  assert.equal(broker.size, 0);
});

test("a controller can restore only the hash of a revalidated retained-process capability", t => {
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1000000 });
  const first = new CapabilityBroker({ ttlMs: 3000 });
  const token = first.issue({ chatId: "retained", provider: "mcp" });
  const hash = first.snapshotHash("retained", "mcp");
  assert.match(hash, /^[a-f0-9]{64}$/);
  first.revokeChat("retained"); assert.equal(first.validate(token, "mcp"), null);

  let allowed = true;
  const restored = new CapabilityBroker({ ttlMs: 3000 });
  restored.restoreToken({ token, chatId: "retained", provider: "mcp", renewable: true, validWhile: () => allowed });
  assert(restored.validate(token, "mcp"));
  assert.throws(() => restored.restoreToken({ token, chatId: "other", provider: "mcp" }), /another scope/);
  assert(restored.validateHash(hash, "mcp"));
  assert.equal(restored.validateHash(hash, "github-worker"), null);
  assert.throws(() => restored.restoreHash({ hash: "0".repeat(63), chatId: "retained", provider: "mcp" }), /invalid/);
  allowed = false; assert.equal(restored.validate(token, "mcp"), null);
});

test("gateway swaps a chat capability for the real provider key", async (t) => {
  let received;
  let upstreamRequests = 0;
  const upstream = http.createServer(async (request, response) => {
    upstreamRequests += 1;
    let body = "";
    for await (const chunk of request) body += chunk;
    received = { authorization: request.headers.authorization, body, path: request.url };
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"proxied":true}');
  });
  const upstreamPort = await listen(upstream);
  t.after(() => close(upstream));

  const root = await temporaryDirectory(t);
  const realKey = "sk-real-control-plane-only";
  const config = testConfig(root, {
    OPENAI_API_KEY: realKey,
    OPENAI_BASE_URL_UPSTREAM: `http://127.0.0.1:${upstreamPort}`,
  });
  const broker = new CapabilityBroker({ ttlMs: 10_000 });
  const gateway = new ProviderGateway({ config, broker });
  const gatewayServer = http.createServer((request, response) => gateway.handle(request, response, new URL(request.url, "http://gateway")));
  const gatewayPort = await listen(gatewayServer);
  t.after(() => close(gatewayServer));

  const capability = broker.issue({ chatId: "chat_fixture", provider: "openai" });
  const response = await fetch(`http://127.0.0.1:${gatewayPort}/gateway/openai/v1/responses?stream=true`, {
    method: "POST",
    headers: { authorization: `Bearer ${capability}`, "content-type": "application/json" },
    body: '{"model":"fixture"}',
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { proxied: true });
  assert.equal(received.authorization, `Bearer ${realKey}`);
  assert.equal(received.path, "/v1/responses?stream=true");
  assert.equal(received.body, '{"model":"fixture"}');

  const denied = await fetch(`http://127.0.0.1:${gatewayPort}/gateway/openai/v1/responses`, {
    method: "POST",
    headers: { authorization: "Bearer forged" },
    body: "{}",
  });
  assert.equal(denied.status, 401);

  const escapedHost = await fetch(`http://127.0.0.1:${gatewayPort}/gateway/openai//attacker.invalid/v1/responses`, {
    method: "POST",
    headers: { authorization: `Bearer ${capability}` },
    body: "{}",
  });
  assert.equal(escapedHost.status, 403);

  const forbiddenMethod = await fetch(`http://127.0.0.1:${gatewayPort}/gateway/openai/v1/responses`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${capability}` },
  });
  assert.equal(forbiddenMethod.status, 403);
  assert.equal(upstreamRequests, 1);
});

test("logs redact provider keys and temporary capabilities", () => {
  const value = redact("OPENAI_API_KEY=sk-real-secret-123 AGENT_SESSION_TOKEN=cap_abcdefghijklmnopqrstuvwxyz012345");
  assert.ok(!value.includes("real-secret"));
  assert.ok(!value.includes("abcdefghijklmnopqrstuvwxyz"));
});

test("worker environment excludes every long-lived provider key", async (t) => {
  const root = await temporaryDirectory(t);
  const store = new ChatStore(root);
  await store.initialize();
  const chat = await store.create({ title: "Security", agent: "codex", source: "" });
  const env = await buildWorkerEnvironment({
    chat,
    store,
    provider: "openai",
    authMode: "gateway",
    capability: "cap-short-lived",
    gatewayOrigin: "http://127.0.0.1:8787",
  });
  assert.equal(env.AGENT_SESSION_TOKEN, "cap-short-lived");
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.AWS_ACCESS_KEY_ID, undefined);
  assert.equal(env.AGENT_WEB_AUTH_TOKEN, undefined);
  assert.ok(!Object.values(env).some((value) => value === "sk-real-control-plane-only"));
});

test("remote worker directories are prepared by the remote executor", async (t) => {
  const root = await temporaryDirectory(t);
  const store = new ChatStore(root);
  await store.initialize();
  const chat = await store.create({ title: "Remote paths", agent: "codex", source: "" });
  const prepared = [];
  const env = await buildWorkerEnvironment({
    chat,
    store,
    runtimeHome: "/opt/agent-web/chats/fixture/runtime-home",
    provider: "openai",
    authMode: "gateway",
    capability: "cap-short-lived",
    gatewayOrigin: "https://agents.example.com",
    ensureDirectory: async (directory) => { prepared.push(directory); },
  });
  assert.equal(env.TMPDIR, "/opt/agent-web/chats/fixture/runtime-home/tmp");
  assert.deepEqual(prepared, [env.TMPDIR]);
});

test("Linux namespace worker gets a private PID namespace", { skip: process.platform !== "linux" }, async () => {
  const output = await new Promise((resolve, reject) => {
    const child = spawnWorker("/bin/sh", ["-c", "cat /proc/1/comm"], {
      isolation: "namespace",
      env: { PATH: process.env.PATH },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let text = "";
    child.stdout.on("data", (chunk) => { text += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve(text.trim()) : reject(new Error(`unshare exited ${code}`)));
  });
  assert.equal(output, "sh");
});
