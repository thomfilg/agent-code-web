import test from "node:test";
import assert from "node:assert/strict";
import { chatExpired, ChatRetention } from "../src/chat-retention.mjs";
import { loadConfig } from "../src/config.mjs";
import { ChatStore } from "../src/store.mjs";
import { RuntimeManager } from "../src/runtime-manager.mjs";
import { CapabilityBroker } from "../src/capabilities.mjs";
import { temporaryDirectory, testConfig } from "./helpers.mjs";

const DAY = 86_400_000;
const now = Date.parse("2026-09-24T12:00:00.000Z");
const chat = (id, ageDays, patch = {}) => ({ id, status: "stopped", createdAt: new Date(now - ageDays * DAY).toISOString(), lastActivityAt: new Date(now - ageDays * DAY).toISOString(), ...patch });

test("chat retention defaults to seven days and can be changed or disabled", () => {
  assert.equal(loadConfig().chatRetentionDays, 7);
  assert.equal(loadConfig({ AGENT_CHAT_RETENTION_DAYS: "30" }).chatRetentionDays, 30);
  assert.equal(loadConfig({ AGENT_CHAT_RETENTION_DAYS: "0" }).chatRetentionDays, 0);
  assert.throws(() => loadConfig({ AGENT_CHAT_RETENTION_DAYS: "-1" }), /AGENT_CHAT_RETENTION_DAYS/);
  assert.throws(() => loadConfig({ AGENT_CHAT_RETENTION_DAYS: "1.5" }), /AGENT_CHAT_RETENTION_DAYS/);
});

test("retention uses chat activity, never generic updatedAt or a browser view", () => {
  assert.equal(chatExpired(chat("old", 8, { updatedAt: new Date(now).toISOString() }), { now, days: 7 }), true);
  assert.equal(chatExpired(chat("recent", 6), { now, days: 7 }), false);
  assert.equal(chatExpired(chat("invalid", 8, { lastActivityAt: "invalid" }), { now, days: 7 }), false);
  assert.equal(chatExpired(chat("queued", 8, { queuedMessages: [{ id: "q" }] }), { now, days: 7 }), false);
  assert.equal(chatExpired(chat("running", 8, { status: "running" }), { now, days: 7 }), false);
  assert.equal(chatExpired(chat("busy", 8), { now, days: 7, isBusy: () => true }), false);
});

test("retention rechecks current state, deletes expired chats, and isolates deletion failures", async () => {
  const rows = new Map([["stale", chat("stale", 8)], ["fresh", chat("fresh", 6)], ["failed", chat("failed", 9)]]);
  const deleted = [], errors = [];
  const service = new ChatRetention({
    store: { list: () => [...rows.values()], get: id => rows.get(id) },
    manager: { isBusy: () => false, removeExpired: async id => { deleted.push(id); if (id === "failed") throw new Error("worker failed"); rows.delete(id); return { removed: true }; } },
    days: 7, now: () => now, log: { info() {}, warn() {}, error: message => errors.push(message) },
  });
  await service.run();
  assert.deepEqual(deleted, ["stale", "failed"]);
  assert.equal(rows.has("stale"), false);
  assert.equal(rows.has("fresh"), true);
  assert.match(errors[0], /worker failed/);
});

test("runtime deletion rechecks the inactivity deadline before destroying a worker", async t => {
  const root = await temporaryDirectory(t), store = new ChatStore(root);
  await store.initialize();
  const destroyed = [];
  const manager = new RuntimeManager({ store, config: testConfig(root), broker: new CapabilityBroker({ ttlMs: 10000 }),
    workerBackend: { destroy: async value => destroyed.push(value.id), shutdown: async () => {} },
    adapterFactory: () => { throw Error("No agent turn should start"); } });
  t.after(() => manager.shutdown());
  const created = await store.create({ agent: "mock", title: "Expiry fence" });
  const cutoff = now - 7 * DAY;
  assert.equal((await manager.removeExpired(created.id, cutoff)).skipped, true);
  await store.update(created.id, { lastActivityAt: new Date(now - 8 * DAY).toISOString(), queuedMessages: [{ id: "queued" }] });
  assert.equal((await manager.removeExpired(created.id, cutoff)).skipped, true);
  await store.update(created.id, { queuedMessages: [] });
  assert.equal((await manager.removeExpired(created.id, cutoff)).removed, true);
  assert.equal(store.get(created.id), null);
  assert.deepEqual(destroyed, []);
});
