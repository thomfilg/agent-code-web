import assert from "node:assert/strict";
import test from "node:test";
import { NativeSessionCheckpoints } from "../src/native-session-checkpoints.mjs";
import { AgentAccounts } from "../src/agent-accounts.mjs";
import { codexAccountFixture } from "./fixtures/codex-account.mjs";
import { waitFor } from "./helpers.mjs";
import { scopedKind } from "./fixtures/worker-lease-scope.mjs";
import { nativeId, nativeRow as record, nativeBundle, nativeFixture } from "./fixtures/native-session.mjs";

test("native checkpoint preserves exact private records and survives a new service; environment variable revisions do not erase it", async () => {
  const { records, chat, service } = await nativeFixture(), bundle = nativeBundle();
  const saved = await service.save(chat, bundle, 0);
  assert.equal(saved.revision, 1);
  const environment = await records.get(scopedKind("environment"), chat.environmentId);
  await records.put(scopedKind("environment"), chat.environmentId, { ...environment, revision: 2, variables: [{ name: "NEW_VARIABLE", value: "synthetic-only" }] });
  const resumed = await new NativeSessionCheckpoints({ records }).read(chat);
  assert.deepEqual(resumed.value.bundle, bundle);
  assert.match(Buffer.from(resumed.value.bundle.files[0].data, "base64").toString(), /private-opaque-fixture/);
  assert.equal(JSON.stringify(resumed.value).includes("synthetic-only"), false);
});

test("monotonic CAS accepts append-only native history and rejects stale, shortened or divergent snapshots", async () => {
  const { chat, service } = await nativeFixture();
  await service.save(chat, nativeBundle(), 0);
  const longer = nativeBundle(record("event_msg", { type: "task_complete", turn_id: nativeId }));
  const results = await Promise.allSettled([service.save(chat, longer, 1), service.save(chat, longer, 1)]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  await assert.rejects(service.save(chat, nativeBundle(), 2), { code: "HISTORY_DIVERGED" });
  const divergent = nativeBundle(); divergent.files[0].data = Buffer.from(Buffer.from(divergent.files[0].data, "base64").toString().replace("Original native", "Changed native")).toString("base64");
  await assert.rejects(service.save(chat, divergent, 2), { code: "HISTORY_DIVERGED" });
  assert.deepEqual((await service.read(chat)).value.bundle, longer);
});

test("a completed notification cannot certify a terminal checkpoint without that turn's recorded native marker", async () => {
  const f = await nativeFixture(); await f.service.save(f.chat, nativeBundle(), 0);
  await assert.rejects(f.service.save(f.chat, nativeBundle(), 1, { boundary: "turn-completed", turnId: nativeId }), { code: "TERMINAL_RECORD_NOT_FLUSHED" });
  const wrong = nativeBundle(record("event_msg", { type: "task_complete", turn_id: "22222222-2222-4222-8222-222222222222" }));
  await assert.rejects(f.service.save(f.chat, wrong, 1, { boundary: "turn-completed", turnId: nativeId }), { code: "TERMINAL_RECORD_NOT_FLUSHED" });
  assert.equal((await f.service.read(f.chat)).revision, 1);
  const exact = nativeBundle(record("event_msg", { type: "task_complete", turn_id: nativeId }));
  assert.equal((await f.service.save(f.chat, exact, 1, { boundary: "turn-completed", turnId: nativeId })).value.boundary, "turn-completed");
});

test("account, namespace, company, environment and native identity changes deny read and write, without deleting the saved checkpoint", async () => {
  for (const change of [
    async f => f.records.put("agent-account-disconnection", f.chat.agentAccountId, { ownerId: f.chat.ownerId }),
    async f => { const a = await f.records.get("agent-account", f.chat.agentAccountId); await f.records.put("agent-account", a.id, { ...a, status: "disconnected" }); },
    async f => { const a = await f.records.get("agent-account", f.chat.agentAccountId); await f.records.put("agent-account", a.id, { ...a, accountIdentity: "other-account" }); },
    async f => f.records.delete(scopedKind("company"), "acme"),
    async f => { const e = await f.records.get(scopedKind("environment"), f.chat.environmentId); await f.records.put(scopedKind("environment"), e.id, { ...e, companies: ["other"] }); },
    async f => f.records.put("chat", f.chat.id, { ...f.chat, agentSessionId: "22222222-2222-4222-8222-222222222222" }),
    async f => f.records.delete("chat", f.chat.id),
  ]) {
    const f = await nativeFixture(); await f.service.save(f.chat, nativeBundle(), 0); await change(f);
    await assert.rejects(f.service.read(f.chat)); await assert.rejects(f.service.save(f.chat, nativeBundle(), 1));
    assert.equal((await f.records.get("native-session", f.chat.id)).revision, 1);
  }
  const f = await nativeFixture(); await f.service.save(f.chat, nativeBundle(), 0);
  await assert.rejects(new NativeSessionCheckpoints({ records: f.records, isLegacy: () => true }).read(f.chat));
  await assert.rejects(f.service.read({ ...f.chat, ownerId: `user_${"b".repeat(32)}` }));
});

test("null environment is explicit and private; anonymous or host-account sessions have no checkpoint fallback", async () => {
  const f = await nativeFixture(); f.chat.environmentId = null; await f.records.put("chat", f.chat.id, f.chat);
  await f.service.save(f.chat, nativeBundle(), 0); assert.equal((await f.service.read(f.chat)).value.binding.environmentId, null);
  assert.equal(f.service.available({ ...f.chat, ownerId: null }), false);
  assert.equal(f.service.available({ ...f.chat, agentAccountId: null }), false);
  await assert.rejects(f.service.read({ ...f.chat, agentAccountId: null }), { code: "UNAVAILABLE" });
  assert.equal(f.service.available({ ...f.chat, repositories: [] }), false);
  await assert.rejects(f.service.read({ ...f.chat, repositories: [] }), { code: "UNAVAILABLE" });
  assert.equal((await f.service.read(f.chat)).value.binding.companyId, "acme", "a bound checkpoint is not moved to unassigned scope");
});

test("one actual AgentAccounts persisted record serves separately scoped companies without an account-company grant", async t => {
  const f = await nativeFixture();
  const client = codexAccountFixture(), accounts = new AgentAccounts({ records: f.records, clientFactory: client.factory });
  await accounts.initialize(); t.after(() => accounts.close());
  const pending = await accounts.begin(f.chat.ownerId, { provider: "codex", name: "Synthetic named account" });
  client.clients.at(-1).approve();
  await waitFor(() => accounts.list(f.chat.ownerId).find(account => account.id === pending.account.id)?.status === "connected");
  f.chat.agentAccountId = pending.account.id; await f.records.put("chat", f.chat.id, f.chat);
  assert.equal((await f.records.get("agent-account", f.chat.agentAccountId)).companies, undefined);
  await f.service.save(f.chat, nativeBundle(), 0);
  const other = { ...f.chat, id: `chat_${"d".repeat(32)}`, environmentId: null,
    repositories: [{ fullName: "other/project", companyId: "other", githubConnectionId: "other-github" }] };
  await f.records.put(scopedKind("company"), "other", { id: "other", name: "Other company" });
  await f.records.put("chat", other.id, other);
  await f.service.save(other, nativeBundle(), 0);
  assert.equal((await f.service.read(f.chat)).value.binding.companyId, "acme");
  assert.equal((await f.service.read(other)).value.binding.companyId, "other");
  await assert.rejects(f.service.read({ ...f.chat, repositories: other.repositories }), { code: "SCOPE_UNAVAILABLE" });
});

test("native snapshot transaction rejects async callbacks, rolls back failure and checks lifecycle inside the scope lock", async () => {
  const f = await nativeFixture(), scope = f.service.scope(f.chat);
  await assert.rejects(f.records.nativeSessionTransaction({ scope, expectedRevision: 0 }, async () => ({ scope })), { code: "ASYNC_TRANSITION_FORBIDDEN" });
  await assert.rejects(f.service.save(f.chat, nativeBundle(), 0, {}, () => { throw Error("stale runtime"); }), { code: "STORAGE_FAILURE" });
  assert.equal((await f.service.read(f.chat)).value, null);
  await f.service.save(f.chat, nativeBundle(), 0);
  await f.records.delete("chat", f.chat.id); await f.records.delete("native-session", f.chat.id);
  await assert.rejects(f.service.save(f.chat, nativeBundle(), 0));
  assert.equal(await f.records.get("native-session", f.chat.id), null, "late capture cannot recreate deleted private history");
});
