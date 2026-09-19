import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { mkdir } from "node:fs/promises";
import { CodexAdapter } from "../src/adapters/codex.mjs";
import { ChatStore } from "../src/store.mjs";
import { CapabilityBroker } from "../src/capabilities.mjs";
import { MemoryRecords } from "../src/database.mjs";
import { NativeSessionCheckpoints } from "../src/native-session-checkpoints.mjs";
import { temporaryDirectory, testConfig } from "./helpers.mjs";

for (const threadId of ["thr_missing", "thr_wrong_identity"]) test(`ordinary resume ${threadId} cannot silently start a blank conversation`, async t => {
  const root = await temporaryDirectory(t), store = new ChatStore(root); await store.initialize();
  const chat = await store.create({ title: "Preserved history", agent: "codex", agentAccountId: "selected-account" });
  await store.update(chat.id, { agentSessionId: threadId }); await mkdir(chat.workspace, { recursive: true, mode: 0o700 });
  const assigned = [], adapter = new CodexAdapter({ chat: store.get(chat.id), store, broker: new CapabilityBroker({ ttlMs: 10000 }),
    config: testConfig(root, { CODEX_BIN: path.resolve("test/fixtures/fake-codex.mjs") }),
    hooks: { onSessionId: id => assigned.push(id), accountCredentials: async () => ({ accessToken: "synthetic-only", chatgptAccountId: "fixture" }) } });
  t.after(() => adapter.stop());
  await assert.rejects(adapter.start(), /preserv|resume|history|identity/i);
  assert.equal(adapter.threadId, threadId); assert.equal(store.get(chat.id).agentSessionId, threadId);
  assert.deepEqual(assigned, [], "no replacement session ID was published");
});

test("repo-less named chats retain exact native resume without claiming checkpoint support", async t => {
  const root = await temporaryDirectory(t), records = new MemoryRecords(), store = new ChatStore(root, records); await store.initialize();
  const chat = await store.create({ title: "Unassigned native conversation", agent: "codex", agentAccountId: "account_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", ownerId: `user_${"a".repeat(32)}` });
  const threadId = "11111111-1111-4111-8111-111111111111";
  await store.update(chat.id, { agentSessionId: threadId }); await mkdir(chat.workspace, { recursive: true, mode: 0o700 });
  const nativeSessions = new NativeSessionCheckpoints({ records }), assigned = [];
  assert.equal(nativeSessions.available(store.get(chat.id)), false);
  const adapter = new CodexAdapter({ chat: store.get(chat.id), store, nativeSessions, broker: new CapabilityBroker({ ttlMs: 10000 }),
    config: testConfig(root, { CODEX_BIN: path.resolve("test/fixtures/fake-codex.mjs") }),
    hooks: { onSessionId: id => assigned.push(id), accountCredentials: async () => ({ accessToken: "synthetic-only", chatgptAccountId: "fixture" }) } });
  t.after(() => adapter.stop()); await adapter.start();
  assert.equal(adapter.threadId, threadId); assert.deepEqual(assigned, []);
  assert.equal(await records.get("native-session", chat.id), null);
});
