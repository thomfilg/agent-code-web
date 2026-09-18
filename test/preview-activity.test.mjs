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
  const update = store.update.bind(store); store.update = (...args) => new Promise(resolve => { resumeUpdate = () => update(...args).then(resolve); });
  const stopping = manager.stop(chat.id); assert.equal(lease.signal.aborted, true); assert.equal(manager.previewGeneration(chat.id), 1);
  store.update = update; resumeUpdate(); await stopping;
  assert.equal(store.get(chat.id).status, "stopped");
  assert.deepEqual(store.get(chat.id).messages.map(message => message.text), ["fixture", "reply"]);
});
