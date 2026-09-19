import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { mkdir } from "node:fs/promises";
import { CodexAdapter } from "../src/adapters/codex.mjs";
import { CapabilityBroker } from "../src/capabilities.mjs";
import { ChatStore } from "../src/store.mjs";
import { RuntimeManager } from "../src/runtime-manager.mjs";
import { temporaryDirectory, testConfig } from "./helpers.mjs";

async function fixture(t) {
  const root = await temporaryDirectory(t), store = new ChatStore(root); await store.initialize();
  const chat = await store.create({ agent: "codex", title: "Tool result fixture" }); await mkdir(chat.workspace, { recursive: true });
  const config = testConfig(root, { CODEX_BIN: path.resolve("test/fixtures/fake-codex.mjs") }), events = [];
  const adapter = new CodexAdapter({ chat, store, config, broker: new CapabilityBroker({ ttlMs: 10000 }), hooks: { onEvent: event => events.push(event) } });
  t.after(() => adapter.stop()); await adapter.start();
  const emit = async (...items) => {
    await adapter.rpc.request("fixture/notifications", { notifications: items.map(({ phase = "completed", ...item }) => ({ method: `item/${phase}`, params: { threadId: adapter.threadId, item } })) });
    return events.filter(event => event.type === "tool");
  };
  return { adapter, emit, events };
}

test("MCP failures retain sanitized arguments and native error details rather than looking successful", async t => {
  const { emit } = await fixture(t);
  const base = { type: "mcpToolCall", id: "linear-error", server: "linear", tool: "list_issues", arguments: { team: "Engineering" } };
  const [started, completed] = await emit({ ...base, phase: "started", status: "inProgress", result: null, error: null },
    { ...base, status: "failed", result: null, error: { message: "Workspace access was denied" } });
  assert.equal(started.state, "running"); assert.equal(completed.state, "completed");
  assert.deepEqual(JSON.parse(started.input), base.arguments); assert.equal(completed.input, started.input);
  assert.equal(completed.failed, true); assert.match(completed.output, /Workspace access was denied/);
  assert.equal(started.output, "");
});

test("dynamic failures honor false success and failed status while successful empty results stay successful", async t => {
  const { emit } = await fixture(t), base = { type: "dynamicToolCall", tool: "fixture", arguments: { count: 0 } };
  const events = await emit(
    { ...base, id: "false", status: "completed", success: false, contentItems: [{ type: "inputText", text: "Fixture tool rejected the input" }] },
    { ...base, id: "failed", status: "failed", success: null, contentItems: null },
    { ...base, id: "empty-success", status: "completed", success: true, contentItems: [] });
  assert.equal(events[0].failed, true); assert.match(events[0].output, /rejected the input/);
  assert.equal(events[1].failed, true);
  assert.equal(events[2].failed, false); assert.equal(events[2].resultMissing, false); assert.equal(events[2].output, "[]");
});

test("missing terminal results are not fabricated successes and MCP error/result combinations retain both", async t => {
  const { emit } = await fixture(t), base = { type: "mcpToolCall", tool: "fixture", arguments: {} };
  const events = await emit({ ...base, id: "missing", status: "completed", result: null, error: null },
    { ...base, id: "partial", status: "failed", result: { content: [{ type: "text", text: "Partial result" }], structuredContent: null }, error: { message: "Final step failed" } },
    { ...base, id: "success", status: "completed", result: { content: [], structuredContent: { count: 0 } }, error: null },
    { ...base, id: "error-only", status: "completed", result: null, error: { message: "Native tool error" } });
  assert.equal(events[0].resultMissing, true); assert.equal(events[0].output, "");
  assert.equal(events[1].failed, true); assert.match(events[1].output, /Partial result/); assert.match(events[1].output, /Final step failed/);
  assert.equal(events[2].failed, false); assert.equal(events[2].resultMissing, false); assert.match(events[2].output, /"count":\s*0/);
  assert.equal(events[3].failed, true); assert.equal(events[3].resultMissing, false); assert.match(events[3].output, /Native tool error/);
});

test("new MCP input/error fields retain transport credential redaction and bounded output without internal metadata", async t => {
  const { adapter, emit, events } = await fixture(t);
  adapter.credentialSecrets.add("synthetic-account-credential");
  const [result] = await emit({ type: "mcpToolCall", id: "safe", tool: "fixture", status: "failed",
    arguments: { query: "synthetic-account-credential", password: "private-tool-password", padding: "x".repeat(20000) },
    result: { content: [{ type: "text", text: "x".repeat(20000) }], structuredContent: { access_token: "private-result-token" }, _meta: { privateDiagnostic: "private-unrelated-metadata" } },
    error: { message: "Denied synthetic-account-credential" }, reasoning: "private-native-reasoning" });
  assert.match(result.input, /\[redacted\]/); assert.match(result.output, /Denied \[redacted\]/);
  assert.ok(result.input.length <= 16000); assert.ok(result.output.length <= 16000);
  assert.doesNotMatch(JSON.stringify(events), /synthetic-account-credential|private-tool-password|private-result-token|private-unrelated-metadata|private-native-reasoning/);
});

test("failed MCP input/result survives controller persistence and replay with one stable activity item", async t => {
  const root = await temporaryDirectory(t), store = new ChatStore(root); await store.initialize();
  const config = testConfig(root, { CODEX_BIN: path.resolve("test/fixtures/fake-codex.mjs"), AGENT_IDLE_TIMEOUT_MS: "10000" });
  const broker = new CapabilityBroker({ ttlMs: 10000 });
  const manager = new RuntimeManager({ store, config, broker, adapterFactory: args => {
    const adapter = new CodexAdapter({ ...args, store, config, broker }), start = adapter.start.bind(adapter);
    adapter.start = async () => {
      await start(); const request = adapter.rpc.request.bind(adapter.rpc);
      adapter.rpc.request = async (method, params, timeout) => {
        if (method !== "turn/start") return request(method, params, timeout);
        const turn = { id: "tool-fixture-turn", status: "inProgress" };
        const item = { id: "tool-fixture", type: "mcpToolCall", server: "linear", tool: "list_issues", arguments: { team: "Engineering" } };
        const message = (method, params) => ({ method, params: { threadId: adapter.threadId, turnId: turn.id, ...params } });
        await request("fixture/notifications", { notifications: [message("turn/started", { turn }),
          message("item/started", { item: { ...item, status: "inProgress" } }),
          message("item/completed", { item: { ...item, status: "failed", result: null, error: { message: "Fixture connection denied" } } }),
          message("turn/completed", { turn: { ...turn, status: "completed" } })] });
        return { turn };
      };
    };
    return adapter;
  } });
  t.after(() => manager.shutdown());
  const chat = await manager.createChat({ agent: "codex", title: "Persist failed MCP" }); await manager.send(chat.id, "fixture-only turn");
  const tools = store.get(chat.id).messages.filter(message => message.kind === "tool");
  assert.equal(tools.length, 1); assert.equal(tools[0].meta.failed, true); assert.match(tools[0].meta.output, /Fixture connection denied/);
  assert.deepEqual(JSON.parse(tools[0].meta.input), { team: "Engineering" });
  const reloaded = new ChatStore(root); await reloaded.initialize();
  assert.deepEqual(reloaded.get(chat.id).messages.filter(message => message.kind === "tool"), tools);
  assert.equal(manager.eventsSince(chat.id).filter(event => event.type === "tool").at(-1).failed, true);
});
