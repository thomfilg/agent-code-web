import assert from "node:assert/strict";
import test from "node:test";
import { mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { CodexAdapter } from "../src/adapters/codex.mjs";
import { ClaudeAdapter } from "../src/adapters/claude.mjs";
import { RuntimeManager } from "../src/runtime-manager.mjs";
import { GitHubWorkerGateway } from "../src/github-worker-gateway.mjs";
import { GitHubConnection } from "../src/github.mjs";
import { UserServices } from "../src/user-services.mjs";
import { CapabilityBroker } from "../src/capabilities.mjs";
import { ChatStore } from "../src/store.mjs";
import { openDatabase } from "../src/database.mjs";
import { createAgentWebServer } from "../src/server.mjs";
import { temporaryDirectory, testConfig, waitFor } from "./helpers.mjs";

const repo = { id: 31, fullName: "company/project", githubConnectionId: "selected", branch: "feature", defaultBranch: "main" };
const connection = { id: "selected", token: "synthetic-controller-only-secret", revision: 1 };
async function fixture(t, { adapterStart, adapterCreate } = {}) {
  const root = await temporaryDirectory(t), store = new ChatStore(root); await store.initialize();
  const captures = [], calls = [], config = testConfig(root, { AGENT_IDLE_TIMEOUT_MS: "60000" });
  const github = { queue: Promise.resolve(), requireConnection: async options => {
    assert.equal(options.connectionId, repo.githubConnectionId); assert.equal(options.repository, repo.fullName);
    return { ...connection };
  } };
  const services = { github, environments: { runtime: async () => ({ id: "fixture", backend: "local", variables: { PUBLIC_VALUE: "kept", GIT_CONFIG_COUNT: "999" }, software: [], setupScript: 'test -z "$RELAY_MCP_CAPABILITY_0" && test "$GIT_CONFIG_COUNT" = 999' }) }, mcps: { runtime: async () => ({}) } };
  const gateway = new GitHubWorkerGateway({ store, servicesFor: async () => services });
  const manager = new RuntimeManager({ store, config, githubWorkers: gateway, broker: new CapabilityBroker({ ttlMs: 10000 }), gatewayOrigin: "http://localhost",
    resources: { forOwner: async () => services, isLegacy: () => true, githubForMonitor: () => null, revokeChat: () => {} },
    workerBackend: { acquire: async chat => { await mkdir(chat.workspace, { recursive: true }); await mkdir(store.runtimeHome(chat.id), { recursive: true }); return { workspace: chat.workspace, runtimeHome: store.runtimeHome(chat.id), metadata: { backend: "fixture" }, mkdir: directory => mkdir(directory, { recursive: true }), spawn, gatewayOrigin: "https://relay.example" }; }, sleep: async () => {}, destroy: async () => {} },
    adapterFactory: options => { captures.push(options); adapterCreate?.(); return { start: async () => { await adapterStart?.(); }, send: async () => ({ text: "Done" }), stop: async () => { calls.push("stop"); } }; },
  });
  t.after(() => manager.shutdown());
  const create = async (agent = "codex", overrides = {}) => {
    const chat = await store.create({ agent, title: "Scoped Git", ownerId: "owner", repositories: [repo], ...overrides });
    return store.update(chat.id, { workspaceReady: true });
  };
  return { store, manager, gateway, captures, calls, create };
}

test("both providers receive ephemeral selected Git + MCP access after setup; stop and resume rotate it", async t => {
  const f = await fixture(t);
  for (const agent of ["codex", "claude"]) {
    const chat = await f.create(agent, { environmentId: "fixture" }); await f.manager.send(chat.id, "First");
    const first = f.captures.at(-1).executor, token = [...first.capabilitySecrets][0];
    assert.equal(first.environmentVariables.PUBLIC_VALUE, "kept"); assert.notEqual(first.environmentVariables.GIT_CONFIG_COUNT, "999");
    assert.ok(Object.values(first.environmentVariables).includes(`Authorization: Bearer ${token}`));
    assert.equal(first.mcpServers.relay_github.headers.Authorization, `Bearer ${token}`);
    assert.equal(first.mcpServers.relay_github.url, "https://relay.example/gateway/github/mcp");
    assert.equal((await f.gateway.listRepositories(token))[0].id, repo.id);
    assert.doesNotMatch(JSON.stringify([f.store.get(chat.id), f.manager.eventsSince(chat.id)]), new RegExp(`${token}|${connection.token}`));
    const paused = Promise.withResolvers(), update = f.store.update.bind(f.store);
    f.store.update = async (...args) => { await paused.promise; return update(...args); };
    const stopping = f.manager.stop(chat.id);
    await assert.rejects(f.gateway.listRepositories(token)); // before any awaited persistence
    paused.resolve(); await stopping; f.store.update = update;
    await f.manager.send(chat.id, "Resume");
    const next = [...f.captures.at(-1).executor.capabilitySecrets][0];
    assert.notEqual(next, token); await assert.rejects(f.gateway.listRepositories(token));
    await f.gateway.listRepositories(next);
    await f.manager.remove(chat.id); await assert.rejects(f.gateway.listRepositories(next));
  }
});

test("browser-only acquisition issues no GitHub grant, and unrelated chats survive another chat stopping", async t => {
  const f = await fixture(t), a = await f.create(), b = await f.create("claude");
  const executor = await f.manager.browserExecutor(a.id); assert.equal(executor.capabilitySecrets, undefined); assert.equal(f.gateway.entries.size, 0);
  await Promise.all([f.manager.send(a.id, "A"), f.manager.send(b.id, "B")]);
  const token = [...f.captures.find(value => value.chat.id === b.id).executor.capabilitySecrets][0];
  await f.manager.stop(a.id); await f.gateway.listRepositories(token);
  await f.store.update(b.id, { archived: true }); await assert.rejects(f.gateway.listRepositories(token));
});

test("a grant awaiting startup cannot outlive Stop or start a late adapter", async t => {
  const f = await fixture(t), chat = await f.create(), gate = Promise.withResolvers();
  const runtime = f.gateway.runtime.bind(f.gateway); let issued;
  f.gateway.runtime = async (...args) => { issued = await runtime(...args); await gate.promise; return issued; };
  const turn = await f.manager.submit(chat.id, "wait"); await waitFor(() => issued);
  await f.manager.stop(chat.id); await assert.rejects(f.gateway.listRepositories(issued.token));
  gate.resolve(); await turn.completion;
  assert.equal(f.captures.length, 0); assert.equal(f.store.get(chat.id).status, "stopped");
});

test("adapter construction/start failures and shutdown revoke all issued GitHub access", async t => {
  for (const key of ["adapterCreate", "adapterStart"]) {
    const f = await fixture(t, { [key]: () => { throw Error("fixture startup failed"); } }), chat = await f.create();
    await f.manager.send(chat.id, "fail");
    assert.equal(f.store.get(chat.id).status, "error"); assert.equal(f.gateway.entries.size, 0);
  }
  const f = await fixture(t), chat = await f.create(); await f.manager.send(chat.id, "start");
  const token = [...f.captures[0].executor.capabilitySecrets][0]; await f.manager.shutdown(); await assert.rejects(f.gateway.listRepositories(token));
});

test("late fatal from a stopped adapter cannot revoke a resumed grant; the current adapter still can", async t => {
  const f = await fixture(t), chat = await f.create();
  await f.manager.send(chat.id, "A"); const previous = f.captures.at(-1);
  await f.manager.stop(chat.id); await f.manager.send(chat.id, "B");
  const current = f.captures.at(-1), token = [...current.executor.capabilitySecrets][0];
  await previous.hooks.onFatal(Error("late old process exit"));
  await f.gateway.listRepositories(token); assert.equal(f.store.get(chat.id).status, "idle");
  assert.equal(f.calls.length, 1);
  await current.hooks.onFatal(Error("current process exit"));
  await assert.rejects(f.gateway.listRepositories(token)); assert.equal(f.store.get(chat.id).status, "error"); assert.equal(f.calls.length, 2);
});

test("aggregated browser and selected MCP grants join redaction even without a GitHub repository", async t => {
  const f = await fixture(t), chat = await f.create("codex", { repositories: [] });
  const token = `cap_${"b".repeat(43)}`;
  f.manager.browsers = { runtime: (_id, origin) => ({ relay_browser: { type: "http", url: `${origin}/gateway/browser`, headers: { Authorization: `Bearer ${token}` } } }), stop: async () => {}, shutdown: async () => {}, hasViewers: () => false };
  await f.manager.send(chat.id, "Browser only");
  assert.deepEqual([...f.captures[0].executor.capabilitySecrets], [token]);
});

test("UserServices revocation hooks never cross named owners sharing the same connection id", async t => {
  const root = await temporaryDirectory(t), store = new ChatStore(root); await store.initialize();
  await store.create({ agent: "mock", ownerId: "legacy" }); await store.create({ agent: "mock", ownerId: "other" });
  const calls = [], legacy = { github: {}, mcps: {} };
  const config = testConfig(root), records = await openDatabase(config.database); t.after(() => records.close());
  const resources = new UserServices({ records, store, config, identity: { enabled: true, legacyOwnerId: "legacy" }, legacy, githubChanged: (...args) => calls.push(args) });
  legacy.github.onChange("same"); assert.deepEqual(calls, [[null, "same"], ["legacy", "same"]]); calls.length = 0;
  const other = await resources.forOwner("other"); other.github.onChange("same"); assert.deepEqual(calls, [["other", "same"]]);
  await other.github.close();
});

test("HTTP gateway is independently capability-authenticated: user cookies alone and cross-origin calls fail", async t => {
  const root = await temporaryDirectory(t), github = { queue: Promise.resolve(), requireConnection: async () => ({ ...connection }) };
  const app = await createAgentWebServer({ config: testConfig(root, { AGENT_WEB_AUTH_TOKEN: "synthetic-browser-password" }), github });
  t.after(() => app.stop()); const { url } = await app.start();
  const chat = await app.store.create({ agent: "codex", repositories: [repo], workspaceReady: true });
  const grant = await app.manager.githubWorkers.runtime(chat.id, url);
  const post = headers => fetch(`${url}/gateway/github/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) });
  assert.equal((await post({})).status, 401);
  assert.equal((await post({ cookie: "agent_auth=synthetic-browser-password" })).status, 401);
  assert.equal((await post({ authorization: `Bearer ${grant.token}`, origin: url })).status, 403);
  const response = await post({ authorization: `Bearer ${grant.token}` }); assert.equal(response.status, 200); assert.equal((await response.json()).result.tools.length, 2);
  app.manager.githubWorkers.revokeChat(chat.id); assert.equal((await post({ authorization: `Bearer ${grant.token}` })).status, 401);
});

test("real named-service mutation hooks abort only that owner's work before durable save; reconnect admission waits for it", async t => {
  const root = await temporaryDirectory(t), config = testConfig(root), records = await openDatabase(config.database), store = new ChatStore(root, records); await store.initialize();
  const legacy = { github: new GitHubConnection({ records, config: config.github }), mcps: {} };
  const resources = new UserServices({ records, config, store, legacy, identity: { enabled: true, legacyOwnerId: "legacy" },
    githubChanged: (ownerId, id) => gateway.revokeConnection(ownerId, id) });
  const gateway = new GitHubWorkerGateway({ store, servicesFor: chat => resources.forOwner(chat.ownerId) });
  t.after(async () => { gateway.shutdown(); for (const entry of resources.all()) await entry.github.close(); await records.close(); });
  const chats = {}, grants = {}, services = {};
  for (const ownerId of ["legacy", "alice", "bob"]) {
    const service = services[ownerId] = await resources.forOwner(ownerId);
    await (service.records || records).put("connection", "github", { id: "github", token: `synthetic-${ownerId}-private-token`, revision: 1, name: "Selected", companies: ["company"] });
    service.github.fetch = async () => Response.json({ id: repo.id, full_name: repo.fullName });
    const chat = chats[ownerId] = await store.create({ agent: "codex", ownerId, repositories: [{ ...repo, githubConnectionId: "github" }] });
    grants[ownerId] = await gateway.runtime(chat.id, "https://relay.example");
  }
  const began = Promise.withResolvers(); let aborted = false;
  const active = gateway.withRepository(grants.alice.token, repo.id, async ({ signal }) => {
    began.resolve(); await new Promise(resolve => signal.addEventListener("abort", () => { aborted = true; resolve(); }, { once: true }));
  }); const rejected = assert.rejects(active); await began.promise;
  const write = Promise.withResolvers(), entered = Promise.withResolvers(), put = records.put.bind(records);
  records.put = async (kind, ...args) => { if (kind === "user:alice:connection") { entered.resolve(); await write.promise; } return put(kind, ...args); };
  const saving = services.alice.github.update({ id: "github", revision: 1, name: "Renamed", companies: ["company"] });
  assert.equal(aborted, true); await entered.promise;
  await assert.rejects(gateway.listRepositories(grants.alice.token));
  await gateway.listRepositories(grants.bob.token); await gateway.listRepositories(grants.legacy.token);
  let ready = false;
  const restarting = gateway.runtime(chats.alice.id, "https://relay.example").then(value => { ready = true; return value; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(ready, false);
  write.resolve(); await saving; await rejected; const next = await restarting;
  assert.notEqual(next.token, grants.alice.token); await gateway.listRepositories(next.token);
  const disconnecting = services.bob.github.disconnect("github"); await assert.rejects(gateway.listRepositories(grants.bob.token)); await disconnecting;
  await gateway.listRepositories(next.token); await gateway.listRepositories(grants.legacy.token);
});

test("server → local executor → both native adapters persist only sanitized Git/browser capability output", async t => {
  const root = await temporaryDirectory(t), instances = [];
  const config = testConfig(root, { AGENT_IDLE_TIMEOUT_MS: "60000", CODEX_BIN: path.resolve("test/fixtures/fake-codex.mjs"), CLAUDE_BIN: path.resolve("test/fixtures/fake-claude-secret.mjs") });
  const app = await createAgentWebServer({ config, models: { turnSettings: async () => ({}) }, adapterFactory: options => {
    const Adapter = options.chat.agent === "codex" ? CodexAdapter : ClaudeAdapter;
    const adapter = new Adapter({ ...options, config, store: app.store, broker: app.broker }); instances.push(adapter); return adapter;
  } });
  t.after(() => app.stop()); await app.start();
  await app.records.put("connection", "github", { id: "github", token: "controller-private-fixture-not-for-worker", revision: 1, companies: ["company"] });
  for (const provider of ["codex", "claude"]) {
    const chat = await app.store.create({ agent: provider, title: "Real adapters fixture", repositories: [{ ...repo, githubConnectionId: "github" }] });
    await app.store.update(chat.id, { workspaceReady: true }); await mkdir(chat.workspace, { recursive: true });
    const turn = await app.manager.submit(chat.id, "all-capabilities");
    if (provider === "codex") {
      await waitFor(() => app.store.get(chat.id).pendingRequest);
      const adapter = instances.at(-1), params = { threadId: adapter.threadId, turnId: adapter.current.turnId }, notifications = [];
      for (const token of adapter.executor.capabilitySecrets) for (const delta of [token.slice(0, 12), token.slice(12) + " "]) notifications.push({ method: "item/agentMessage/delta", params: { ...params, delta } });
      notifications.push({ method: "turn/completed", params: { ...params, turn: { id: params.turnId, status: "completed" } } });
      await adapter.rpc.request("fixture/notifications", { notifications, complete: true });
    }
    await turn.completion;
    const executor = instances.at(-1).executor, token = executor.mcpServers.relay_github.headers.Authorization.slice(7);
    assert.equal(executor.capabilitySecrets.size, 2);
    const persisted = JSON.stringify([app.store.get(chat.id), app.manager.eventsSince(chat.id)]);
    for (const secret of executor.capabilitySecrets) assert.ok(!persisted.includes(secret));
    assert.ok(!persisted.includes("controller-private-fixture-not-for-worker"));
    assert.match(app.store.get(chat.id).messages.at(-1).text, /\[redacted\]/);
    await app.manager.githubWorkers.listRepositories(token);
    await app.manager.stop(chat.id); await assert.rejects(app.manager.githubWorkers.listRepositories(token));
  }
});
