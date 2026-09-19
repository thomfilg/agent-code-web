import test from "node:test";
import assert from "node:assert/strict";
import { RuntimeManager } from "../src/runtime-manager.mjs";
import { ChatStore } from "../src/store.mjs";
import { CapabilityBroker } from "../src/capabilities.mjs";
import { loadConfig } from "../src/config.mjs";
import { hibernationAdmission } from "../src/worker-suspension.mjs";
import { temporaryDirectory, testConfig, waitFor } from "./helpers.mjs";

async function fixture(t) {
  const root = await temporaryDirectory(t), store = new ChatStore(root); await store.initialize();
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
});
