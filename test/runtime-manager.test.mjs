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

test("a message accepted while idle Stop is finishing wakes and drains instead of becoming a paused queue", async t => {
  const root = await temporaryDirectory(t), store = new ChatStore(root); await store.initialize();
  const stopping = Promise.withResolvers(), calls = []; let stopEntered = false;
  const manager = new RuntimeManager({ store, config: testConfig(root), broker: new CapabilityBroker({ ttlMs: 10000 }), gatewayOrigin: "http://localhost",
    adapterFactory: () => ({ start: async () => {}, send: async text => { calls.push(text); return { text: "Done" }; }, stop: () => { stopEntered = true; return stopping.promise; } }),
  });
  t.after(() => manager.shutdown());
  const chat = await manager.createChat({ agent: "mock" }); await manager.send(chat.id, "first");
  const idleStop = manager.stop(chat.id, "idle-timeout"); await waitFor(() => stopEntered);
  await manager.enqueue(chat.id, "arrived during idle stop");
  assert.equal(store.get(chat.id).queuePaused, false);
  stopping.resolve(); await idleStop;
  await waitFor(() => calls.length === 2 && !manager.isBusy(chat.id));
  assert.deepEqual(calls, ["first", "arrived during idle stop"]);
  assert.equal(store.get(chat.id).queuePaused, false); assert.deepEqual(store.get(chat.id).queuedMessages, []);
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
  assert.equal(interrupted, 1); assert.equal(stopped, 0); assert.deepEqual(sent, ["Schedule", "Send this now\n\n---\n\nKeep queued"]);
  assert.deepEqual(store.get(chat.id).queuedMessages, []);
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

test("an active EC2 chat resizes its existing worker and wakes on the selected machine size", async t => {
  const root = await temporaryDirectory(t), config = testConfig(root), store = new ChatStore(root); await store.initialize();
  config.workerBackend = "ec2";
  const calls = [];
  const workerBackend = {
    acquire: async chat => { calls.push(["acquire", chat.workerInstanceType]); return { metadata: { backend: "ec2", instanceId: "i-fixture", instanceType: chat.workerInstanceType } }; },
    sleep: async chat => { calls.push(["sleep", chat.workerInstanceType]); return { instanceId: "i-fixture", stopped: true }; },
    resize: async (chat, instanceType) => { calls.push(["resize", instanceType]); return { instanceId: "i-fixture", instanceType, resized: true }; },
    destroy: async () => {},
  };
  const manager = new RuntimeManager({ store, config, broker: new CapabilityBroker({ ttlMs: 10_000 }), gatewayOrigin: "http://localhost", workerBackend,
    adapterFactory: () => ({ start: async () => {}, send: async () => ({ text: "ready" }), stop: async () => {} }) });
  t.after(() => manager.shutdown());
  const chat = await manager.createChat({ agent: "codex" });
  await manager.send(chat.id, "start");
  const accepted = await manager.resizeWorker(chat.id, "m7i.xlarge");
  assert.equal(accepted.workerResize.status, "resizing");
  assert.equal(accepted.workerInstanceType, "m7i.xlarge");
  await waitFor(() => store.get(chat.id).workerResize?.status === "completed");
  assert.deepEqual(calls.filter(([action]) => ["sleep", "resize"].includes(action)), [["sleep", "m7i.xlarge"], ["resize", "m7i.xlarge"]]);
  assert.deepEqual(calls.filter(([action]) => action === "acquire").map(([, type]) => type), ["t3.medium", "m7i.xlarge"]);
  assert.equal(store.get(chat.id).runtimeMetadata.instanceType, "m7i.xlarge");
  assert.equal(store.get(chat.id).queuePaused, false);
  assert.equal(store.get(chat.id).status, "idle");
});

test("a failed EC2 resize restores the previous size and wakes the chat instead of leaving it stopped", async t => {
  const root = await temporaryDirectory(t), config = testConfig(root), store = new ChatStore(root); await store.initialize();
  config.workerBackend = "ec2";
  const acquisitions = [];
  const manager = new RuntimeManager({ store, config, broker: new CapabilityBroker({ ttlMs: 10_000 }), gatewayOrigin: "http://localhost",
    workerBackend: {
      resize: async () => { throw new Error("fixture resize denied"); },
      acquire: async chat => { acquisitions.push(chat.workerInstanceType); return { metadata: { backend: "ec2", instanceId: "i-fixture", instanceType: chat.workerInstanceType } }; },
      sleep: async () => ({ instanceId: "i-fixture", stopped: true }), destroy: async () => {},
    },
    adapterFactory: () => ({ start: async () => {}, send: async () => ({ text: "ready" }), stop: async () => {} }) });
  t.after(() => manager.shutdown());
  const chat = await manager.createChat({ agent: "codex" });
  await manager.resizeWorker(chat.id, "m7i.xlarge");
  await waitFor(() => store.get(chat.id).workerResize?.status === "failed" && store.get(chat.id).status === "idle");
  assert.equal(store.get(chat.id).workerInstanceType, "t3.medium");
  assert.equal(store.get(chat.id).workerResize.instanceType, "m7i.xlarge");
  assert.deepEqual(acquisitions, ["t3.medium"]);
  assert.equal(store.get(chat.id).queuePaused, false);
});

test("Stop releases a hung turn, settles its tools, and lets a stopped EC2 worker resize", async t => {
  const root = await temporaryDirectory(t), config = testConfig(root), store = new ChatStore(root); await store.initialize();
  config.workerBackend = "ec2";
  let hooks, sleeps = 0;
  const manager = new RuntimeManager({ store, config, broker: new CapabilityBroker({ ttlMs: 10_000 }), gatewayOrigin: "http://localhost",
    workerBackend: {
      acquire: async chat => ({ metadata: { backend: "ec2", instanceId: "i-12345678", instanceType: chat.workerInstanceType || "t3.medium" } }),
      sleep: async () => { sleeps++; return { instanceId: "i-12345678", stopped: true }; },
      resize: async (_chat, instanceType) => ({ instanceId: "i-12345678", instanceType, resized: true }), destroy: async () => {},
    },
    adapterFactory: params => { hooks = params.hooks; return { start: async () => {}, stop: async () => {},
      send: async () => { await hooks.onEvent({ type: "tool", itemId: "hung-command", tool: "command", title: "pnpm install", state: "running" }); return new Promise(() => {}); } }; },
  });
  t.after(() => manager.shutdown());
  const chat = await manager.createChat({ agent: "codex" });
  await manager.submit(chat.id, "start a command");
  await waitFor(() => store.get(chat.id).messages.some(message => message.meta?.itemId === "hung-command"));
  await manager.stop(chat.id);
  assert.equal(store.get(chat.id).status, "stopped");
  assert.equal(manager.isBusy(chat.id), false);
  assert.deepEqual(store.get(chat.id).messages.find(message => message.meta?.itemId === "hung-command").meta,
    { type: "tool", itemId: "hung-command", tool: "command", title: "pnpm install", state: "completed", interrupted: true, resultMissing: true });
  await manager.resizeWorker(chat.id, "m7i.xlarge");
  await waitFor(() => store.get(chat.id).workerResize?.status === "completed");
  assert.equal(store.get(chat.id).status, "idle");
  assert.equal(store.get(chat.id).runtimeMetadata.instanceType, "m7i.xlarge");
  assert.equal(sleeps, 2, "manual Stop and stopped-state resize both verify the physical EC2 state");
});

test("controller startup verifies persisted EC2 workers are physically stopped before reporting ready", async t => {
  const root = await temporaryDirectory(t), config = testConfig(root), store = new ChatStore(root); await store.initialize();
  config.workerBackend = "ec2";
  const chat = await store.create({ agent: "codex", title: "Restored worker" });
  await store.update(chat.id, { runtimeMetadata: { backend: "ec2", instanceId: "i-12345678", instanceType: "t3.large" } });
  const hibernated = await store.create({ agent: "codex", title: "Retained hibernation" });
  await store.update(hibernated.id, { runtimeMetadata: { backend: "ec2", instanceId: "i-87654321", instanceType: "t3.large" },
    suspension: { status: "hibernated", nativeRetained: true } });
  let sleeps = 0;
  const manager = new RuntimeManager({ store, config, broker: new CapabilityBroker({ ttlMs: 10_000 }), gatewayOrigin: "http://localhost",
    workerBackend: { sleep: async () => { sleeps++; return { instanceId: "i-12345678", stopped: true }; }, destroy: async () => {} },
    adapterFactory: () => assert.fail("startup reconciliation must not start an agent") });
  t.after(() => manager.shutdown());
  await manager.reconcileStoppedWorkers();
  const reconciled = store.get(chat.id);
  assert.equal(sleeps, 1); assert.equal(reconciled.status, "stopped");
  assert.equal(reconciled.statusDetail, "Machine stop verified after control plane restart");
  assert.equal(reconciled.workerLifecycle.state, "stopped");
  assert.equal(reconciled.workerLifecycle.result.cleanup, "stopped");
  assert.equal(store.get(hibernated.id).suspension.status, "hibernated", "verified hibernation survives a controller restart");
});

test("background EC2 reconciliation reports stopping before a slow provider confirmation", async t => {
  const root = await temporaryDirectory(t), config = testConfig(root), store = new ChatStore(root); await store.initialize();
  config.workerBackend = "ec2";
  const chat = await store.create({ agent: "codex", title: "Slow restored worker" });
  await store.update(chat.id, { runtimeMetadata: { backend: "ec2", instanceId: "i-12345678", instanceType: "t3.large" } });
  const release = Promise.withResolvers();
  const manager = new RuntimeManager({ store, config, broker: new CapabilityBroker({ ttlMs: 10_000 }), gatewayOrigin: "http://localhost",
    workerBackend: { sleep: async () => { await release.promise; return { instanceId: "i-12345678", stopped: true }; }, destroy: async () => {} },
    adapterFactory: () => assert.fail("reconciliation must not start an agent") });
  t.after(() => manager.shutdown());
  await manager.reconcileStoppedWorkers({ background: true });
  assert.equal(store.get(chat.id).status, "stopping");
  assert.match(store.get(chat.id).statusDetail, /Verifying|Stopping EC2 worker/);
  release.resolve();
  await waitFor(() => store.get(chat.id).status === "stopped");
  assert.equal(store.get(chat.id).workerLifecycle.result.cleanup, "stopped");
});

test("resize joins startup reconciliation and resumes an interrupted resize without racing Stop", async t => {
  const root = await temporaryDirectory(t), config = testConfig(root), store = new ChatStore(root); await store.initialize();
  config.workerBackend = "ec2";
  const chat = await store.create({ agent: "codex", title: "Resize during reconciliation" });
  await store.update(chat.id, { runtimeMetadata: { backend: "ec2", instanceId: "i-12345678", instanceType: "t3.medium" } });
  const release = Promise.withResolvers(); let sleeps = 0, resizes = 0;
  const manager = new RuntimeManager({ store, config, broker: new CapabilityBroker({ ttlMs: 10_000 }), gatewayOrigin: "http://localhost",
    workerBackend: {
      sleep: async () => { sleeps++; await release.promise; return { instanceId: "i-12345678", stopped: true }; },
      resize: async (_chat, instanceType) => { resizes++; return { instanceId: "i-12345678", instanceType, resized: true }; },
      acquire: async current => ({ metadata: { backend: "ec2", instanceId: "i-12345678", instanceType: current.workerInstanceType } }), destroy: async () => {},
    }, adapterFactory: () => ({ start: async () => {}, send: async () => ({ text: "ready" }), stop: async () => {} }) });
  t.after(() => manager.shutdown());
  await manager.reconcileStoppedWorkers({ background: true });
  const accepted = await manager.resizeWorker(chat.id, "t3.large");
  assert.equal(accepted.workerResize.phase, "stopping");
  assert.equal(store.get(chat.id).startupProgress, null);
  await waitFor(() => sleeps === 1);
  assert.equal(sleeps, 1, "resize shares the in-flight reconciliation stop");
  release.resolve();
  await waitFor(() => store.get(chat.id).workerResize?.status === "completed");
  assert.equal(sleeps, 1); assert.equal(resizes, 1);
  assert.equal(store.get(chat.id).runtimeMetadata.instanceType, "t3.large");
});

test("controller restart resumes a persisted in-progress resize", async t => {
  const root = await temporaryDirectory(t), config = testConfig(root), store = new ChatStore(root); await store.initialize();
  config.workerBackend = "ec2";
  const chat = await store.create({ agent: "codex", title: "Interrupted resize" });
  await store.update(chat.id, { status: "stopping", queuePaused: true, workerInstanceType: "t3.large",
    runtimeMetadata: { backend: "ec2", instanceId: "i-12345678", instanceType: "t3.medium" },
    workerResize: { status: "resizing", phase: "stopping", instanceType: "t3.large", queueWasPaused: false } });
  const calls = [];
  const manager = new RuntimeManager({ store, config, broker: new CapabilityBroker({ ttlMs: 10_000 }), gatewayOrigin: "http://localhost",
    workerBackend: {
      sleep: async () => { calls.push("sleep"); return { instanceId: "i-12345678", stopped: true }; },
      resize: async (_chat, instanceType) => { calls.push(`resize:${instanceType}`); return { instanceId: "i-12345678", instanceType, resized: true }; },
      acquire: async current => { calls.push(`acquire:${current.workerInstanceType}`); return { metadata: { backend: "ec2", instanceId: "i-12345678", instanceType: current.workerInstanceType } }; },
      destroy: async () => {},
    }, adapterFactory: () => ({ start: async () => {}, send: async () => ({ text: "ready" }), stop: async () => {} }) });
  t.after(() => manager.shutdown());
  await manager.reconcileStoppedWorkers();
  await waitFor(() => store.get(chat.id).workerResize?.status === "completed");
  assert.deepEqual(calls, ["sleep", "sleep", "resize:t3.large", "acquire:t3.large"]);
  assert.equal(store.get(chat.id).queuePaused, false);
  assert.equal(store.get(chat.id).runtimeMetadata.instanceType, "t3.large");
});

test("chat deletion is durable even when worker stop and infrastructure cleanup fail", async t => {
  const root = await temporaryDirectory(t), records = new MemoryRecords(), store = new ChatStore(root, records); await store.initialize();
  const config = testConfig(root); config.idleTimeoutMs = 60_000;
  let destroys = 0;
  const manager = new RuntimeManager({ store, config, broker: new CapabilityBroker({ ttlMs: 10_000 }), gatewayOrigin: "http://localhost",
    workerBackend: { acquire: async () => ({ metadata: { backend: "fixture" } }), sleep: async () => { throw new Error("lease denied"); }, destroy: async () => { destroys++; throw new Error("termination unavailable"); } },
    adapterFactory: () => ({ start: async () => {}, send: async () => ({ text: "working" }), stop: async () => {} }),
  });
  t.after(() => manager.shutdown());
  const chat = await manager.createChat({ agent: "codex", title: "Delete without UI lock" });
  await manager.send(chat.id, "start");
  assert.equal(await manager.remove(chat.id), true);
  assert.equal(store.get(chat.id), null);
  assert.ok(destroys >= 1);
  assert.equal((await records.get("worker-deletion-cleanup", chat.id)).id, chat.id);
});
