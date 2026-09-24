import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { PreviewActivity } from "../src/preview-activity.mjs";
import { RuntimeManager } from "../src/runtime-manager.mjs";
import { ChatStore } from "../src/store.mjs";
import { CapabilityBroker } from "../src/capabilities.mjs";
import { temporaryDirectory, testConfig, waitFor } from "./helpers.mjs";

test("preview request leases share acquisition without starting an agent and release independently", async t => {
  const calls = [], notices = [];
  const activity = new PreviewActivity({ generation: () => 1, acquire: async id => { calls.push(id); return { id }; }, onChange: id => notices.push(id) });
  t.after(() => activity.close());
  const a = await activity.hold("chat-a", 1, new AbortController().signal);
  const b = await activity.hold("chat-a", 1, new AbortController().signal);
  assert.equal(activity.has("chat-a"), true); assert.deepEqual(calls, ["chat-a", "chat-a"]);
  a.release(); a.release(); assert.equal(a.signal.aborted, true); assert.equal(b.signal.aborted, false);
  assert.equal(activity.has("chat-a"), true); b.release(); assert.equal(activity.has("chat-a"), false);
  await Promise.resolve(); assert.ok(notices.length >= 2);
});

test("stop revokes pending acquisition and cannot admit its late executor", async t => {
  let complete, generation = 0;
  const activity = new PreviewActivity({ generation: () => generation, acquire: () => new Promise(resolve => { complete = resolve; }) });
  t.after(() => activity.close());
  const pending = activity.hold("chat-a", 0, new AbortController().signal);
  assert.equal(activity.has("chat-a"), true);
  generation++; activity.revokeChat("chat-a"); complete({});
  await assert.rejects(pending, /no longer active/); assert.equal(activity.has("chat-a"), false);
});

test("real RuntimeManager Stop waits for late cold acquisition then sleeps it without starting a model", async t => {
  const root = await temporaryDirectory(t), config = testConfig(root, { AGENT_WORKER_BACKEND: "ec2", AGENT_EC2_GATEWAY_ORIGIN: "https://gateway.fixture.example" }), store = new ChatStore(root); await store.initialize();
  const entered = Promise.withResolvers(), finishAcquire = Promise.withResolvers(), calls = [];
  let agents = 0;
  const manager = new RuntimeManager({ store, config, broker: new CapabilityBroker({ ttlMs: 10000 }),
    workerBackend: { acquire: async () => { calls.push("acquire"); entered.resolve(); await finishAcquire.promise; calls.push("acquired"); return {}; },
      sleep: async () => { calls.push("sleep"); }, destroy: async () => {} },
    adapterFactory: () => { agents++; throw new Error("No model may be started"); } });
  try {
  const chat = await store.create({ agent: "codex", title: "Cold preview fixture" });
  const hold = manager.previewActivity.hold(chat.id, manager.previewGeneration(chat.id), new AbortController().signal);
  const rejected = assert.rejects(hold, /cancelled|no longer active/); await entered.promise;
  let stopped = false; const stopping = manager.stop(chat.id).then(() => { stopped = true; });
  await waitFor(() => store.get(chat.id).status === "stopping");
  assert.equal(manager.previewActivity.has(chat.id), false); assert.equal(manager.previewGeneration(chat.id), null);
  assert.equal(stopped, false); assert.deepEqual(calls, ["acquire"]);
  finishAcquire.resolve(); await Promise.all([rejected, stopping]);
  assert.deepEqual(calls, ["acquire", "acquired", "sleep"]); assert.equal(store.get(chat.id).status, "stopped");
  assert.equal(agents, 0); assert.deepEqual(store.get(chat.id).messages, []);
  } finally { finishAcquire.resolve(); await manager.shutdown(); }
});

test("old lifecycle and cancelled or missing identity cannot acquire an executor", async t => {
  let calls = 0;
  const activity = new PreviewActivity({ generation: () => 1, acquire: async () => { calls++; } });
  t.after(() => activity.close());
  const dead = new AbortController(); dead.abort();
  for (const [generation, signal] of [[0, new AbortController().signal], [1, dead.signal], [null, new AbortController().signal], [1, null]]) {
    await assert.rejects(activity.hold("chat-a", generation, signal));
  }
  assert.equal(calls, 0);
});

test("grant cancellation and bounded timeout stop holds without traffic", async t => {
  const activity = new PreviewActivity({ generation: () => 0, acquire: async () => ({}), timeoutMs: 30 });
  t.after(() => activity.close());
  const controller = new AbortController();
  const cancelled = await activity.hold("chat-a", 0, controller.signal);
  const expired = await activity.hold("chat-b", 0, new AbortController().signal);
  controller.abort(); assert.equal(cancelled.signal.aborted, true); assert.equal(activity.has("chat-a"), false);
  await delay(70); assert.equal(expired.signal.aborted, true); assert.equal(activity.has("chat-b"), false);
});

test("capacity is per chat and acquisition errors do not retain a lease", async t => {
  let calls = 0;
  const activity = new PreviewActivity({ generation: () => 0, maxPerChat: 1, acquire: async id => { calls++; if (id === "bad") throw new Error("failed"); return {}; } });
  t.after(() => activity.close());
  const held = await activity.hold("chat-a", 0, new AbortController().signal);
  await assert.rejects(activity.hold("chat-a", 0, new AbortController().signal), { statusCode: 429 }); assert.equal(calls, 1);
  await assert.rejects(activity.hold("bad", 0, new AbortController().signal), /failed/); assert.equal(activity.has("bad"), false);
  held.release(); const next = await activity.hold("chat-a", 0, new AbortController().signal); next.release();
});

test("owner chat revocation leaves other chat alive and close is irreversible", async t => {
  const activity = new PreviewActivity({ generation: () => 0, acquire: async () => ({}) });
  t.after(() => activity.close());
  const a = await activity.hold("chat-a", 0, new AbortController().signal), b = await activity.hold("chat-b", 0, new AbortController().signal);
  activity.revokeChat("chat-a"); assert.equal(a.signal.aborted, true); assert.equal(b.signal.aborted, false);
  activity.close(); assert.equal(b.signal.aborted, true);
  await assert.rejects(activity.hold("chat-c", 0, new AbortController().signal));
});

test("runtime preview holds prevent idle sleep, never start a model, and Stop revokes before persistence", async t => {
  const root = await temporaryDirectory(t), config = testConfig(root), store = new ChatStore(root); await store.initialize();
  let starts = 0, acquired = 0;
  const manager = new RuntimeManager({ store, config, broker: new CapabilityBroker({ ttlMs: 10000 }),
    workerBackend: { acquire: async () => { acquired++; return {}; }, sleep: async () => {}, destroy: async () => {} },
    adapterFactory: () => ({ start: async () => { starts++; }, send: async () => ({ text: "reply" }), stop: async () => {} }) });
  t.after(() => manager.shutdown());
  const chat = await manager.createChat({ agent: "mock" });
  const lease = await manager.previewActivity.hold(chat.id, manager.previewGeneration(chat.id), new AbortController().signal);
  await manager.browserIdle(chat.id); assert.equal(lease.signal.aborted, false); assert.equal(starts, 0); assert.equal(acquired, 1);
  assert.deepEqual(store.get(chat.id).messages, []);
  await manager.send(chat.id, "fixture"); await waitFor(() => store.get(chat.id).idleKeepAwakeReason === "preview");
  await delay(150); assert.equal(store.get(chat.id).status, "idle"); assert.equal(starts, 1);
  let resumeUpdate;
  const update = store.update.bind(store); let gated = false;
  store.update = (...args) => { if (gated) return update(...args); gated = true; return new Promise(resolve => { resumeUpdate = () => update(...args).then(resolve); }); };
  const stopping = manager.stop(chat.id); assert.equal(lease.signal.aborted, true); assert.equal(manager.previewGeneration(chat.id), null);
  await assert.rejects(manager.previewActivity.hold(chat.id, 1, new AbortController().signal));
  store.update = update; resumeUpdate(); await stopping;
  assert.equal(store.get(chat.id).status, "stopped");
  assert.equal(manager.previewGeneration(chat.id), 1);
  assert.deepEqual(store.get(chat.id).messages.map(message => message.text), ["fixture", "reply"]);
});

test("verified runtime restart restores preview admission after fatal error without reviving an old lease", async t => {
  const root = await temporaryDirectory(t), config = testConfig(root, { AGENT_IDLE_TIMEOUT_MS: "60000" }), store = new ChatStore(root); await store.initialize();
  const adapters = [];
  const manager = new RuntimeManager({ store, config, broker: new CapabilityBroker({ ttlMs: 10000 }),
    workerBackend: { acquire: async () => ({}), sleep: async () => {}, destroy: async () => {} },
    adapterFactory: ({ hooks }) => { const adapter = { hooks, start: async () => {}, send: async () => ({ text: "fixture reply" }), stop: async () => {} }; adapters.push(adapter); return adapter; } });
  // temporaryDirectory's cleanup hook is registered first; stop all writers
  // before returning (including assertion failures), not in a later hook.
  try {
  const chat = await manager.createChat({ agent: "mock" }); await manager.send(chat.id, "first fixture");
  const old = await manager.previewActivity.hold(chat.id, manager.previewGeneration(chat.id), new AbortController().signal);
  await adapters[0].hooks.onFatal(Error("fixture failure"));
  assert.equal(old.signal.aborted, true); assert.equal(manager.previewGeneration(chat.id), null);
  await manager.send(chat.id, "restart fixture");
  assert.equal(adapters.length, 2); assert.equal(manager.previewGeneration(chat.id), 1);
  const fresh = await manager.previewActivity.hold(chat.id, 1, new AbortController().signal);
  assert.equal(fresh.signal.aborted, false); assert.equal(old.signal.aborted, true); fresh.release();
  } finally { await manager.shutdown(); }
});

test("Stop during final startup persistence cannot announce or restore a cancelled preview runtime", async t => {
  const root = await temporaryDirectory(t), config = testConfig(root, { AGENT_IDLE_TIMEOUT_MS: "60000" }), store = new ChatStore(root); await store.initialize();
  const adapters = [], events = [], ready = Promise.withResolvers(), finishReady = Promise.withResolvers(), stopStarted = Promise.withResolvers(), finishStop = Promise.withResolvers();
  const manager = new RuntimeManager({ store, config, broker: new CapabilityBroker({ ttlMs: 10000 }),
    workerBackend: { acquire: async () => ({}), sleep: async () => {}, destroy: async () => {} },
    adapterFactory: ({ hooks }) => {
      const index = adapters.length, adapter = { hooks, start: async () => {}, send: async () => ({ text: "fixture reply" }),
        stop: async () => { if (index === 1) { stopStarted.resolve(); await finishStop.promise; } } }; adapters.push(adapter); return adapter;
    } });
  t.after(async () => { finishReady.resolve(); finishStop.resolve(); await manager.shutdown(); });
  manager.on("event", event => events.push(event));
  const chat = await manager.createChat({ agent: "mock" }); await manager.send(chat.id, "first fixture");
  await adapters[0].hooks.onFatal(Error("fixture failure")); assert.equal(manager.previewGeneration(chat.id), null);
  const update = store.update.bind(store); let gate = true;
  store.update = async (...args) => { const value = await update(...args); if (gate && value?.statusDetail === "Runtime ready") { gate = false; ready.resolve(); await finishReady.promise; } return value; };
  const restarting = manager.send(chat.id, "cancelled restart fixture"); await ready.promise;
  const stopping = manager.stop(chat.id); await stopStarted.promise;
  assert.equal(manager.previewGeneration(chat.id), null); finishReady.resolve();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(manager.previewGeneration(chat.id), null);
  assert.equal(events.filter(event => event.type === "runtime_started").length, 1);
  finishStop.resolve(); await Promise.all([stopping, restarting]); store.update = update;
  assert.equal(events.filter(event => event.type === "runtime_started").length, 1);
  assert.equal(manager.previewGeneration(chat.id), 2, "a completed Stop still permits an explicit later open");
});
