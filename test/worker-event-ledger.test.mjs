import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:net";
import { openDatabase, MemoryRecords } from "../src/database.mjs";
import { ChatStore } from "../src/store.mjs";
import { beginWorkerLifecycle, finishWorkerLifecycle } from "../src/worker-lifecycle.mjs";
import { temporaryDirectory, waitFor } from "./helpers.mjs";

async function chatFor(t, records, root) {
  const store = new ChatStore(root, records);
  await store.initialize();
  return { store, chat: await store.create({ agent: "mock", title: "Worker events fixture" }) };
}

test("memory worker events are ordered, idempotent, pushed and erased with the chat", async t => {
  const root = await temporaryDirectory(t), records = new MemoryRecords();
  const { store, chat } = await chatFor(t, records, root);
  const signals = [], watcher = await records.watchWorkerEvents(id => signals.push(id));
  const first = await records.appendWorkerEvent(chat.id, "fixture:1", { type: "worker-state", state: "running" });
  assert.equal(first.sequence, 1);
  assert.deepEqual(await records.appendWorkerEvent(chat.id, "fixture:1", { type: "worker-state", state: "stopped" }), first);
  const second = await records.appendWorkerEvent(chat.id, "fixture:2", { type: "worker-state", state: "stopped" });
  assert.equal(second.sequence, 2);
  assert.deepEqual((await records.workerEventsSince(chat.id, 1)).map(event => event.sourceId), ["fixture:2"]);
  assert.equal(signals.filter(id => id === chat.id).length, 2);
  await watcher.close(); await records.appendWorkerEvent(chat.id, "fixture:3", { type: "worker-state", state: "terminated" });
  assert.equal(signals.filter(id => id === chat.id).length, 2);
  await store.remove(chat.id);
  assert.deepEqual(await records.workerEventsSince(chat.id), []);
  await assert.rejects(records.appendWorkerEvent(chat.id, "fixture:4", { type: "worker-state" }), /no longer exists/);
});

test("system events use a distinct global durable sequence and notification scope", async () => {
  const records = new MemoryRecords(), notices = [], watcher = await records.watchWorkerEvents(scope => notices.push(scope));
  const first = await records.appendSystemEvent("docker:first", { type: "controller-container", action: "die" });
  assert.equal(first.sequence, 1);
  assert.deepEqual(await records.appendSystemEvent("docker:first", { type: "controller-container", action: "start" }), first);
  assert.equal((await records.appendSystemEvent("docker:second", { type: "controller-container", action: "start" })).sequence, 2);
  assert.deepEqual((await records.systemEventsSince(1)).map(event => event.sourceId), ["docker:second"]);
  assert.deepEqual(notices.filter(scope => scope === "system"), ["system", "system"]);
  await watcher.close();
});

test("system event cursors are not reused after chat-scoped evidence is deleted", async t => {
  const root = await temporaryDirectory(t), records = new MemoryRecords();
  const { store, chat } = await chatFor(t, records, root);
  await records.appendSystemEvent("ec2:first", { type: "ec2-instance-state", chatId: chat.id });
  await store.remove(chat.id);
  assert.deepEqual(await records.systemEventsSince(), []);
  const next = await records.appendSystemEvent("docker:after-delete", { type: "controller-container" });
  assert.equal(next.sequence, 2);
});

test("a Stop intent and result retain their reason across controller restart without exposing chat content", async t => {
  const root = await temporaryDirectory(t), records = new MemoryRecords();
  const { store, chat } = await chatFor(t, records, root);
  const at = "2026-09-24T20:00:00.000Z";
  await store.update(chat.id, current => ({ workerLifecycle: beginWorkerLifecycle(current.workerLifecycle, "stop", at, "idle-timeout") }));
  assert.deepEqual((await records.workerEventsSince(chat.id)).map(event => [event.phase, event.reason]), [["intent", "idle-timeout"]]);
  await store.update(chat.id, current => ({ workerLifecycle: finishWorkerLifecycle(current.workerLifecycle, {
    generation: 1, action: "stop", status: "succeeded", mutation: "stopped", cleanup: "stopped",
  }, "2026-09-24T20:00:01.000Z") }));
  const before = await records.workerEventsSince(chat.id);
  assert.deepEqual(before.map(event => [event.sequence, event.phase, event.reason]), [[1, "intent", "idle-timeout"], [2, "result", "idle-timeout"]]);
  assert.ok(before.every(event => !JSON.stringify(event).includes(chat.title)));
  const recovered = new ChatStore(root, records); await recovered.initialize();
  assert.deepEqual(await records.workerEventsSince(chat.id), before, "restart must not duplicate committed lifecycle events");
});

test("restart recovers a committed lifecycle intent whose event projection was interrupted", async t => {
  const root = await temporaryDirectory(t), records = new MemoryRecords();
  const { store, chat } = await chatFor(t, records, root);
  const at = "2026-09-24T20:00:00.000Z";
  const committed = beginWorkerLifecycle(chat.workerLifecycle, "stop", at, "controller-drain");
  // Simulate controller death after the chat commit but before appendWorkerEvent.
  const saved = { ...chat, workerLifecycle: committed };
  await records.put("chat", chat.id, saved);
  const restarted = new ChatStore(root, records); await restarted.initialize();
  const events = await records.workerEventsSince(chat.id);
  assert.equal(events.length, 3, "the original intent is recovered before the reconciliation intent and result");
  assert.deepEqual([events[0].phase, events[0].reason], ["intent", "controller-drain"]);
  assert.deepEqual(events.slice(1).map(event => [event.action, event.phase]), [["reconcile", "intent"], ["reconcile", "result"]]);
});

test("PostgreSQL event commit orders writers, signals after commit and survives reopen", { timeout: 60000 }, async t => {
  const root = await temporaryDirectory(t, "relay-worker-events-pg-"), socket = createServer();
  await new Promise(resolve => socket.listen(0, "127.0.0.1", resolve));
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  const config = { mode: "embedded", directory: `${root}/database`, port };
  let records = await openDatabase(config);
  t.after(() => records.close());
  const { store, chat } = await chatFor(t, records, `${root}/chats`);
  const signals = [], watcher = await records.watchWorkerEvents(id => signals.push(id));
  try {
    await waitFor(() => signals.includes(null));
    const [first, duplicate] = await Promise.all([
      records.appendWorkerEvent(chat.id, "worker:1", { type: "worker-state", state: "running" }),
      records.appendWorkerEvent(chat.id, "worker:1", { type: "worker-state", state: "running" }),
    ]);
    assert.deepEqual(first, duplicate); assert.equal(first.sequence, 1);
    await waitFor(() => signals.includes(chat.id));
    assert.equal(signals.filter(id => id === chat.id).length, 1);
    await records.pool.query(`CREATE FUNCTION fixture_reject_worker_event() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'WORKER EVENT COMMIT FAILURE'; END $$`);
    await records.pool.query(`CREATE CONSTRAINT TRIGGER fixture_worker_event_commit AFTER INSERT ON relay_worker_events
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fixture_reject_worker_event()`);
    try {
      await assert.rejects(records.appendWorkerEvent(chat.id, "worker:failed", { type: "worker-state", state: "stopped" }));
      assert.deepEqual((await records.workerEventsSince(chat.id)).map(event => event.sequence), [1]);
      assert.equal(signals.filter(id => id === chat.id).length, 1, "a rolled-back event must not be announced");
    } finally {
      await records.pool.query("DROP TRIGGER fixture_worker_event_commit ON relay_worker_events");
      await records.pool.query("DROP FUNCTION fixture_reject_worker_event()");
    }
    const second = await records.appendWorkerEvent(chat.id, "worker:2", { type: "worker-state", state: "stopped" });
    assert.equal(second.sequence, 2, "rolled-back sequence is not committed");
    const listener = await records.pool.query(`SELECT pid FROM pg_stat_activity
      WHERE pid<>pg_backend_pid() AND query='LISTEN relay_worker_events' ORDER BY pid LIMIT 1`);
    assert.equal(listener.rowCount, 1);
    await records.pool.query("SELECT pg_terminate_backend($1)", [listener.rows[0].pid]);
    await waitFor(() => signals.filter(id => id === null).length >= 2, { timeoutMs: 5000 });
    const third = await records.appendWorkerEvent(chat.id, "worker:3", { type: "worker-state", state: "running" });
    await waitFor(() => signals.filter(id => id === chat.id).length >= 3, { timeoutMs: 5000 });
    assert.equal(third.sequence, 3);
  } finally { await watcher.close(); }
  await records.close(); records = await openDatabase(config);
  assert.deepEqual((await records.workerEventsSince(chat.id)).map(event => event.sourceId), ["worker:1", "worker:2", "worker:3"]);
  const systemSignals = [], systemWatch = await records.watchWorkerEvents(scope => systemSignals.push(scope));
  const system = await records.appendSystemEvent("docker:one", { type: "controller-container", action: "die" });
  assert.equal(system.sequence, 1);
  assert.deepEqual(await records.appendSystemEvent("docker:one", { type: "controller-container", action: "start" }), system);
  const scoped = await records.appendSystemEvent("ec2:one", { type: "ec2-instance-state", chatId: chat.id, state: "stopped" });
  assert.equal(scoped.sequence, 2);
  await waitFor(() => systemSignals.filter(scope => scope === "system").length === 2);
  assert.equal(systemSignals.filter(scope => scope === "system").length, 2);
  await systemWatch.close();
  await records.close(); records = await openDatabase(config);
  assert.deepEqual((await records.systemEventsSince()).map(event => event.sourceId), ["docker:one", "ec2:one"]);
  const restored = new ChatStore(`${root}/chats`, records); await restored.initialize();
  await restored.remove(chat.id);
  assert.deepEqual(await records.workerEventsSince(chat.id), []);
  assert.deepEqual((await records.systemEventsSince()).map(event => event.sourceId), ["docker:one"],
    "global host evidence remains, but exact chat EC2 evidence is erased");
  assert.equal((await records.pool.query("SELECT count(*)::int AS n FROM relay_worker_event_heads WHERE chat_id=$1", [chat.id])).rows[0].n, 0);
});
