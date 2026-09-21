import test from "node:test";
import assert from "node:assert/strict";
import { ChatStore } from "../src/store.mjs";
import { RuntimeManager } from "../src/runtime-manager.mjs";
import { CapabilityBroker } from "../src/capabilities.mjs";
import { beginWorkerLifecycle, finishWorkerLifecycle, initialWorkerLifecycle, publicControllerLease, restoreWorkerLifecycle, workerIdentity } from "../src/worker-lifecycle.mjs";
import { temporaryDirectory, testConfig } from "./helpers.mjs";

const time = second => `2026-09-20T12:00:${String(second).padStart(2, "0")}.000Z`;
const worker = { backend: "ec2", instanceId: "i-aaaaaaaaaaaaaaaaa", imageId: "ami-aaaaaaaaaaaaaaaaa", launchTime: time(0) };
const lease = { id: "lease-fixture", generation: 2, controllerId: "controller-fixture", controllerEpoch: 3, expiresAt: time(59) };

test("persisted lifecycle separates intent, observed result and exact cleanup while fencing stale callbacks", () => {
  const initial = initialWorkerLifecycle(time(0));
  const acquiring = beginWorkerLifecycle(initial, "acquire", time(1));
  assert.deepEqual([acquiring.generation, acquiring.state, acquiring.intent.action, acquiring.result], [1, "acquiring", "acquire", null]);
  const active = finishWorkerLifecycle(acquiring, { generation: 1, action: "acquire", status: "succeeded",
    mutation: "created", cleanup: "not-required", worker, controllerLease: lease }, time(2));
  assert.equal(active.state, "active"); assert.deepEqual(active.worker, worker); assert.deepEqual(active.controllerLease, lease);
  assert.deepEqual(active.result, { generation: 1, action: "acquire", status: "succeeded", mutation: "created", cleanup: "not-required", observedAt: time(2) });
  const stopping = beginWorkerLifecycle(active, "stop", time(3));
  const stale = finishWorkerLifecycle(stopping, { generation: 1, action: "acquire", status: "failed", mutation: "created", cleanup: "failed" }, time(4));
  assert.deepEqual(stale, stopping);
  const stopped = finishWorkerLifecycle(stopping, { generation: 2, action: "stop", status: "succeeded", mutation: "stopped", cleanup: "stopped" }, time(5));
  assert.equal(stopped.state, "stopped"); assert.equal(stopped.controllerLease, null); assert.deepEqual(stopped.worker, worker);
});

test("restart reconciliation never treats a saved worker or controller lease as live proof", () => {
  const active = finishWorkerLifecycle(beginWorkerLifecycle(initialWorkerLifecycle(time(0)), "acquire", time(1)), {
    generation: 1, action: "acquire", status: "succeeded", mutation: "inspected", cleanup: "not-required", worker, controllerLease: lease,
  }, time(2));
  const restored = restoreWorkerLifecycle(active, null, time(3));
  assert.equal(restored.generation, 2); assert.equal(restored.state, "unknown"); assert.equal(restored.controllerLease, null);
  assert.deepEqual(restored.intent, { action: "reconcile", generation: 2, requestedAt: time(3) });
  assert.deepEqual(restored.result, { action: "reconcile", generation: 2, status: "unknown", mutation: "inspected", cleanup: "unknown", observedAt: time(3) });
  assert.throws(() => publicControllerLease({ ...lease, credential: "private" }), /Invalid public controller lease/);
  assert.throws(() => workerIdentity({ backend: "ec2", instanceId: "i-foreign-or-malformed" }), /exact instance ID/);
  const legacy = restoreWorkerLifecycle(null, { backend: "ec2", instanceId: worker.instanceId, imageId: worker.imageId, host: "10.0.0.2" }, time(4));
  assert.equal(legacy.state, "unknown"); assert.deepEqual(legacy.worker, { backend: "ec2", instanceId: worker.instanceId, imageId: worker.imageId });
  const malformed = restoreWorkerLifecycle({ schema: 1, state: "active", credential: "private" }, null, time(5));
  assert.equal(malformed.state, "unknown"); assert.equal(malformed.result.status, "unknown");
});

test("ChatStore durably fences the previous controller generation on restart", async t => {
  const root = await temporaryDirectory(t), store = new ChatStore(root); await store.initialize();
  const chat = await store.create({ agent: "codex", title: "Lifecycle persistence" });
  await store.update(chat.id, current => ({ workerLifecycle: finishWorkerLifecycle(beginWorkerLifecycle(current.workerLifecycle, "acquire", time(1)), {
    generation: 1, action: "acquire", status: "succeeded", mutation: "started", cleanup: "not-required", worker, controllerLease: lease,
  }, time(2)), runtimeMetadata: { backend: "ec2", instanceId: worker.instanceId, imageId: worker.imageId, host: "10.0.0.2" } }));
  const restarted = new ChatStore(root); await restarted.initialize();
  const recovered = restarted.get(chat.id).workerLifecycle;
  assert.equal(recovered.state, "unknown"); assert.equal(recovered.generation, 2); assert.equal(recovered.controllerLease, null);
  const onDisk = JSON.parse(await (await import("node:fs/promises")).readFile(restarted.chatFile(chat.id), "utf8"));
  assert.equal(onDisk.workerLifecycle.state, "unknown"); assert.equal(onDisk.workerLifecycle.generation, 2);
});

test("RuntimeManager persists inspected acquisition and explicit Stop results", async t => {
  const root = await temporaryDirectory(t), store = new ChatStore(root); await store.initialize();
  const config = testConfig(root, { AGENT_IDLE_TIMEOUT_MS: "60000" }); config.workerBackend = "ec2";
  const calls = { acquire: 0, sleep: 0 };
  const manager = new RuntimeManager({ store, config, broker: new CapabilityBroker({ ttlMs: 10000 }), gatewayOrigin: "http://localhost",
    workerBackend: { acquire: async () => { calls.acquire++; return { metadata: { ...worker, host: "10.0.0.2" }, acquisitionReceipt: { mutation: "inspected", worker } }; },
      sleep: async () => { calls.sleep++; return { instanceId: worker.instanceId, stopped: true }; }, destroy: async () => {} },
    adapterFactory: () => { throw Error("No agent turn is part of this lifecycle fixture"); },
  });
  t.after(() => manager.shutdown());
  const chat = await store.create({ agent: "codex", title: "Runtime lifecycle" });
  await manager.browserExecutor(chat.id);
  let lifecycle = store.get(chat.id).workerLifecycle;
  assert.equal(lifecycle.state, "active"); assert.equal(lifecycle.result.mutation, "inspected"); assert.deepEqual(lifecycle.worker, worker);
  await manager.stop(chat.id);
  lifecycle = store.get(chat.id).workerLifecycle;
  assert.equal(lifecycle.state, "stopped"); assert.equal(lifecycle.result.action, "stop"); assert.equal(lifecycle.result.cleanup, "stopped");
  assert.deepEqual(calls, { acquire: 1, sleep: 1 });
});

test("failed acquisitions persist whether exact cleanup was unnecessary, completed or failed", async t => {
  for (const scenario of ["unmutated", "released", "cleanup-failed"]) {
    const root = await temporaryDirectory(t), store = new ChatStore(root); await store.initialize();
    const config = testConfig(root, { AGENT_IDLE_TIMEOUT_MS: "60000" }); config.workerBackend = "ec2";
    let releases = 0;
    const manager = new RuntimeManager({ store, config, broker: new CapabilityBroker({ ttlMs: 10000 }), gatewayOrigin: "http://localhost",
      workerBackend: { acquire: async (_chat, { onMutation }) => {
        if (scenario !== "unmutated") onMutation({ instanceId: worker.instanceId, mutation: "started", worker,
          release: async () => { releases++; if (scenario === "cleanup-failed") throw Error("Fixture cleanup denied"); } });
        throw Error("Fixture acquisition denied");
      }, sleep: async () => {}, destroy: async () => {} },
      adapterFactory: () => { throw Error("No agent turn expected"); },
    });
    t.after(() => manager.shutdown());
    const chat = await store.create({ agent: "codex", title: scenario });
    await assert.rejects(manager.browserExecutor(chat.id), scenario === "cleanup-failed" ? /Use Stop to retry cleanup/ : /acquisition denied/);
    const lifecycle = store.get(chat.id).workerLifecycle;
    assert.equal(lifecycle.state, "failed"); assert.equal(lifecycle.result.status, "failed");
    assert.equal(lifecycle.result.mutation, scenario === "unmutated" ? "none" : "started");
    assert.equal(lifecycle.result.cleanup, scenario === "unmutated" ? "not-required" : scenario === "released" ? "stopped" : "failed");
    assert.equal(releases, scenario === "unmutated" ? 0 : 1);
  }
});

test("a lifecycle intent persistence failure prevents backend acquisition entirely", async t => {
  const root = await temporaryDirectory(t), store = new ChatStore(root); await store.initialize();
  const config = testConfig(root, { AGENT_IDLE_TIMEOUT_MS: "60000" }); config.workerBackend = "ec2";
  let acquisitions = 0, fail = true;
  const manager = new RuntimeManager({ store, config, broker: new CapabilityBroker({ ttlMs: 10000 }), gatewayOrigin: "http://localhost",
    workerBackend: { acquire: async () => { acquisitions++; return {}; }, sleep: async () => {}, destroy: async () => {} },
    adapterFactory: () => { throw Error("No agent turn expected"); } });
  t.after(() => manager.shutdown());
  const chat = await store.create({ agent: "codex", title: "Intent failure" }), update = store.update.bind(store);
  store.update = async (id, patch) => {
    const changes = typeof patch === "function" ? patch(store.get(id)) : patch;
    if (fail && changes.workerLifecycle?.state === "acquiring") { fail = false; throw Error("Fixture intent persistence denied"); }
    return update(id, changes);
  };
  await assert.rejects(manager.browserExecutor(chat.id), /intent persistence denied/);
  assert.equal(acquisitions, 0); assert.equal(store.get(chat.id).workerLifecycle.state, "stopped");
});

test("failed Stop retains an explicit failed result instead of claiming a stopped worker", async t => {
  const root = await temporaryDirectory(t), store = new ChatStore(root); await store.initialize();
  const config = testConfig(root, { AGENT_IDLE_TIMEOUT_MS: "60000" }); config.workerBackend = "ec2";
  const manager = new RuntimeManager({ store, config, broker: new CapabilityBroker({ ttlMs: 10000 }), gatewayOrigin: "http://localhost",
    workerBackend: { acquire: async () => ({ metadata: { ...worker, host: "10.0.0.2" }, acquisitionReceipt: { mutation: "inspected", worker } }),
      sleep: async () => { throw Error("Fixture stop denied"); }, destroy: async () => {} },
    adapterFactory: () => { throw Error("No agent turn expected"); } });
  t.after(() => manager.shutdown());
  const chat = await store.create({ agent: "codex", title: "stop" }); await manager.browserExecutor(chat.id);
  await assert.rejects(manager.stop(chat.id), /stop denied/);
  const lifecycle = store.get(chat.id).workerLifecycle;
  assert.equal(lifecycle.state, "failed"); assert.equal(lifecycle.result.action, "stop");
  assert.equal(lifecycle.result.cleanup, "failed"); assert.deepEqual(lifecycle.worker, worker);
});
