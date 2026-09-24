import assert from "node:assert/strict";
import test from "node:test";
import { ChatPresence } from "../src/chat-presence.mjs";
import { RuntimeManager } from "../src/runtime-manager.mjs";
import { ChatStore } from "../src/store.mjs";
import { CapabilityBroker } from "../src/capabilities.mjs";
import { testConfig, temporaryDirectory, waitFor } from "./helpers.mjs";
const client = "tab-fixture-0000001", other = "tab-fixture-0000002";

test("presence leases are per tab, expire after disconnects, and notify only on awake/asleep transitions", async t => {
  const changes = [], presence = new ChatPresence({ ttlMs: 120, onChange: async id => changes.push(id) }); t.after(() => presence.clear());
  await presence.set("one", client, true); await presence.set("one", other, true); await presence.set("one", client, true);
  assert.deepEqual(changes, ["one"]); assert.equal(presence.has("two"), false);
  await presence.set("one", client, false); assert.equal(presence.has("one"), true);
  await presence.set("one", other, false); assert.equal(presence.has("one"), false); assert.deepEqual(changes, ["one", "one"]);
  await presence.set("one", client, true); await waitFor(() => changes.length === 4);
  assert.equal(presence.has("one"), false); assert.equal(presence.chats.size, 0);
  await assert.rejects(presence.set("one", "bad", true), /Invalid/);
});

test("closing an expired lease before its timer fires still emits exactly one asleep transition", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
  const changes = [], presence = new ChatPresence({ ttlMs: 120, onChange: async id => changes.push(id) });
  t.after(() => presence.clear());
  await presence.set("one", client, true);
  t.mock.timers.setTime(1121); // Simulate a busy event loop; expiry timer has not run.
  assert.equal(presence.has("one"), false);
  await presence.set("one", client, false);
  assert.deepEqual(changes, ["one", "one"]);
  t.mock.timers.tick(1000); assert.deepEqual(changes, ["one", "one"]); assert.equal(presence.chats.size, 0);
});

test("a visible chat does not pause sleep; an open Chrome does; presence never wakes a stopped worker", async t => {
  const root = await temporaryDirectory(t), store = new ChatStore(root); await store.initialize();
  let starts = 0, viewers = false;
  const manager = new RuntimeManager({ store, config: testConfig(root), broker: new CapabilityBroker({ ttlMs: 10000 }),
    adapterFactory: () => ({ start: async () => { starts++; }, send: async () => ({ text: "Fixture response" }), stop: async () => {} }),
  }); t.after(() => manager.shutdown());
  manager.browsers = { hasSession: () => viewers, touch: () => {}, stop: async () => {}, shutdown: async () => {} };
  const chat = await manager.createChat({ agent: "mock" });
  await manager.setPresence(chat.id, { clientId: client, active: true }); assert.equal(starts, 0);
  await manager.send(chat.id, "Fixture request");
  assert.equal(store.get(chat.id).status, "idle"); assert.ok(store.get(chat.id).idleDeadlineAt); assert.equal(store.get(chat.id).idleKeepAwakeReason, null);
  await manager.setPresence(chat.id, { clientId: other, active: true });
  await manager.setPresence(chat.id, { clientId: client, active: false }); assert.ok(store.get(chat.id).idleDeadlineAt);
  viewers = true; await manager.refreshActivity(chat.id);
  assert.equal(store.get(chat.id).idleDeadlineAt, null);
  await new Promise(resolve => setTimeout(resolve, 140)); assert.equal(store.get(chat.id).status, "idle");
  await manager.setPresence(chat.id, { clientId: other, active: false }); assert.equal(store.get(chat.id).idleKeepAwakeReason, "browser");
  viewers = false; await manager.refreshActivity(chat.id); assert.ok(store.get(chat.id).idleDeadlineAt);
  await waitFor(() => store.get(chat.id).status === "stopped");
  await manager.setPresence(chat.id, { clientId: client, active: true }); assert.equal(starts, 1); assert.equal(store.get(chat.id).status, "stopped");
  assert.deepEqual(store.get(chat.id).messages.map(m => m.text), ["Fixture request", "Fixture response"]);
});
