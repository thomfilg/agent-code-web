import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { CapabilityBroker } from "../src/capabilities.mjs";
import { RuntimeManager } from "../src/runtime-manager.mjs";
import { ChatStore } from "../src/store.mjs";
import { MemoryRecords } from "../src/database.mjs";
import { temporaryDirectory, testConfig, waitFor } from "./helpers.mjs";

test("multiple chats stream independently, persist responses, autosleep, and restart", async (t) => {
  const root = await temporaryDirectory(t);
  const config = testConfig(path.join(root, "data"));
  const store = new ChatStore(config.dataDir);
  await store.initialize();
  const broker = new CapabilityBroker({ ttlMs: 10_000 });
  const manager = new RuntimeManager({ store, config, broker, gatewayOrigin: "http://127.0.0.1:1" });
  t.after(() => manager.shutdown());
  const events = [];
  manager.on("event", (event) => events.push(event));

  const [first, second] = await Promise.all([
    manager.createChat({ agent: "mock", title: "First" }),
    manager.createChat({ agent: "mock", title: "Second" }),
  ]);
  await Promise.all([manager.send(first.id, "alpha"), manager.send(second.id, "beta")]);

  assert.equal(store.get(first.id).status, "idle");
  assert.match(store.get(first.id).messages.at(-1).text, /alpha/);
  assert.match(store.get(second.id).messages.at(-1).text, /beta/);
  assert.notEqual(first.workspace, second.workspace);
  assert.ok(events.some((event) => event.chatId === first.id && event.type === "assistant_delta"));

  await waitFor(() => store.get(first.id).status === "stopped" && store.get(second.id).status === "stopped");
  assert.equal(store.get(second.id).status, "stopped");
  const startsBefore = events.filter((event) => event.chatId === first.id && event.type === "runtime_started").length;
  await manager.send(first.id, "wake again");
  const startsAfter = events.filter((event) => event.chatId === first.id && event.type === "runtime_started").length;
  assert.equal(startsAfter, startsBefore + 1);
  assert.match(store.get(first.id).messages.at(-1).text, /wake again/);
});

test("native schedules pause idle sleep, reconcile cancellation and never prevent explicit Stop", async t => {
  const root = await temporaryDirectory(t), config = testConfig(root), store = new ChatStore(root); await store.initialize();
  config.idleTimeoutMs = 100;
  let hooks, scheduled = true, stopped = 0;
  const manager = new RuntimeManager({ store, config, broker: new CapabilityBroker({ ttlMs: 10000 }), gatewayOrigin: "http://localhost",
    adapterFactory: params => { hooks = params.hooks; return { start: async () => {}, send: async () => ({ text: "Scheduled" }),
      hasScheduledWork: () => scheduled, stop: async () => { stopped++; } }; },
  });
  t.after(() => manager.shutdown());
  const chat = await manager.createChat({ agent: "mock" });
  await manager.send(chat.id, "Schedule a task");
  assert.equal(store.get(chat.id).idleKeepAwakeReason, "schedule"); assert.equal(store.get(chat.id).idleDeadlineAt, null);
  await new Promise(resolve => setTimeout(resolve, 160)); assert.equal(stopped, 0);
  scheduled = false; await hooks.onEvent({ type: "scheduled_work" });
  await waitFor(() => store.get(chat.id).status === "stopped"); assert.equal(stopped, 1);
  scheduled = true; await manager.send(chat.id, "Schedule again");
  assert.equal(store.get(chat.id).idleKeepAwakeReason, "schedule");
  await manager.stop(chat.id); assert.equal(stopped, 2); assert.equal(store.get(chat.id).status, "stopped");
});

test("a chat rejects a second turn while the first is active", async (t) => {
  const root = await temporaryDirectory(t);
  const config = testConfig(root);
  const store = new ChatStore(config.dataDir);
  await store.initialize();
  const manager = new RuntimeManager({ store, config, broker: new CapabilityBroker({ ttlMs: 10_000 }), gatewayOrigin: "http://127.0.0.1:1" });
  t.after(() => manager.shutdown());
  const chat = await manager.createChat({ agent: "mock", title: "Busy" });
  const first = await manager.submit(chat.id, "one");
  await assert.rejects(manager.submit(chat.id, "two"), /already has a running turn/);
  await first.completion;
});

test("native background work queues normal input and Send now interrupts only that turn", async t => {
  const root = await temporaryDirectory(t), store = new ChatStore(root); await store.initialize();
  let hooks, background = false, interrupted = 0, stopped = 0;
  const sent = [], manager = new RuntimeManager({ store, config: testConfig(root), broker: new CapabilityBroker({ ttlMs: 10000 }), gatewayOrigin: "http://localhost",
    adapterFactory: params => { hooks = params.hooks; return {
      start: async () => {}, send: async text => { sent.push(text); return { text: "Done" }; },
      hasScheduledWork: () => true, isBackgroundBusy: () => background, stop: async () => { stopped++; background = false; },
      interrupt: async () => { interrupted++; background = false; await hooks.onEvent({ type: "background_turn", active: false }); },
    }; },
  });
  t.after(() => manager.shutdown());
  const chat = await manager.createChat({ agent: "mock" }); await manager.send(chat.id, "Schedule");
  background = true; await hooks.onEvent({ type: "background_turn", active: true });
  assert.equal(manager.isBusy(chat.id), true); assert.equal(store.get(chat.id).status, "running");
  await assert.rejects(manager.submit(chat.id, "Cannot overlap"), /already has a running turn/);
  await store.update(chat.id, { queuePaused: true }); await manager.enqueue(chat.id, "Keep queued");
  const selected = await manager.enqueue(chat.id, "Send this now");
  await manager.sendQueuedNow(chat.id, selected.queuedMessages.at(-1).id);
  await waitFor(() => !manager.isBusy(chat.id));
  assert.equal(interrupted, 1); assert.equal(stopped, 0); assert.deepEqual(sent, ["Schedule", "Send this now"]);
  assert.deepEqual(store.get(chat.id).queuedMessages.map(item => item.text), ["Keep queued"]);
  assert.equal(store.get(chat.id).idleKeepAwakeReason, "schedule");
  background = true; await hooks.onEvent({ type: "background_turn", active: true });
  await manager.stop(chat.id); assert.equal(stopped, 1); assert.equal(store.get(chat.id).status, "stopped");
});

test("stopping during adapter startup never starts a late turn or resurrects working state", async t => {
  const root = await temporaryDirectory(t); const store = new ChatStore(root); await store.initialize();
  let releaseStart, sends = 0;
  const manager = new RuntimeManager({ store, config: testConfig(root), broker: new CapabilityBroker({ ttlMs: 10000 }), gatewayOrigin: "http://localhost",
    adapterFactory: () => ({ start: () => new Promise(resolve => { releaseStart = resolve; }), stop: async () => {}, send: async () => { sends++; return { text: "unexpected" }; } }),
  });
  t.after(() => manager.shutdown());
  const chat = await manager.createChat({ agent: "mock" });
  const turn = await manager.submit(chat.id, "wait");
  await waitFor(() => releaseStart);
  await manager.stop(chat.id);
  releaseStart(); await turn.completion;
  assert.equal(sends, 0); assert.equal(store.get(chat.id).status, "stopped"); assert.equal(store.get(chat.id).workflowState, "idle");
});

test("Stop revokes gateway access before awaiting slow persistence or worker shutdown", async t => {
  const root = await temporaryDirectory(t), store = new ChatStore(root); await store.initialize();
  const broker = new CapabilityBroker({ ttlMs: 10000 });
  const manager = new RuntimeManager({ store, config: testConfig(root), broker, gatewayOrigin: "http://localhost" });
  t.after(() => manager.shutdown());
  const chat = await manager.createChat({ agent: "mock" }), release = Promise.withResolvers();
  const token = broker.issue({ chatId: chat.id, provider: "anthropic", renewable: true, validWhile: () => true });
  const update = store.update.bind(store);
  store.update = async (...args) => { await release.promise; return update(...args); };
  const stopping = manager.stop(chat.id);
  try { assert.equal(broker.validate(token, "anthropic"), null); }
  finally { release.resolve(); await stopping; }
});

test("a non-mock chat acquires, sleeps, resumes, and destroys its worker backend", async (t) => {
  const root = await temporaryDirectory(t);
  const config = testConfig(root);
  const store = new ChatStore(config.dataDir);
  await store.initialize();
  const calls = [];
  const workerBackend = {
    acquire: async (chat) => {
      calls.push(["acquire", chat.id]);
      return { metadata: { backend: "fixture", workerId: "worker-1" } };
    },
    sleep: async (chat) => { calls.push(["sleep", chat.id]); },
    destroy: async (chat) => { calls.push(["destroy", chat.id]); },
  };
  const adapterFactory = ({ chat, hooks }) => ({
    start: async () => {},
    send: async (text) => {
      hooks.onEvent({ type: "assistant_delta", delta: text });
      return { text: `reply ${text}` };
    },
    stop: async () => {},
    respond: async () => {},
  });
  const manager = new RuntimeManager({
    store,
    config,
    broker: new CapabilityBroker({ ttlMs: 10_000 }),
    gatewayOrigin: "http://127.0.0.1:1",
    workerBackend,
    adapterFactory,
  });
  t.after(() => manager.shutdown());

  const chat = await manager.createChat({ agent: "codex", title: "Worker lifecycle" });
  await manager.send(chat.id, "first");
  assert.deepEqual(store.get(chat.id).runtimeMetadata, { backend: "fixture", workerId: "worker-1" });
  await waitFor(() => store.get(chat.id).status === "stopped");
  await manager.send(chat.id, "second");
  assert.equal(calls.filter(([action]) => action === "acquire").length, 2);
  await manager.remove(chat.id);
  assert.ok(calls.some(([action]) => action === "sleep"));
  assert.equal(calls.filter(([action]) => action === "destroy").length, 1);
});

test("failed worker deletion is reported as pending and retried after chat removal", async t => {
  const root = await temporaryDirectory(t), records = new MemoryRecords(), store = new ChatStore(root, records);
  await store.initialize();
  let destroyCalls = 0, releaseRetry;
  const retryGate = new Promise(resolve => { releaseRetry = resolve; });
  const manager = new RuntimeManager({ store, config: testConfig(root), broker: new CapabilityBroker({ ttlMs: 10_000 }),
    gatewayOrigin: "http://127.0.0.1:1",
    workerBackend: { acquire: async () => null, sleep: async () => {}, destroy: async () => {
      destroyCalls++;
      if (destroyCalls === 1) throw new Error("EC2 termination not confirmed");
      await retryGate;
    } },
  });
  t.after(() => { releaseRetry(); manager.shutdown(); });
  const chat = await manager.createChat({ agent: "codex", title: "Cleanup retry" });
  const result = await manager.remove(chat.id);
  assert.deepEqual(result, { removed: true, cleanupPending: true });
  assert.equal(store.get(chat.id), null);
  assert.ok(await records.get("worker-deletion-cleanup", chat.id));
  releaseRetry();
  await waitFor(async () => !(await records.get("worker-deletion-cleanup", chat.id)));
  assert.ok(destroyCalls >= 2);
});

test("concurrent and repeated chat deletion verifies worker cleanup without a false 404", async t => {
  const root = await temporaryDirectory(t), records = new MemoryRecords(), store = new ChatStore(root, records);
  await store.initialize();
  let destroyCalls = 0, releaseDestroy;
  const destroyGate = new Promise(resolve => { releaseDestroy = resolve; });
  const manager = new RuntimeManager({ store, config: testConfig(root), broker: new CapabilityBroker({ ttlMs: 10_000 }),
    gatewayOrigin: "http://127.0.0.1:1",
    workerBackend: { acquire: async () => null, sleep: async () => {}, destroy: async () => {
      destroyCalls++;
      if (destroyCalls === 1) await destroyGate;
    } },
  });
  t.after(() => { releaseDestroy(); manager.shutdown(); });
  const chat = await manager.createChat({ agent: "codex", title: "Idempotent deletion" });
  const first = manager.remove(chat.id);
  await waitFor(() => destroyCalls === 1);
  const second = manager.remove(chat.id);
  releaseDestroy();
  assert.deepEqual(await Promise.all([first, second]), [
    { removed: true, cleanupPending: false }, { removed: true, cleanupPending: false },
  ]);
  assert.equal(destroyCalls, 1);
  assert.equal(store.get(chat.id), null);
  assert.deepEqual(await manager.remove(chat.id), { removed: true, cleanupPending: false });
  assert.equal(destroyCalls, 2);
});
