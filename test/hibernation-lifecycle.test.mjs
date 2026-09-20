import test from "node:test";
import assert from "node:assert/strict";
import { RuntimeManager } from "../src/runtime-manager.mjs";
import { ChatStore } from "../src/store.mjs";
import { CapabilityBroker } from "../src/capabilities.mjs";
import { loadConfig } from "../src/config.mjs";
import { hibernationAdmission } from "../src/worker-suspension.mjs";
import { MemoryRecords } from "../src/database.mjs";
import { temporaryDirectory, testConfig, waitFor } from "./helpers.mjs";

async function fixture(t) {
  const root = await temporaryDirectory(t), store = new ChatStore(root, new MemoryRecords()); await store.initialize();
  const config = testConfig(root); config.workerBackend = "ec2";
  const calls = { acquire: 0, sleep: 0, hibernate: 0, adapterStop: 0, send: 0 };
  const manager = new RuntimeManager({ store, config, broker: new CapabilityBroker({ ttlMs: 10000 }), gatewayOrigin: "http://localhost",
    workerBackend: { acquire: async () => { calls.acquire++; return { metadata: { backend: "ec2" } }; },
      sleep: async () => { calls.sleep++; }, hibernate: async () => { calls.hibernate++; throw Error("Backend hibernation failure"); } },
    adapterFactory: () => ({ start: async () => {}, stop: async () => { calls.adapterStop++; }, send: async () => { calls.send++; return { text: "Fixture response" }; } }),
  });
  const chat = await store.create({ agent: "codex", title: "Lifecycle fixture" });
  t.after(() => manager.shutdown());
  return { store, config, calls, manager, chat };
}

test("hibernation is an explicit 2-minute policy, not an enabling capability or a changed production default", () => {
  assert.equal(loadConfig({}).idlePolicy, "stop"); assert.equal(loadConfig({}).idleTimeoutMs, 300000);
  const config = loadConfig({ AGENT_IDLE_POLICY: "hibernate", AGENT_WORKER_BACKEND: "ec2", AGENT_EC2_GATEWAY_ORIGIN: "https://fixture.invalid" });
  assert.equal(config.idlePolicy, "hibernate"); assert.equal(config.idleTimeoutMs, 120000);
  assert.throws(() => loadConfig({ AGENT_IDLE_POLICY: "hibernate" }), /requires EC2/);
  assert.throws(() => loadConfig({ AGENT_IDLE_POLICY: "restart" }), /must be one of/);
  assert.deepEqual(hibernationAdmission(), { available: false, backend: false, transport: false, image: false, reason: hibernationAdmission().reason });
});

test("unsupported policy rejects wake before acquire, repository credentials or any agent prompt", async t => {
  const f = await fixture(t); f.config.idlePolicy = "hibernate";
  await f.store.update(f.chat.id, { repositories: [{ fullName: "fixture/project", branch: "main" }] });
  f.manager.github = { tokenForRepository: () => { throw Error("Repository credentials must not be requested"); } };
  const waking = await f.manager.wake(f.chat.id);
  await assert.rejects(waking.completion, { code: "HIBERNATION_UNAVAILABLE" });
  assert.equal(f.calls.acquire, 0); assert.equal(f.calls.sleep, 0); assert.equal(f.calls.send, 0);
  assert.equal(f.store.get(f.chat.id).suspension.status, "unavailable");
  assert.deepEqual(f.store.get(f.chat.id).messages, []);
});

test("idle-only worker never falls back to stop or invokes an unproven hibernate backend; manual Stop remains separate", async t => {
  const f = await fixture(t); await f.manager.browserExecutor(f.chat.id);
  f.config.idlePolicy = "hibernate";
  await f.manager.browserIdle(f.chat.id);
  assert.equal(f.calls.sleep, 0); assert.equal(f.calls.hibernate, 0);
  assert.match(f.store.get(f.chat.id).statusDetail, /worker was not stopped/);
  assert.equal(f.store.get(f.chat.id).idleDeadlineAt, null);
  assert.equal(f.store.get(f.chat.id).idleKeepAwakeReason, "hibernation-unavailable");
  assert.equal(await f.manager.browserExecutor(f.chat.id) !== null, true); assert.equal(f.calls.acquire, 1);
  await f.manager.stop(f.chat.id); assert.equal(f.calls.sleep, 1); assert.equal(f.store.get(f.chat.id).status, "stopped");
});

test("native idle timer leaves adapter/context running and does not retry unsupported suspension in a hot loop", async t => {
  const f = await fixture(t); await f.manager.send(f.chat.id, "Fixture-only prompt"); f.config.idlePolicy = "hibernate";
  await waitFor(() => f.store.get(f.chat.id).suspension?.status === "unavailable");
  const checkedAt = f.store.get(f.chat.id).suspension.checkedAt;
  await new Promise(resolve => setTimeout(resolve, 230));
  assert.equal(f.store.get(f.chat.id).suspension.checkedAt, checkedAt);
  assert.equal(f.calls.adapterStop, 0); assert.equal(f.calls.sleep, 0); assert.equal(f.calls.hibernate, 0);
  assert.equal(f.store.get(f.chat.id).status, "idle"); assert.equal(f.calls.send, 1);
  await f.manager.stop(f.chat.id); assert.equal(f.calls.adapterStop, 1); assert.equal(f.calls.sleep, 1);
});

test("failed idle diagnostic persistence cannot enter fatal worker teardown", async t => {
  const f = await fixture(t); await f.manager.send(f.chat.id, "Fixture-only prompt"); f.config.idlePolicy = "hibernate";
  const update = f.store.update.bind(f.store); let attempted = false;
  f.store.update = async (...args) => { attempted = true; throw Error("Fixture storage unavailable"); };
  await waitFor(() => attempted);
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(f.calls.adapterStop, 0); assert.equal(f.calls.sleep, 0);
  assert.equal(f.manager.eventsSince(f.chat.id).some(event => event.type === "runtime_log" && /Worker left running/.test(event.text)), true);
  f.store.update = update;
});

test("failed admission of an already-running worker has no mutation receipt and never stops it", async t => {
  const f = await fixture(t);
  f.manager.workerBackend.acquire = async () => { throw Error("Existing image acceptance revoked"); };
  await assert.rejects(f.manager.browserExecutor(f.chat.id), /acceptance revoked/);
  assert.equal(f.calls.sleep, 0); assert.equal(f.calls.adapterStop, 0);
});

test("late mutation receipt survives cancellation and failed Stop persistence, cleaning only its exact attempt", async t => {
  const f = await fixture(t), gate = Promise.withResolvers(); let started = false, released = 0;
  f.manager.workerBackend.acquire = async (_chat, { onMutation, check }) => {
    started = true; await gate.promise;
    onMutation({ instanceId: "i-owned", release: async () => { released++; } });
    check(); return {};
  };
  const pending = f.manager.browserExecutor(f.chat.id), rejected = assert.rejects(pending, /cancelled/);
  await waitFor(() => started);
  const update = f.store.update.bind(f.store); let fail = true;
  f.store.update = async (...args) => { if (fail) { fail = false; throw Error("Fixture storage unavailable"); } return update(...args); };
  await assert.rejects(f.manager.stop(f.chat.id), /storage unavailable/);
  gate.resolve(); await rejected;
  assert.equal(released, 1); assert.equal(f.calls.sleep, 0);
});

test("failed acquired metadata persistence rolls back only the published receipt, not a later chat lookup", async t => {
  const f = await fixture(t); let released = 0;
  f.manager.workerBackend.acquire = async (_chat, { onMutation }) => {
    onMutation({ instanceId: "i-owned", release: async () => { released++; } });
    return { metadata: { backend: "ec2" } };
  };
  const update = f.store.update.bind(f.store);
  f.store.update = (id, patch) => {
    if (typeof patch === "function" && patch(f.store.get(id)).runtimeMetadata) throw Error("Fixture metadata persistence failed");
    return update(id, patch);
  };
  await assert.rejects(f.manager.browserExecutor(f.chat.id), /metadata persistence/);
  assert.equal(released, 1); assert.equal(f.calls.sleep, 0);
  assert.equal(f.store.get(f.chat.id).workerLifecycle.state, "failed");
  assert.equal(f.store.get(f.chat.id).workerLifecycle.result.cleanup, "stopped");
});

test("verified idle hibernation detaches without Stop and resumes only the exact worker identity", async t => {
  const f = await fixture(t), launchTime = "2026-09-20T12:00:00.000Z";
  const worker = { backend: "ec2", instanceId: "i-12345678", imageId: "ami-12345678", launchTime, bootId: "a".repeat(64) };
  f.config.idlePolicy = "hibernate";
  const acquisitions = [];
  f.manager.workerBackend.suspensionAdmission = async () => ({ backend: true, transport: true, image: true });
  f.manager.workerBackend.acquire = async (_chat, options) => {
    f.calls.acquire++; acquisitions.push({ action: options.action, expectedWorker: options.expectedWorker });
    return { metadata: worker, acquisitionReceipt: { mutation: options.action === "resume" ? "started" : "inspected", worker } };
  };
  f.manager.workerBackend.hibernate = async (_chat, expected) => {
    f.calls.hibernate++; assert.deepEqual(expected, worker); return { instanceId: worker.instanceId, hibernated: true };
  };
  f.manager.adapterFactory = () => ({ start: async () => {}, send: async () => ({ text: "Fixture response" }),
    isBackgroundBusy: () => false, hasScheduledWork: () => false, prepareTransportSuspend: async () => ({ retained: true, processId: "native-agent",
      capabilities: { provider: { provider: "openai", token: `cap_${"a".repeat(43)}`, credentialHash: "a".repeat(64) } } }),
    detachTransportForSuspend: async () => ({ detached: true, processId: "native-agent" }), stop: async () => { f.calls.adapterStop++; } });

  await f.manager.send(f.chat.id, "Create a retained native owner");
  await f.manager.hibernate(f.chat.id);
  let chat = f.store.get(f.chat.id);
  assert.equal(chat.status, "stopped"); assert.equal(chat.suspension.status, "hibernated");
  assert.equal(chat.suspension.nativeRetained, true); assert.equal(f.calls.hibernate, 1);
  assert.equal(f.calls.adapterStop, 0); assert.equal(f.calls.sleep, 0);
  const privateCheckpoint = await f.store.records.get("hibernation-capabilities", f.chat.id);
  assert.equal(privateCheckpoint.schema, 1); assert.equal(privateCheckpoint.agent, "codex");
  assert.equal(JSON.stringify(chat).includes("hibernation-capabilities"), false);

  const waking = await f.manager.wake(f.chat.id); await waking.completion;
  chat = f.store.get(f.chat.id);
  assert.equal(chat.suspension.status, "resumed");
  assert.deepEqual(acquisitions.map(item => item.action), ["acquire", "resume"]);
  assert.deepEqual(acquisitions[1].expectedWorker, worker);
  assert.equal(f.calls.sleep, 0);

  // Waking without starting a runtime leaves the exact native owner retained;
  // a second hibernation must preserve that fact rather than orphaning it.
  await f.manager.hibernate(f.chat.id);
  chat = f.store.get(f.chat.id);
  assert.equal(chat.suspension.status, "hibernated"); assert.equal(chat.suspension.nativeRetained, true);
  assert.equal(f.calls.hibernate, 2); assert.equal(f.calls.adapterStop, 0); assert.equal(f.calls.sleep, 0);
});

test("manual Stop resumes a hibernated worker only to terminate its retained native owner", async t => {
  const f = await fixture(t), launchTime = "2026-09-20T12:00:00.000Z";
  const worker = { backend: "ec2", instanceId: "i-87654321", imageId: "ami-87654321", launchTime, bootId: "b".repeat(64) };
  let retainedStops = 0;
  f.config.idlePolicy = "hibernate";
  f.manager.workerBackend.suspensionAdmission = async () => ({ backend: true, transport: true, image: true });
  f.manager.workerBackend.acquire = async (_chat, options) => {
    f.calls.acquire++;
    return { metadata: worker, acquisitionReceipt: { mutation: options.action === "resume" ? "started" : "inspected", worker },
      stopRetainedAgent: async () => { retainedStops++; } };
  };
  f.manager.workerBackend.hibernate = async () => { f.calls.hibernate++; return { instanceId: worker.instanceId, hibernated: true }; };
  f.manager.adapterFactory = () => ({ start: async () => {}, send: async () => ({ text: "Fixture response" }),
    isBackgroundBusy: () => false, hasScheduledWork: () => false,
    prepareTransportSuspend: async () => ({ retained: true, processId: "native-agent",
      capabilities: { provider: { provider: "openai", token: `cap_${"a".repeat(43)}`, credentialHash: "a".repeat(64) } } }),
    detachTransportForSuspend: async () => ({ detached: true, processId: "native-agent" }), stop: async () => { f.calls.adapterStop++; } });

  await f.manager.send(f.chat.id, "Retain this native owner");
  await f.manager.hibernate(f.chat.id);
  assert.equal(f.store.get(f.chat.id).suspension.nativeRetained, true);

  await f.manager.stop(f.chat.id);
  assert.equal(retainedStops, 1);
  assert.equal(f.calls.adapterStop, 0);
  assert.equal(f.calls.sleep, 1);
  assert.equal(f.store.get(f.chat.id).suspension.nativeRetained, false);
  assert.equal(f.store.get(f.chat.id).suspension.browserRetained, false);
  assert.equal(f.store.get(f.chat.id).status, "stopped");
  assert.equal(await f.store.records.get("hibernation-capabilities", f.chat.id), null);
});

test("native resume restores exact private MCP, GitHub, Browser and provider capabilities without exposing them in chat", async t => {
  const f = await fixture(t), cap = letter => `cap_${letter.repeat(43)}`;
  const tokens = { mcp: cap("m"), github: cap("g"), browser: cap("b"), provider: cap("p") };
  const calls = { mcpResume: 0, githubResume: 0, browserRestore: 0, recoveredProvider: null };
  const mcpId = "mcp_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  const mcpConfig = token => ({ relay_tools: { type: "http", url: `http://localhost/gateway/mcp/${mcpId}`, headers: { Authorization: `Bearer ${token}` } } });
  f.manager.mcps = {
    companies: true, forCompany: async () => [mcpId],
    runtime: async () => mcpConfig(tokens.mcp), suspendRuntime: () => ({ schema: 1, token: tokens.mcp, connections: [] }),
    resumeRuntime: async (_chatId, _ids, _origin, _chat, snapshot) => { assert.equal(snapshot.token, tokens.mcp); calls.mcpResume++; return mcpConfig(snapshot.token); },
    revokeChat: () => {}, restrictChat: () => {},
  };
  f.manager.githubWorkers = {
    runtime: async () => ({ token: tokens.github, environmentVariables: { RELAY_GITHUB_TOKEN: tokens.github }, repositories: [{ id: 1, fullName: "fixture/project" }] }),
    suspendRuntime: () => ({ schema: 1, token: tokens.github, fingerprint: "fixture", connections: [] }),
    resumeRuntime: async (_chatId, _origin, snapshot) => { assert.equal(snapshot.token, tokens.github); calls.githubResume++; return { token: snapshot.token, environmentVariables: { RELAY_GITHUB_TOKEN: snapshot.token }, repositories: [{ id: 1, fullName: "fixture/project" }] }; },
    revokeChat: () => {}, shutdown: () => {},
  };
  f.manager.browsers = {
    entries: new Map(), hasViewers: () => false, ensure: async () => {}, stop: async () => {}, shutdown: async () => {},
    runtime: (_chatId, _origin, options = {}) => { if (options.restoreToken) { assert.equal(options.restoreToken, tokens.browser); calls.browserRestore++; } return { relay_browser: { type: "http", url: "http://localhost/gateway/browser", headers: { Authorization: `Bearer ${options.restoreToken || tokens.browser}` } } }; },
    suspendRuntime: () => ({ schema: 1, token: tokens.browser }), detachForSuspend: async () => ({ retained: true, processId: "shared-chrome", resume: async () => {} }),
    revokeForSuspend: async () => {},
  };
  f.config.idlePolicy = "hibernate";
  f.manager.workerBackend.suspensionAdmission = async () => ({ backend: true, transport: true, image: true });
  f.manager.workerBackend.acquire = async (_chat, options) => ({ metadata: { backend: "ec2", instanceId: "i-12345678" },
    acquisitionReceipt: { mutation: options.action === "resume" ? "started" : "inspected", worker: { backend: "ec2", instanceId: "i-12345678", imageId: "ami-12345678", launchTime: "2026-09-20T12:00:00.000Z", bootId: "c".repeat(64) } } });
  f.manager.workerBackend.hibernate = async () => ({ instanceId: "i-12345678", hibernated: true });
  await f.store.update(f.chat.id, { workspaceReady: true, repositories: [{ id: 1, fullName: "fixture/project", githubConnectionId: "github_fixture", branch: "main" }] });
  f.manager.adapterFactory = ({ chat, executor }) => {
    if (chat.suspension?.nativeRetained) calls.recoveredProvider = executor.retainedCapabilities?.provider?.token;
    return { start: async () => {}, send: async () => ({ text: "Fixture response" }), isBackgroundBusy: () => false, hasScheduledWork: () => false,
      prepareTransportSuspend: async () => ({ retained: true, processId: "native-agent", capabilities: { provider: { provider: "openai", token: tokens.provider, credentialHash: "d".repeat(64) } } }),
      detachTransportForSuspend: async () => ({ detached: true, processId: "native-agent" }), stop: async () => {} };
  };

  await f.manager.send(f.chat.id, "Start exact native owner");
  await f.manager.hibernate(f.chat.id);
  const privateCheckpoint = await f.store.records.get("hibernation-capabilities", f.chat.id);
  assert.equal(privateCheckpoint.native.provider.token, tokens.provider);
  for (const token of Object.values(tokens)) assert.equal(JSON.stringify(f.store.get(f.chat.id)).includes(token), false);

  await f.manager.send(f.chat.id, "Resume exact native owner");
  assert.equal(calls.recoveredProvider, tokens.provider);
  assert.deepEqual({ mcp: calls.mcpResume, github: calls.githubResume, browser: calls.browserRestore }, { mcp: 1, github: 1, browser: 1 });
  await f.manager.stop(f.chat.id);
  assert.equal(await f.store.records.get("hibernation-capabilities", f.chat.id), null);
});
