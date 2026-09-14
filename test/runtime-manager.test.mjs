import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { CapabilityBroker } from "../src/capabilities.mjs";
import { RuntimeManager } from "../src/runtime-manager.mjs";
import { ChatStore } from "../src/store.mjs";
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

  await waitFor(() => store.get(first.id).status === "stopped");
  assert.equal(store.get(second.id).status, "stopped");
  const startsBefore = events.filter((event) => event.chatId === first.id && event.type === "runtime_started").length;
  await manager.send(first.id, "wake again");
  const startsAfter = events.filter((event) => event.chatId === first.id && event.type === "runtime_started").length;
  assert.equal(startsAfter, startsBefore + 1);
  assert.match(store.get(first.id).messages.at(-1).text, /wake again/);
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
