import test from "node:test";
import assert from "node:assert/strict";
import { claudeUsage, claudeContext, claudeRateLimits, codexUsage, mergeUsage } from "../src/session-info.mjs";
import { RuntimeManager } from "../src/runtime-manager.mjs";
import { ChatStore } from "../src/store.mjs";
import { CapabilityBroker } from "../src/capabilities.mjs";
import { temporaryDirectory, testConfig, waitFor } from "./helpers.mjs";
import { groupTools } from "../public/tool-activity.js";

test("Claude context includes cache writes and reads once, while result totals accumulate across calls", () => {
  const request = { model: "opus", usage: { input_tokens: 2, output_tokens: 4, cache_read_input_tokens: 15477, cache_creation_input_tokens: 31155 } };
  assert.equal(claudeContext(request).contextTokens, 46634);
  const result = { total_cost_usd: .32, duration_ms: 3000, duration_api_ms: 2700, modelUsage: { opus: { inputTokens: 10, outputTokens: 23, cacheReadInputTokens: 20000, cacheCreationInputTokens: 40000, costUSD: .32, contextWindow: 1000000 } } };
  const first = mergeUsage(null, claudeUsage(result, request, "one"));
  const second = mergeUsage(first, claudeUsage(result, request, "two"));
  assert.equal(second.contextTokens, 46634); assert.equal(second.totals.inputTokens, 20); assert.equal(second.totals.outputTokens, 46); assert.equal(second.totals.costUsd, .64); assert.equal(second.models[0].cacheWriteTokens, 80000);
  assert.deepEqual(mergeUsage(second, claudeUsage(result, request, "two")), second);
  assert.equal(claudeRateLimits({ rateLimitType: "five_hour", status: "allowed" })[0].windows[0].usedPercent, null);
  assert.equal(claudeRateLimits({ rateLimitType: "seven_day", utilization: .39 })[0].windows[0].usedPercent, 39);
});
test("Codex cached input is not counted twice and snapshots are not added together", () => {
  const usage = codexUsage({ last: { inputTokens: 200, cachedInputTokens: 100, outputTokens: 10, totalTokens: 210 }, total: { inputTokens: 500, cachedInputTokens: 250, outputTokens: 30, totalTokens: 530 }, modelContextWindow: 1000 });
  assert.equal(usage.contextTokens, 210); assert.equal(usage.context.inputTokens, 100); assert.equal(usage.totals.inputTokens, 250);
  assert.equal(mergeUsage(usage, usage).totals.cacheReadTokens, 250);
});
test("tool calls group per user turn and live completion IDs do not count twice", () => {
  const { rows, groups } = groupTools([{ id: "u", role: "user" }, { id: "a", kind: "tool", meta: { itemId: "t" } }, { id: "b", role: "assistant" }, { id: "c", kind: "tool", meta: { itemId: "t2" } }], [{ itemId: "t", state: "completed" }]);
  assert.equal(rows.filter(row => row.kind === "tool_group").length, 1); assert.equal(groups.get("u").size, 2);
});
test("messages drain FIFO, stop pauses queue, removal and explicit resume work", async t => {
  const root = await temporaryDirectory(t), store = new ChatStore(root); await store.initialize();
  let release; const calls = [];
  const manager = new RuntimeManager({ store, config: testConfig(root), broker: new CapabilityBroker({ ttlMs: 10000 }),
    adapterFactory: () => ({ start: async () => {}, stop: async () => release?.({ text: "stopped" }), send: text => { calls.push(text); return new Promise(resolve => { release = resolve; }); } }) });
  t.after(() => manager.shutdown());
  const chat = await manager.createChat({ agent: "mock" });
  const first = await manager.submit(chat.id, "first"); await waitFor(() => calls.length === 1);
  await manager.enqueue(chat.id, "second"); await manager.enqueue(chat.id, "third");
  assert.equal(calls.length, 1); release({ text: "done" }); await first.completion; await waitFor(() => calls.length === 2);
  await manager.stop(chat.id); await waitFor(() => !manager.isBusy(chat.id));
  assert.equal(store.get(chat.id).queuePaused, true); assert.equal(store.get(chat.id).queuedMessages.length, 1);
  await manager.enqueue(chat.id, "remove this"); const queued = store.get(chat.id).queuedMessages;
  await manager.editQueue(chat.id, { removeId: queued[1].id }); assert.equal(calls.length, 2);
  await manager.editQueue(chat.id, { resume: true }); await waitFor(() => calls.length === 3); release({ text: "done" });
  await waitFor(() => !manager.isBusy(chat.id)); assert.deepEqual(calls, ["first", "second", "third"]); assert.equal(store.get(chat.id).queuedMessages.length, 0);
});
test("stop during asynchronous turn preparation cannot start a late agent turn", async t => {
  const root = await temporaryDirectory(t), store = new ChatStore(root); await store.initialize();
  let release, sends = 0;
  const manager = new RuntimeManager({ store, config: testConfig(root), broker: new CapabilityBroker({ ttlMs: 10000 }),
    models: { creationSettings: async () => ({}), turnSettings: () => new Promise(resolve => { release = resolve; }) },
    adapterFactory: () => ({ start: async () => {}, stop: async () => {}, send: async () => { sends++; return { text: "late" }; } }) });
  t.after(() => manager.shutdown()); const chat = await manager.createChat({ agent: "mock" });
  const submitted = await manager.submit(chat.id, "prepare"); await waitFor(() => release);
  await manager.stop(chat.id); release({}); await submitted.completion;
  assert.equal(sends, 0); assert.equal(store.get(chat.id).status, "stopped");
});
test("session info rereads counters that arrive while live inspection is pending", async t => {
  const root = await temporaryDirectory(t), store = new ChatStore(root); await store.initialize(); let hooks, finishInspect;
  const manager = new RuntimeManager({ store, config: testConfig(root, { AGENT_IDLE_TIMEOUT_MS: "10000" }), broker: new CapabilityBroker({ ttlMs: 10000 }),
    adapterFactory: ({ hooks: callbacks }) => { hooks = callbacks; return { start: async () => {}, stop: async () => {}, send: async () => ({ text: "done" }), inspect: () => new Promise(resolve => { finishInspect = resolve; }) }; } });
  t.after(() => manager.shutdown()); const chat = await manager.createChat({ agent: "mock" }); await manager.send(chat.id, "inspect");
  const info = manager.sessionInfo(chat.id); await waitFor(() => finishInspect);
  await hooks.onEvent({ type: "usage", usage: codexUsage({ last: { totalTokens: 200 }, total: { totalTokens: 200 }, modelContextWindow: 1000 }) });
  finishInspect({}); assert.equal((await info).usage.contextTokens, 200);
});
