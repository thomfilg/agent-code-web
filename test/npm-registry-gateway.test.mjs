import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import { mkdir, readFile } from "node:fs/promises";
import { CapabilityBroker } from "../src/capabilities.mjs";
import { MemoryRecords } from "../src/database.mjs";
import { NpmRegistryGateway } from "../src/npm-registry-gateway.mjs";
import { RuntimeManager } from "../src/runtime-manager.mjs";
import { ChatStore } from "../src/store.mjs";
import { spawnWorker } from "../src/worker-process.mjs";
import { temporaryDirectory, testConfig } from "./helpers.mjs";

const listen = server => new Promise((resolve, reject) => {
  server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve(server.address().port));
});
const close = server => new Promise(resolve => server.close(resolve));

test("protected npm gateway swaps only a scoped capability and rewrites private tarballs", async t => {
  const upstreamToken = "npm_real-controller-only-token";
  const requests = [];
  const upstream = http.createServer((request, response) => {
    requests.push({ method: request.method, url: request.url, authorization: request.headers.authorization });
    if (request.url.includes(".tgz")) {
      response.writeHead(200, { "content-type": "application/octet-stream" }); response.end("private tarball"); return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ name: "@12-apps/state-api", versions: { "1.0.0": { dist: { tarball: `http://127.0.0.1:${upstream.address().port}/@12-apps/state-api/-/state-api-1.0.0.tgz` } } } }));
  });
  const upstreamPort = await listen(upstream); t.after(() => close(upstream));
  const gateway = new NpmRegistryGateway({ ttlMs: 10_000, upstreamBaseUrl: `http://127.0.0.1:${upstreamPort}` });
  const server = http.createServer((request, response) => gateway.handle(request, response, new URL(request.url, "http://gateway")));
  const port = await listen(server); t.after(() => { gateway.shutdown(); return close(server); });
  const origin = `http://127.0.0.1:${port}`;
  const grant = gateway.runtime("chat_fixture", origin, { token: upstreamToken, environmentId: "env_fixture", revision: 7 }, "/runtime/npm/relay.npmrc");

  assert.match(grant.token, /^cap_[A-Za-z0-9_-]{43}$/);
  assert.equal(grant.environmentVariables.NODE_AUTH_TOKEN, grant.token);
  assert.equal(grant.environmentVariables.NPM_CONFIG_REGISTRY, `${origin}/gateway/npm/`);
  assert.match(grant.config, /\$\{NODE_AUTH_TOKEN\}/);
  assert.doesNotMatch(JSON.stringify(grant), new RegExp(upstreamToken));

  const metadata = await fetch(`${origin}/gateway/npm/@12-apps%2fstate-api`, { headers: { authorization: `Bearer ${grant.token}` } });
  assert.equal(metadata.status, 200);
  const tarball = (await metadata.json()).versions["1.0.0"].dist.tarball;
  assert.equal(tarball, `${origin}/gateway/npm/@12-apps/state-api/-/state-api-1.0.0.tgz`);
  const archive = await fetch(tarball, { headers: { authorization: `Bearer ${grant.token}` } });
  assert.equal(await archive.text(), "private tarball");
  assert.deepEqual(requests.map(item => item.authorization), [`Bearer ${upstreamToken}`, `Bearer ${upstreamToken}`]);
  assert.ok(requests.every(item => !item.authorization.includes(grant.token)));

  assert.equal((await fetch(`${origin}/gateway/npm/@12-apps%2fstate-api`, { method: "POST", headers: { authorization: `Bearer ${grant.token}` } })).status, 403);
  assert.equal((await fetch(`${origin}/gateway/npm/@12-apps%2fstate-api`, { headers: { authorization: "Bearer forged" } })).status, 401);
  assert.equal(requests.length, 2);
  gateway.revokeChat("chat_fixture");
  assert.equal((await fetch(`${origin}/gateway/npm/@12-apps%2fstate-api`, { headers: { authorization: `Bearer ${grant.token}` } })).status, 401);
  assert.equal(requests.length, 2);
});

test("protected npm capability resumes only with the same encrypted environment credential", () => {
  const gateway = new NpmRegistryGateway({ ttlMs: 10_000, upstreamBaseUrl: "https://registry.npmjs.org" });
  const credential = { token: "npm_fixture", environmentId: "env_fixture", revision: 2 };
  const first = gateway.runtime("chat_fixture", "https://relay.example", credential, "/runtime/npm/relay.npmrc");
  const snapshot = gateway.suspendRuntime("chat_fixture"); gateway.revokeChat("chat_fixture");
  const restored = gateway.resumeRuntime("chat_fixture", "https://relay.example", credential, "/runtime/npm/relay.npmrc", snapshot);
  assert.equal(restored.token, first.token); assert.equal(restored.restored, true);
  gateway.revokeChat("chat_fixture");
  assert.throws(() => gateway.resumeRuntime("chat_fixture", "https://relay.example", { ...credential, token: "npm_changed", revision: 3 }, "/runtime/npm/relay.npmrc", snapshot), /unavailable/);
  gateway.shutdown();
});

test("worker setup and agent shell use private npm without receiving its protected token", async t => {
  const upstreamToken = "npm_runtime-controller-only";
  const upstreamAuthorization = [];
  const upstream = http.createServer((request, response) => {
    upstreamAuthorization.push(request.headers.authorization);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ name: "@12-apps/state-api", "dist-tags": { latest: "1.2.3" }, versions: { "1.2.3": { name: "@12-apps/state-api", version: "1.2.3", dist: { tarball: `http://127.0.0.1:${upstream.address().port}/state-api.tgz` } } } }));
  });
  const upstreamPort = await listen(upstream); t.after(() => close(upstream));
  const npmGateway = new NpmRegistryGateway({ ttlMs: 10_000, upstreamBaseUrl: `http://127.0.0.1:${upstreamPort}` });
  const gatewayServer = http.createServer((request, response) => npmGateway.handle(request, response, new URL(request.url, "http://gateway")));
  const gatewayPort = await listen(gatewayServer), gatewayOrigin = `http://127.0.0.1:${gatewayPort}`;
  t.after(() => { npmGateway.shutdown(); return close(gatewayServer); });

  const root = await temporaryDirectory(t), store = new ChatStore(root, new MemoryRecords()); await store.initialize();
  const environment = { id: "env_fixture", name: "Private npm", revision: 4, backend: "local", software: [], variables: {}, protectedKeys: ["NODE_AUTH_TOKEN"],
    setupScript: "npm view @12-apps/state-api version --json > npm-private-version.json", mcpIds: [], archived: false };
  const environments = { onSaved: null, runtime: async () => ({ ...environment }), npmCredential: async () => ({ token: upstreamToken, environmentId: environment.id, revision: environment.revision }) };
  let executor;
  const workerBackend = { acquire: async chat => (executor = {
    workspace: chat.workspace, runtimeHome: store.runtimeHome(chat.id), gatewayOrigin, metadata: { backend: "local" },
    spawn: (command, args, options) => spawnWorker(command, args, { ...options, isolation: "none" }),
    spawnAgent: (command, args, options) => spawnWorker(command, args, { ...options, isolation: "none" }),
    mkdir: directory => mkdir(directory, { recursive: true, mode: 0o700 }),
  }), sleep: async () => {}, destroy: async () => {} };
  const manager = new RuntimeManager({ store, config: testConfig(root, { AGENT_IDLE_TIMEOUT_MS: "10000" }), broker: new CapabilityBroker({ ttlMs: 10_000 }), gatewayOrigin,
    workerBackend, environments, packageRegistry: npmGateway, models: { creationSettings: async () => ({}), turnSettings: async () => ({}) },
    adapterFactory: () => ({ start: async () => {}, send: async () => ({ text: "ready" }), stop: async () => {} }) });
  t.after(() => manager.shutdown());
  const chat = await manager.createChat({ agent: "codex", title: "Private npm", environmentId: environment.id });
  await manager.send(chat.id, "start");
  assert.equal(JSON.parse(await readFile(path.join(chat.workspace, "npm-private-version.json"), "utf8")), "1.2.3");
  assert.match(executor.environmentVariables.NODE_AUTH_TOKEN, /^cap_/);
  assert.notEqual(executor.environmentVariables.NODE_AUTH_TOKEN, upstreamToken);
  const npmrc = await readFile(executor.environmentVariables.NPM_CONFIG_USERCONFIG, "utf8");
  assert.match(npmrc, /\$\{NODE_AUTH_TOKEN\}/); assert.doesNotMatch(npmrc, new RegExp(upstreamToken));
  assert.deepEqual(upstreamAuthorization, [`Bearer ${upstreamToken}`]);
  const capability = executor.environmentVariables.NODE_AUTH_TOKEN;
  await manager.stop(chat.id);
  assert.equal((await fetch(`${gatewayOrigin}/gateway/npm/@12-apps%2fstate-api`, { headers: { authorization: `Bearer ${capability}` } })).status, 401);
});
