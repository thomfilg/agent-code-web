import assert from "node:assert/strict";
import test from "node:test";
import { RuntimeManager } from "../src/runtime-manager.mjs";
import { ChatStore } from "../src/store.mjs";
import { CapabilityBroker } from "../src/capabilities.mjs";
import { createAgentWebServer } from "../src/server.mjs";
import { temporaryDirectory, testConfig, waitFor } from "./helpers.mjs";

async function fixture(t, acquire = async () => ({ metadata: { backend: "fixture" } })) {
  const root = await temporaryDirectory(t), config = testConfig(root), store = new ChatStore(root); await store.initialize();
  const calls = { acquire: 0, sleep: 0, adapters: 0 };
  const manager = new RuntimeManager({ store, config, broker: new CapabilityBroker({ ttlMs: 10000 }), gatewayOrigin: "http://localhost",
    workerBackend: { acquire: async chat => { calls.acquire++; return acquire(chat); }, sleep: async () => { calls.sleep++; }, destroy: async () => {} },
    adapterFactory: () => { calls.adapters++; throw Error("Wake must never start an agent"); },
  });
  t.after(() => manager.shutdown());
  const chat = await store.create({ agent: "codex", title: "Wake fixture" });
  return { manager, store, chat, calls };
}

test("wake admits immediately, deduplicates startup and preserves messages, session and queued input", async t => {
  const gate = Promise.withResolvers(), { manager, store, chat, calls } = await fixture(t, () => gate.promise);
  t.after(() => gate.resolve(null));
  await manager.setPresence(chat.id, { clientId: "wake_fixture_tab_1", active: true });
  await store.appendMessage(chat.id, { role: "user", text: "Existing message" });
  await store.update(chat.id, { agentSessionId: "saved-session", queuePaused: false, queuedMessages: [{ id: "existing", text: "Do not send this" }] });
  const before = store.get(chat.id), first = await manager.wake(chat.id), second = await manager.wake(chat.id);
  assert.equal(first.accepted, true); assert.equal(store.get(chat.id).status, "starting");
  await waitFor(() => calls.acquire === 1);
  assert.equal(first.completion, second.completion); assert.equal(calls.acquire, 1); assert.equal(calls.adapters, 0);
  await assert.rejects(manager.submit(chat.id, "Must wait"), /waking up/);
  gate.resolve({ metadata: { backend: "fixture" } }); await first.completion;
  const after = store.get(chat.id);
  assert.equal(after.status, "idle"); assert.match(after.statusDetail, /no message sent/);
  assert.deepEqual(after.messages, before.messages); assert.deepEqual(after.queuedMessages, before.queuedMessages);
  assert.equal(after.queuePaused, false); assert.equal(after.agentSessionId, "saved-session"); assert.equal(calls.adapters, 0);
  assert.equal((await manager.wake(chat.id)).accepted, false); assert.equal(calls.acquire, 1);
});

test("Stop during wake cancels late readiness without resurrecting the worker or starting a turn", async t => {
  const gate = Promise.withResolvers(), { manager, store, chat, calls } = await fixture(t, () => gate.promise);
  const operation = await manager.wake(chat.id), stopping = manager.stop(chat.id);
  gate.resolve(null);
  await assert.rejects(operation.completion, /cancelled/); await stopping;
  assert.equal(store.get(chat.id).status, "stopped"); assert.equal(calls.sleep, 1); assert.equal(calls.adapters, 0);
  assert.deepEqual(store.get(chat.id).messages, []);
});

test("wake failure is visible and retryable without adding a transcript error or consuming queued input", async t => {
  let fail = true;
  const { manager, store, chat, calls } = await fixture(t, async () => { if (fail) throw Error("Fixture unavailable"); return null; });
  await store.update(chat.id, { queuePaused: true, queuedMessages: [{ id: "keep", text: "Saved queue" }] });
  const failed = await manager.wake(chat.id); await assert.rejects(failed.completion, /Fixture unavailable/);
  assert.equal(store.get(chat.id).status, "error"); assert.match(store.get(chat.id).statusDetail, /Could not wake/);
  assert.deepEqual(store.get(chat.id).messages, []); assert.equal(store.get(chat.id).queuedMessages.length, 1);
  fail = false; const retry = await manager.wake(chat.id); await retry.completion;
  assert.equal(store.get(chat.id).status, "idle"); assert.equal(calls.acquire, 2); assert.equal(calls.adapters, 0);
});

test("a worker-only wake sleeps when unused even if the chat stays visible", async t => {
  const { manager, store, chat, calls } = await fixture(t);
  await manager.setPresence(chat.id, { clientId: "wake_fixture_tab_2", active: true });
  await (await manager.wake(chat.id)).completion;
  assert.equal(store.get(chat.id).idleKeepAwakeReason, null); assert.ok(store.get(chat.id).idleDeadlineAt);
  await waitFor(() => store.get(chat.id).status === "stopped"); assert.equal(calls.sleep, 1); assert.equal(calls.adapters, 0);
  await manager.setPresence(chat.id, { clientId: "wake_fixture_tab_2", active: false });
  assert.equal(store.get(chat.id).status, "stopped");
});

test("archived chats and revoked ownership cannot wake a worker", async t => {
  const { manager, store, chat, calls } = await fixture(t);
  await store.update(chat.id, { archived: true }); await assert.rejects(manager.wake(chat.id), /Unarchive/);
  await store.update(chat.id, { archived: false }); await assert.rejects(manager.wake(chat.id, () => { throw Error("Not allowed"); }), /Not allowed/);
  assert.equal(calls.acquire, 0); assert.deepEqual(store.get(chat.id).messages, []);
});

test("Stop during environment checks prevents a late EC2 acquisition", async t => {
  const gate = Promise.withResolvers(), { manager, store, chat, calls } = await fixture(t);
  manager.environments = { runtime: () => gate.promise };
  await store.update(chat.id, { environmentId: "environment-fixture" });
  const operation = await manager.wake(chat.id);
  await waitFor(() => calls.acquire === 0 && store.get(chat.id).status === "starting");
  const stopping = manager.stop(chat.id); gate.resolve({});
  await assert.rejects(operation.completion, /cancelled/); await stopping;
  assert.equal(calls.acquire, 0); assert.equal(store.get(chat.id).status, "stopped");
});

test("wake HTTP returns 202 before cold startup completes and denies anonymous/foreign owners", async t => {
  const root = await temporaryDirectory(t), gate = Promise.withResolvers(); let acquisitions = 0, adapters = 0;
  const app = await createAgentWebServer({ config: testConfig(root), workerBackend: { acquire: () => { acquisitions++; return gate.promise; }, sleep: async () => {}, destroy: async () => {} }, adapterFactory: () => { adapters++; throw Error("Unexpected adapter"); } });
  const { url } = await app.start(); t.after(async () => { gate.resolve(null); await app.stop(); });
  const owner = await app.browserUsers.register({ username: "wake-owner", password: "private fixture owner password" });
  const foreign = await app.browserUsers.register({ username: "wake-foreign", password: "private fixture foreign password" });
  const chat = await app.store.create({ agent: "codex", ownerId: owner.user.id, title: "Private wake" });
  const post = cookie => fetch(`${url}/api/chats/${chat.id}/wake`, { method: "POST", headers: { "content-type": "application/json", ...(cookie ? { cookie: cookie.split(";")[0] } : {}) }, body: "{}" });
  assert.equal((await post()).status, 404); assert.equal((await post(foreign.cookie)).status, 404); assert.equal(acquisitions, 0);
  const response = await post(owner.cookie); assert.equal(response.status, 202); assert.equal((await response.json()).chat.status, "starting");
  assert.equal(acquisitions, 1); assert.equal(adapters, 0);
  gate.resolve(null); await waitFor(() => app.store.get(chat.id).status === "idle");
  assert.deepEqual(app.store.get(chat.id).messages, []);
});
