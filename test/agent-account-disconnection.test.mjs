import assert from "node:assert/strict";
import test from "node:test";
import { AgentAccounts } from "../src/agent-accounts.mjs";
import { MemoryRecords } from "../src/database.mjs";
import { codexAccountFixture } from "./fixtures/codex-account.mjs";
import { claudeAccountFixture } from "./fixtures/claude-account.mjs";
import { waitFor } from "./helpers.mjs";

const owner = `user_${"a".repeat(32)}`, foreign = `user_${"b".repeat(32)}`;
async function setup(t, provider) {
  const records = new MemoryRecords(), fixture = provider === "claude" ? claudeAccountFixture() : codexAccountFixture();
  const revoked = [], accounts = new AgentAccounts({ records, clientFactory: fixture.factory, onRevoke: async (...args) => { revoked.push(args); } });
  await accounts.initialize(); t.after(() => accounts.close());
  const { account } = await accounts.begin(owner, { provider, name: "Selected" });
  fixture.clients[0].approve(); await waitFor(() => accounts.hasConnected(owner, provider));
  return { accounts, records, fixture, revoked, id: account.id };
}

for (const provider of ["codex", "claude"]) for (const phase of ["refresh", "persistence", "models", "close"]) {
  test(`${provider} disconnect immediately denies admission and late ${phase} results`, async t => {
    const { accounts, records, fixture, revoked, id } = await setup(t, provider);
    const entered = Promise.withResolvers(), gate = Promise.withResolvers();
    t.after(() => gate.resolve());
    if (phase === "persistence") {
      const put = records.put.bind(records);
      records.put = async (...args) => { await put(...args); if (args[2].auth) { entered.resolve(); await gate.promise; } };
    } else {
      const factory = accounts.clientFactory;
      accounts.clientFactory = () => {
        const client = factory(), method = phase === "close" ? "close" : "start", original = client[method].bind(client);
        client[method] = async (...args) => { entered.resolve(); await gate.promise; return original(...args); };
        return client;
      };
    }
    await assert.rejects(() => accounts.disconnect(foreign, id), { statusCode: 404 });
    assert.equal(accounts.hasConnected(owner, provider), true);
    const operation = phase === "models" ? accounts.models(owner, id) : accounts.credentials(owner, id, { agent: provider }, { refresh: true });
    operation.catch(() => {}); await entered.promise;
    const disconnecting = accounts.disconnect(owner, id); disconnecting.catch(() => {});
    // Release the gate even when assertions fail so test cleanup cannot hang.
    try {
      await assert.rejects(() => accounts.select(owner, id, { agent: provider }), { statusCode: 409 });
      assert.equal(accounts.hasConnected(owner, provider), false);
      await new Promise(resolve => setImmediate(resolve));
      assert.deepEqual(revoked, [[owner, id]], "stop active workers without waiting for a credential refresh");
    } finally { gate.resolve(); }
    await disconnecting;
    await assert.rejects(operation, { statusCode: 409 });
    assert.equal((await records.get("agent-account", id)).auth, null);
    assert.equal(accounts.list(owner)[0].status, "disconnected");
    assert.ok(fixture.clients.every(client => client.closed));
    // Same named identity can reconnect after revocation finishes.
    await accounts.begin(owner, { provider, name: "Selected", id });
    fixture.clients.at(-1).approve(); await waitFor(() => accounts.hasConnected(owner, provider));
  });
}

for (const failure of ["storage", "worker"]) test(`failed ${failure} disconnection remains blocked until an owner retries`, async t => {
  const { accounts, records, id } = await setup(t, "codex");
  if (failure === "storage") {
    const put = records.put.bind(records); let failOnce = true;
    records.put = async (...args) => { if (failOnce && args[0] === "agent-account" && !args[2].auth) { failOnce = false; throw Error("private-storage-error"); } return put(...args); };
  } else accounts.onRevoke = async () => { throw Error("private-worker-error"); };
  await assert.rejects(() => accounts.disconnect(owner, id), { statusCode: 503 });
  await assert.rejects(() => accounts.select(owner, id, { agent: "codex" }), { statusCode: 409 });
  await assert.rejects(() => accounts.begin(owner, { id, provider: "codex", name: "Selected" }), { statusCode: 409 });
  assert.equal(accounts.hasConnected(owner, "codex"), false);
  assert.equal(accounts.list(owner)[0].status, "disconnecting");
  assert.doesNotMatch(JSON.stringify(await accounts.status(owner, id)), /private-storage-error|private-worker-error/);
  accounts.onRevoke = async () => {};
  await accounts.disconnect(owner, id);
  assert.equal(accounts.disconnecting.has(id), false);
  assert.equal((await records.get("agent-account", id)).auth, null);
});

test("failed credential erase restores its durable disconnect barrier after controller restart", async t => {
  const { accounts, records, fixture, id } = await setup(t, "codex"), put = records.put.bind(records);
  records.put = async (...args) => { if (args[0] === "agent-account" && !args[2].auth) throw Error("private-storage-error"); return put(...args); };
  await assert.rejects(() => accounts.disconnect(owner, id), { statusCode: 503 });
  assert.ok((await records.get("agent-account", id)).auth);
  assert.deepEqual(await records.get("agent-account-disconnection", id), { id, ownerId: owner });
  await accounts.close();
  const restarted = new AgentAccounts({ records, clientFactory: fixture.factory }); await restarted.initialize(); t.after(() => restarted.close());
  const clients = fixture.clients.length;
  assert.equal(restarted.list(owner)[0].status, "disconnecting");
  for (const action of [() => restarted.credentials(owner, id, { agent: "codex" }), () => restarted.models(owner, id),
    () => restarted.begin(owner, { id, provider: "codex", name: "Selected" })]) await assert.rejects(action, { statusCode: 409 });
  assert.equal(fixture.clients.length, clients, "restart cannot start auth using the old credential row");
  records.put = put; await restarted.disconnect(owner, id);
  assert.equal(await records.get("agent-account-disconnection", id), null);
  assert.equal((await records.get("agent-account", id)).auth, null);
  assert.equal(restarted.list(owner)[0].status, "disconnected");
});

test("intent cleanup failure leaves a retryable barrier even after credentials and workers are gone", async t => {
  const { accounts, records, id } = await setup(t, "claude"), erase = records.delete.bind(records); let failOnce = true;
  records.delete = async (...args) => { if (args[0] === "agent-account-disconnection" && failOnce) { failOnce = false; throw Error("private-delete-error"); } return erase(...args); };
  await assert.rejects(() => accounts.disconnect(owner, id), { statusCode: 503 });
  assert.equal((await records.get("agent-account", id)).auth, null);
  assert.equal(accounts.list(owner)[0].status, "disconnecting");
  await accounts.disconnect(owner, id);
  assert.equal(await records.get("agent-account-disconnection", id), null);
  assert.equal(accounts.disconnecting.has(id), false);
});

test("startup does not apply a disconnection marker owned by another user or missing account", async t => {
  const { accounts, records, fixture, id } = await setup(t, "codex");
  await records.put("agent-account-disconnection", id, { id, ownerId: foreign });
  await records.put("agent-account-disconnection", "missing-account", { id: "missing-account", ownerId: owner });
  const restarted = new AgentAccounts({ records, clientFactory: fixture.factory }); await restarted.initialize(); t.after(() => restarted.close());
  assert.equal((await restarted.select(owner, id, { agent: "codex" })).id, id);
  assert.equal(restarted.disconnecting.size, 0);
});

test("deletion can finish a failed disconnect without leaving credentials or revocation barriers behind", async t => {
  const { accounts, records, id } = await setup(t, "claude");
  accounts.onRevoke = async () => { throw Error("private-worker-error"); };
  await assert.rejects(() => accounts.disconnect(owner, id), { statusCode: 503 });
  accounts.onRevoke = async () => {};
  await accounts.remove(owner, id);
  assert.equal(await records.get("agent-account", id), null);
  assert.equal(accounts.disconnecting.has(id), false); assert.equal(accounts.removing.has(id), false);
  assert.deepEqual(accounts.list(owner), []);
});

test("parallel disconnect requests share worker revocation and keep reconnect blocked until it finishes", async t => {
  const { accounts, records, id } = await setup(t, "codex");
  const entered = Promise.withResolvers(), gate = Promise.withResolvers(); let revocations = 0;
  accounts.onRevoke = async () => { revocations++; entered.resolve(); await gate.promise; };
  const first = accounts.disconnect(owner, id), second = accounts.disconnect(owner, id);
  await entered.promise;
  try {
    await assert.rejects(() => accounts.begin(owner, { id, provider: "codex", name: "Selected" }), { statusCode: 409 });
    assert.equal(revocations, 1);
    await waitFor(async () => !(await records.get("agent-account", id)).auth);
    assert.equal(accounts.disconnecting.has(id), true);
  } finally { gate.resolve(); }
  await Promise.all([first, second]); assert.equal(accounts.disconnecting.has(id), false);
});

test("deletion wins a concurrent disconnect and gated credential refresh without leaving a durable intent", async t => {
  const { accounts, records, id } = await setup(t, "codex"), factory = accounts.clientFactory;
  const entered = Promise.withResolvers(), gate = Promise.withResolvers();
  accounts.clientFactory = () => {
    const client = factory(), start = client.start.bind(client);
    client.start = async (...args) => { entered.resolve(); await gate.promise; return start(...args); }; return client;
  };
  const refresh = accounts.credentials(owner, id, { agent: "codex" }); refresh.catch(() => {}); await entered.promise;
  const disconnecting = accounts.disconnect(owner, id); disconnecting.catch(() => {});
  const deleting = accounts.remove(owner, id); deleting.catch(() => {}); gate.resolve();
  await deleting; await Promise.allSettled([disconnecting]); await assert.rejects(refresh, { statusCode: 404 });
  assert.equal(await records.get("agent-account", id), null);
  assert.equal(await records.get("agent-account-disconnection", id), null);
  assert.deepEqual(accounts.list(owner), []); assert.equal(accounts.disconnecting.has(id), false);
});

test("deletion waits for a delayed disconnection intent before removing its account and marker", async t => {
  const { accounts, records, id } = await setup(t, "codex"), put = records.put.bind(records);
  const entered = Promise.withResolvers(), gate = Promise.withResolvers();
  records.put = async (...args) => { if (args[0] === "agent-account-disconnection") { entered.resolve(); await gate.promise; } return put(...args); };
  const disconnecting = accounts.disconnect(owner, id); disconnecting.catch(() => {}); await entered.promise;
  let deleted = false; const deleting = accounts.remove(owner, id).then(() => { deleted = true; });
  await new Promise(resolve => setImmediate(resolve));
  try { assert.equal(deleted, false); } finally { gate.resolve(); }
  await deleting; await Promise.allSettled([disconnecting]);
  assert.equal(await records.get("agent-account", id), null);
  assert.equal(await records.get("agent-account-disconnection", id), null);
});

test("failed intent write still persists retry through credential erasure when worker stop fails", async t => {
  const { accounts, records, fixture, id } = await setup(t, "claude"), put = records.put.bind(records);
  records.put = async (...args) => { if (args[0] === "agent-account-disconnection") throw Error("private-intent-error"); return put(...args); };
  accounts.onRevoke = async () => { throw Error("private-worker-error"); };
  await assert.rejects(() => accounts.disconnect(owner, id), { statusCode: 503 });
  assert.equal((await records.get("agent-account", id)).auth, null);
  assert.equal((await records.get("agent-account", id)).status, "disconnecting");
  await accounts.close();
  const restarted = new AgentAccounts({ records, clientFactory: fixture.factory }); await restarted.initialize(); t.after(() => restarted.close());
  assert.equal(restarted.list(owner)[0].status, "disconnecting");
  await assert.rejects(() => restarted.begin(owner, { id, provider: "claude", name: "Selected" }), { statusCode: 409 });
  records.put = put; await restarted.disconnect(owner, id);
  assert.equal(restarted.list(owner)[0].status, "disconnected");
});
