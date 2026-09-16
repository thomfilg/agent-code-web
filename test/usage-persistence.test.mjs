import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { RuntimeManager } from "../src/runtime-manager.mjs";
import { ChatStore } from "../src/store.mjs";
import { MemoryRecords } from "../src/database.mjs";
import { CapabilityBroker } from "../src/capabilities.mjs";
import { codexUsage } from "../src/session-info.mjs";
import { temporaryDirectory, testConfig } from "./helpers.mjs";

test("context and inspection snapshots survive worker stop and controller restart without worker files or a wake", async t => {
  const root = await temporaryDirectory(t), records = new MemoryRecords(), store = new ChatStore(path.join(root, "first"), records); await store.initialize();
  const manager = new RuntimeManager({ store, config: testConfig(root, { AGENT_IDLE_TIMEOUT_MS: "10000" }), broker: new CapabilityBroker({ ttlMs: 10000 }),
    adapterFactory: ({ hooks }) => ({ start: async () => {}, send: async () => { await hooks.onEvent({ type: "usage", usage: codexUsage({ last: { totalTokens: 137200 }, total: { totalTokens: 200000 }, modelContextWindow: 1000000 }) }); return { text: "done" }; },
      inspect: async () => ({ account: { planType: "Test plan" }, rateLimits: [{ id: "codex", windows: [{ minutes: 300, usedPercent: 11 }] }] }),
      stop: async () => { void hooks.onEvent({ type: "context_usage", usage: { contextTokens: 155100, recordedAt: "2026-09-14T20:00:00.000Z" } }); } }) });
  t.after(() => manager.shutdown()); const chat = await manager.createChat({ agent: "mock" }); await manager.send(chat.id, "report usage");
  assert.equal((await manager.sessionInfo(chat.id)).usage.contextTokens, 137200); await manager.stop(chat.id);
  const storeAfterRestart = new ChatStore(path.join(root, "fresh-empty-control-directory"), records); await storeAfterRestart.initialize();
  let starts = 0; const restarted = new RuntimeManager({ store: storeAfterRestart, config: testConfig(root), broker: new CapabilityBroker({ ttlMs: 10000 }), adapterFactory: () => { starts++; throw new Error("Must not wake"); } });
  t.after(() => restarted.shutdown()); const info = await restarted.sessionInfo(chat.id);
  assert.equal(info.usage.contextTokens, 155100); assert.equal(info.usage.contextWindow, 1000000); assert.equal(info.recordedAt, "2026-09-14T20:00:00.000Z");
  assert.equal(info.account.planType, "Test plan"); assert.equal(info.rateLimits[0].windows[0].usedPercent, 11); assert.equal(info.snapshot, true); assert.equal(info.canCompact, true); assert.equal(starts, 0);
});
