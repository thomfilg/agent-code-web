import test from "node:test";
import assert from "node:assert/strict";
import { claudeUsage, claudeContext, claudeRateLimits, codexUsage, mergeUsage } from "../src/session-info.mjs";
import { RuntimeManager } from "../src/runtime-manager.mjs";
import { ChatStore } from "../src/store.mjs";
import { CapabilityBroker } from "../src/capabilities.mjs";
import { temporaryDirectory, testConfig, waitFor } from "./helpers.mjs";
import { groupTools } from "../public/tool-activity.js";

test("Codex compaction queues behind active work, preserves FIFO, and can wake a stopped session", async t => {
  const root = await temporaryDirectory(t), store = new ChatStore(root); await store.initialize();
  const calls = []; let release;
  const manager = new RuntimeManager({ store, config: testConfig(root, { AGENT_IDLE_TIMEOUT_MS: "10000" }), broker: new CapabilityBroker({ ttlMs: 10000 }),
    commands: { list: async () => ({ commands: [{ name: "compact", web: true }] }) },
    adapterFactory: () => ({ start: async () => {}, stop: async () => {}, compact: async () => { calls.push("compact"); }, send: async text => {
      if (text.includes("hold this turn")) { calls.push("first"); await new Promise(resolve => { release = resolve; }); }
      else calls.push("after");
      return { text: "Done" };
    } }) });
  t.after(() => manager.shutdown()); const chat = await manager.createChat({ agent: "codex", title: "Compaction fixture" });
  const first = await manager.submit(chat.id, "hold this turn"); await waitFor(() => release);
  const queued = await manager.compact(chat.id); assert.equal(queued.queuedMessages[0].text, "/compact");
  await manager.enqueue(chat.id, "after compaction"); assert.deepEqual(calls, ["first"]);
  release(); await first.completion; await waitFor(() => calls.length === 3 && !manager.isBusy(chat.id));
  assert.deepEqual(calls, ["first", "compact", "after"]);
  assert.deepEqual(store.get(chat.id).messages.filter(message => message.role === "user").map(message => message.text), ["hold this turn", "/compact", "after compaction"]);
  await manager.stop(chat.id); assert.equal((await manager.sessionInfo(chat.id)).canCompact, true);
  await manager.compact(chat.id); assert.equal(calls.at(-1), "compact"); assert.equal(calls.length, 4);
});
test("Claude queued compaction is sent as the exact native /compact input, without Codex-only restrictions", async t => {
  const root = await temporaryDirectory(t), store = new ChatStore(root); await store.initialize();
  const calls = []; let release;
  const manager = new RuntimeManager({ store, config: testConfig(root), broker: new CapabilityBroker({ ttlMs: 10000 }),
    adapterFactory: () => ({ start: async () => {}, stop: async () => {}, send: async text => { calls.push(text); if (text === "hold") await new Promise(resolve => { release = resolve; }); return { text: "Done" }; } }) });
  t.after(() => manager.shutdown()); const chat = await manager.createChat({ agent: "claude", title: "Claude compact fixture" });
  const first = await manager.submit(chat.id, "hold"); await waitFor(() => release);
  await manager.compact(chat.id); release(); await first.completion; await waitFor(() => calls.length === 2 && !manager.isBusy(chat.id));
  assert.deepEqual(calls, ["hold", "/compact"]);
});

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
test("a queued message eventually drains when only background work, not a foreground turn, keeps the adapter busy", async t => {
  const root = await temporaryDirectory(t), store = new ChatStore(root); await store.initialize();
  const calls = []; let backgroundBusy = false;
  const manager = new RuntimeManager({ store, config: testConfig(root, { AGENT_IDLE_TIMEOUT_MS: "10000" }), broker: new CapabilityBroker({ ttlMs: 10000 }),
    adapterFactory: () => ({ start: async () => {}, stop: async () => {}, isBackgroundBusy: () => backgroundBusy,
      send: async text => { calls.push(text); return { text: "done" }; } }) });
  t.after(() => manager.shutdown());
  const chat = await manager.createChat({ agent: "mock" });
  await manager.send(chat.id, "first");
  backgroundBusy = true;
  await manager.enqueue(chat.id, "second");
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(calls.length, 1, "the queue must not drain while the adapter reports background work, even with no active foreground turn");
  backgroundBusy = false;
  await waitFor(() => calls.length === 2, { timeoutMs: 3000 });
  assert.deepEqual(calls, ["first", "second"]);
  await manager.stop(chat.id);
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

async function queueFixture(t, options = {}) {
  const root = await temporaryDirectory(t), store = new ChatStore(root); await store.initialize();
  const calls = []; let release, interruptions = 0, stops = 0;
  const manager = new RuntimeManager({ store, config: testConfig(root, { AGENT_IDLE_TIMEOUT_MS: "10000" }), broker: new CapabilityBroker({ ttlMs: 10000 }),
    adapterFactory: () => ({ start: async () => {},
      stop: async () => { stops++; release?.({ text: "stopped" }); },
      interrupt: async () => { interruptions++; await options.interrupt?.(); release?.({ text: "interrupted" }); },
      send: text => { calls.push(text); return new Promise(resolve => { release = resolve; }); } }), ...options.manager });
  t.after(() => manager.shutdown()); const chat = await manager.createChat({ agent: "mock" });
  return { store, manager, chat, calls, complete: () => release?.({ text: "done" }), interruptions: () => interruptions, stops: () => stops };
}

test("Send all now interrupts once and submits every user item with the clicked item first", async t => {
  const f = await queueFixture(t), { manager, store, chat, calls } = f;
  const first = await manager.submit(chat.id, "first"); await waitFor(() => calls.length === 1);
  await manager.enqueue(chat.id, "second"); await manager.enqueue(chat.id, "third"); await manager.enqueue(chat.id, "fourth");
  const selected = store.get(chat.id).queuedMessages[1];
  await Promise.all([manager.editQueue(chat.id, { sendNowId: selected.id }), manager.editQueue(chat.id, { sendNowId: selected.id })]);
  await first.completion; await waitFor(() => calls.length === 2);
  assert.deepEqual(calls, ["first", "third\n\n---\n\nsecond\n\n---\n\nfourth"]); assert.equal(f.interruptions(), 1); assert.equal(f.stops(), 0);
  assert.deepEqual(store.get(chat.id).queuedMessages, []);
  await assert.rejects(manager.editQueue(chat.id, { sendNowId: selected.id }), /not found/); assert.equal(f.interruptions(), 1);
  f.complete(); await waitFor(() => !manager.isBusy(chat.id)); assert.equal(store.get(chat.id).queuedMessages.length, 0);
});

test("Send all now drains a paused user queue immediately", async t => {
  const f = await queueFixture(t), { manager, store, chat, calls } = f;
  await store.update(chat.id, { queuePaused: true }); await manager.enqueue(chat.id, "later"); await manager.enqueue(chat.id, "now");
  await assert.rejects(manager.editQueue(chat.id, { sendNowId: "wrong-chat-message" }), /not found/);
  const id = store.get(chat.id).queuedMessages[1].id; await manager.editQueue(chat.id, { sendNowId: id });
  await waitFor(() => calls.length === 1); f.complete(); await waitFor(() => !manager.isBusy(chat.id));
  assert.deepEqual(calls, ["now\n\n---\n\nlater"]); assert.equal(f.interruptions(), 0);
  assert.equal(store.get(chat.id).queuePaused, false); assert.equal(store.get(chat.id).queuedMessages.length, 0);
});

test("manual Stop wins over an in-flight Send now and retains the queued input", async t => {
  let finishInterrupt;
  const f = await queueFixture(t, { interrupt: () => new Promise(resolve => { finishInterrupt = resolve; }) }), { manager, store, chat, calls } = f;
  await manager.submit(chat.id, "first"); await waitFor(() => calls.length === 1);
  await manager.enqueue(chat.id, "never send after stop"); const id = store.get(chat.id).queuedMessages[0].id;
  const sending = manager.editQueue(chat.id, { sendNowId: id });
  await waitFor(() => finishInterrupt); const stopping = manager.stop(chat.id); finishInterrupt(); await Promise.all([stopping, sending]);
  assert.deepEqual(calls, ["first"]); assert.equal(store.get(chat.id).queuePaused, true);
  assert.equal(store.get(chat.id).queuedMessages[0].id, id); assert.equal(store.get(chat.id).status, "stopped");
});

test("Send now cancels asynchronous turn preparation before the old prompt reaches an agent", async t => {
  let finishSettings, preparations = 0;
  const f = await queueFixture(t, { manager: { models: { creationSettings: async () => ({}), turnSettings: () => ++preparations === 1 ? new Promise(resolve => { finishSettings = resolve; }) : {} } } });
  const { manager, store, chat, calls } = f;
  await manager.submit(chat.id, "old prompt"); await waitFor(() => finishSettings);
  await manager.enqueue(chat.id, "priority"); const id = store.get(chat.id).queuedMessages[0].id;
  const sending = manager.editQueue(chat.id, { sendNowId: id }); finishSettings({}); await sending;
  await waitFor(() => calls.length === 1); assert.deepEqual(calls, ["priority"]); f.complete(); await waitFor(() => !manager.isBusy(chat.id));
});

test("failed Send now keeps its attachments and the selected message for retry", async t => {
  let rejectAttachment = false;
  const f = await queueFixture(t, { manager: { attachments: { resolve: async (_id, ids) => { if (rejectAttachment) throw new Error("Attachment unavailable"); assert.deepEqual(ids, ["upload-1"]); return []; } } } });
  const { manager, store, chat } = f; await store.update(chat.id, { queuePaused: true });
  await manager.enqueue(chat.id, "with file", ["upload-1"]); const selected = store.get(chat.id).queuedMessages[0]; rejectAttachment = true;
  await assert.rejects(manager.editQueue(chat.id, { sendNowId: selected.id }), /Attachment unavailable/);
  assert.deepEqual(store.get(chat.id).queuedMessages, [selected]); assert.equal(manager.isBusy(chat.id), false);
});
