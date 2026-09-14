import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { CodexAdapter } from "../src/adapters/codex.mjs";
import { ClaudeAdapter } from "../src/adapters/claude.mjs";
import { CapabilityBroker } from "../src/capabilities.mjs";
import { ChatStore } from "../src/store.mjs";
import { prepareWorkspace } from "../src/workspace.mjs";
import { temporaryDirectory, testConfig } from "./helpers.mjs";

const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

async function fixtureChat(t, agent) {
  const root = await temporaryDirectory(t);
  const store = new ChatStore(root);
  await store.initialize();
  const chat = await store.create({ title: "Adapter", agent, source: "" });
  await prepareWorkspace({ destination: chat.workspace, source: "" });
  return { root, store, chat };
}

test("Codex adapter speaks app-server JSON-RPC, streams, resumes, and answers approval", async (t) => {
  const { root, store, chat } = await fixtureChat(t, "codex");
  const config = testConfig(root, { CODEX_BIN: path.join(fixtureDir, "fake-codex.mjs") });
  const broker = new CapabilityBroker({ ttlMs: 10_000 });
  const events = [];
  let sessionId;
  let adapter;
  const hooks = {
    onEvent: (event) => events.push(event),
    onSessionId: (id) => { sessionId = id; },
    onRequest: (request) => setImmediate(() => adapter.respond(request.requestId, { decision: "accept" })),
    onFatal: (error) => { throw error; },
  };
  adapter = new CodexAdapter({ chat, store, config, broker, gatewayOrigin: "http://127.0.0.1:9", hooks });
  await adapter.start();
  const result = await adapter.send("fixture turn");
  assert.equal(sessionId, "thr_fixture");
  assert.equal(result.text, "hello world");
  assert.ok(events.some((event) => event.type === "assistant_delta" && event.delta === "hello "));
  assert.ok(events.some((event) => event.type === "tool" && event.state === "completed"));
  await adapter.stop();

  const resumedChat = { ...chat, agentSessionId: sessionId };
  const resumed = new CodexAdapter({ resumedChat, chat: resumedChat, store, config, broker, gatewayOrigin: "http://127.0.0.1:9", hooks: { ...hooks, onSessionId: () => assert.fail("resume should retain session") } });
  adapter = resumed;
  await resumed.start();
  assert.equal((await resumed.send("resumed")).text, "hello world");
  await resumed.stop();
});

test("Claude adapter parses stream-json and retains its resume id", async (t) => {
  const { root, store, chat } = await fixtureChat(t, "claude");
  const config = testConfig(root, { CLAUDE_BIN: path.join(fixtureDir, "fake-claude.mjs") });
  const broker = new CapabilityBroker({ ttlMs: 10_000 });
  const events = [];
  let sessionId;
  const adapter = new ClaudeAdapter({
    chat,
    store,
    config,
    broker,
    gatewayOrigin: "http://127.0.0.1:9",
    hooks: { onEvent: (event) => events.push(event), onSessionId: (id) => { sessionId = id; } },
  });
  await adapter.start();
  const result = await adapter.send("hello");
  assert.match(sessionId, /^[a-f0-9-]{36}$/);
  assert.equal(result.text, "claude received hello");
  assert.ok(events.some((event) => event.type === "tool" && event.tool === "Read" && event.state === "running"));
  assert.ok(events.some((event) => event.type === "tool" && event.tool === "Read" && event.state === "completed" && event.output === "fixture.txt"));
  await adapter.stop();
});

test("Claude adapter rejects structured error results even when the CLI exits zero", async (t) => {
  const { root, store, chat } = await fixtureChat(t, "claude");
  const config = testConfig(root, { CLAUDE_BIN: path.join(fixtureDir, "fake-claude.mjs") });
  const adapter = new ClaudeAdapter({
    chat,
    store,
    config,
    broker: new CapabilityBroker({ ttlMs: 10_000 }),
    gatewayOrigin: "http://127.0.0.1:9",
    hooks: {},
  });
  await adapter.start();
  await assert.rejects(adapter.send("force failure"), /fixture failed/);
  await adapter.stop();
});
