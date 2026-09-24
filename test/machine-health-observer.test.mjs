import assert from "node:assert/strict";
import test from "node:test";
import { MachineHealthObserver } from "../src/machine-health-observer.mjs";
import { ChatStore } from "../src/store.mjs";
import { MemoryRecords } from "../src/database.mjs";
import { temporaryDirectory } from "./helpers.mjs";

test("server-owned health sampling emits only changed states and survives a closed browser", async t => {
  const root = await temporaryDirectory(t), records = new MemoryRecords(), store = new ChatStore(root, records);
  await store.initialize();
  const chat = await store.create({ title: "Health sample", agent: "mock" });
  await store.update(chat.id, current => ({ status: "running", workerLifecycle: { ...current.workerLifecycle,
    generation: 1, state: "active", updatedAt: new Date().toISOString() } }));
  let anomaly = null, unavailable = false;
  const manager = { machineHealth: async () => ({ sampledAt: new Date().toISOString(), anomaly,
    worker: { state: "running" }, agent: { state: "running" }, system: { unavailable } }) };
  const observer = new MachineHealthObserver({ manager, store, records });
  await observer.sample(); await observer.sample();
  anomaly = "pressure"; await observer.sample();
  unavailable = true; await observer.sample();
  assert.deepEqual((await records.workerEventsSince(chat.id)).filter(event => event.type === "machine-health-change")
    .map(event => event.anomaly), ["none", "pressure", "monitor-unavailable"]);
  assert.equal(await records.get("health-observation", chat.id).then(value => value.anomaly), "monitor-unavailable");
  await store.remove(chat.id);
  assert.deepEqual(await records.workerEventsSince(chat.id), []);
  assert.equal(await records.get("health-observation", chat.id), null);
  await observer.close();
});
