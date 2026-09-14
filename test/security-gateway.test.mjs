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
