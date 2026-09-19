import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdir } from "node:fs/promises";
import { CodexAdapter } from "../src/adapters/codex.mjs";
import { ChatStore } from "../src/store.mjs";
import { RuntimeManager } from "../src/runtime-manager.mjs";
import { CapabilityBroker } from "../src/capabilities.mjs";
import { temporaryDirectory, testConfig } from "./helpers.mjs";

function scriptedTurns(adapter, messages) {
  const request = adapter.rpc.request.bind(adapter.rpc);
  adapter.rpc.request = (method, params, timeout) => {
    if (method !== "turn/start") return request(method, params, timeout);
    const turn = { id: "boundary-fixture-turn", status: "inProgress" };
    queueMicrotask(() => {
      const emit = (method, params) => adapter.rpc.emit("notification", { method, params: { threadId: adapter.threadId, turnId: turn.id, ...params } });
      emit("turn/started", { turn });
      // Reasoning events are not ordinary visible commentary and stay ignored.
      emit("item/reasoning/textDelta", { delta: "fixture internal reasoning must not be displayed" });
      for (const [index, message] of messages.entries()) {
        const id = `message-${index}`, item = { id, type: "agentMessage", phase: index === messages.length - 1 ? "final_answer" : "commentary", text: message.chunks.join("") };
        if (!message.noStart) emit("item/started", { item: { ...item, text: "" } });
        if (!message.completedOnly) for (const delta of message.chunks) emit("item/agentMessage/delta", { ...(message.noDeltaId ? {} : { itemId: id }), delta });
        emit("item/completed", { item });
        if (message.repeatCompletion) emit("item/completed", { item });
        emit("item/completed", { item: { id: `tool-${index}`, type: "commandExecution", command: "fixture", exitCode: 0 } });
      }
      emit("turn/completed", { turn: { ...turn, status: "completed" } });
    });
    return Promise.resolve({ turn });
  };
}

async function fixture(t, messages) {
  const root = await temporaryDirectory(t), store = new ChatStore(root); await store.initialize();
  const config = testConfig(root, { CODEX_BIN: path.resolve("test/fixtures/fake-codex.mjs"), AGENT_IDLE_TIMEOUT_MS: "10000" });
  const broker = new CapabilityBroker({ ttlMs: 10000 }), chat = await store.create({ agent: "codex", title: "Message boundaries" });
  await mkdir(chat.workspace, { recursive: true });
  const events = [], adapter = new CodexAdapter({ chat, store, config, broker, hooks: { onEvent: event => events.push(event) } });
  t.after(() => adapter.stop()); await adapter.start(); scriptedTurns(adapter, messages);
  return { adapter, events };
}

test("separate native commentary and final messages remain paragraphs live and in the final text", async t => {
  const messages = [{ chunks: ["I'll check ", "the server."] }, { chunks: ["Shared Chrome ", "is ready."], noStart: true }, { chunks: ["The app ", "works."], noDeltaId: true }];
  const { adapter, events } = await fixture(t, messages);
  const result = await adapter.send("fixture");
  const expected = "I'll check the server.\n\nShared Chrome is ready.\n\nThe app works.";
  assert.equal(result.text, expected);
  assert.equal(events.filter(event => event.type === "assistant_delta").map(event => event.delta).join(""), expected);
  assert.doesNotMatch(JSON.stringify(events), /internal reasoning/);
});

test("completed-only messages are retained once, empty messages add no paragraph, and tokens stay redacted", async t => {
  const { adapter, events } = await fixture(t, [
    { chunks: ["First message."] }, { chunks: [""] },
    { chunks: ["Token: fixture-secret"], completedOnly: true, repeatCompletion: true },
    { chunks: ["Last message."] },
  ]);
  adapter.credentialSecrets.add("fixture-secret");
  const result = await adapter.send("fixture");
  assert.equal(result.text, "First message.\n\nToken: [redacted]\n\nLast message.");
  assert.equal(events.filter(event => event.type === "assistant_delta").map(event => event.delta).join(""), result.text);
  assert.doesNotMatch(JSON.stringify(events), /fixture-secret/);
});

test("split credentials stay redacted across message boundaries, without dropping the next message", async t => {
  const { adapter, events } = await fixture(t, [{ chunks: ["Token: fixture-"] }, { chunks: ["Next message."] }]);
  adapter.credentialSecrets.add("fixture-secret");
  const result = await adapter.send("fixture");
  assert.equal(result.text, "Token: [redacted]\n\nNext message.");
  assert.equal(events.filter(event => event.type === "assistant_delta").map(event => event.delta).join(""), result.text);
});

test("controller persists the same message boundaries and they survive store reload", async t => {
  const root = await temporaryDirectory(t), store = new ChatStore(root); await store.initialize();
  const config = testConfig(root, { CODEX_BIN: path.resolve("test/fixtures/fake-codex.mjs"), AGENT_IDLE_TIMEOUT_MS: "10000" }), broker = new CapabilityBroker({ ttlMs: 10000 }), events = [];
  const manager = new RuntimeManager({ store, config, broker, adapterFactory: args => {
    const adapter = new CodexAdapter({ ...args, config, store, broker });
    const start = adapter.start.bind(adapter);
    adapter.start = async () => { await start(); scriptedTurns(adapter, [{ chunks: ["Checking the server."] }, { chunks: ["The server works."] }]); };
    return adapter;
  } });
  t.after(() => manager.shutdown()); manager.on("event", event => events.push(event));
  const chat = await manager.createChat({ agent: "codex", title: "Paragraph persistence" });
  await manager.send(chat.id, "fixture");
  const expected = "Checking the server.\n\nThe server works.";
  const assistantText = chat => chat.messages.filter(message => message.role === "assistant" && message.text).map(message => message.text).join("\n\n");
  assert.equal(assistantText(store.get(chat.id)), expected);
  assert.deepEqual(store.get(chat.id).messages.filter(message => message.text).map(message => message.role), ["user", "assistant", "tool", "assistant", "tool"]);
  assert.equal(events.filter(event => event.type === "assistant_delta").map(event => event.delta).join(""), expected);
  const reloaded = new ChatStore(root); await reloaded.initialize();
  assert.equal(assistantText(reloaded.get(chat.id)), expected);
});
