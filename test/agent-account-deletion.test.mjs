import assert from "node:assert/strict";
import test from "node:test";
import { AgentAccounts } from "../src/agent-accounts.mjs";
import { MemoryRecords } from "../src/database.mjs";
import { codexAccountFixture } from "./fixtures/codex-account.mjs";
import { claudeAccountFixture } from "./fixtures/claude-account.mjs";
import { waitFor } from "./helpers.mjs";

const alice = `user_${"a".repeat(32)}`, bob = `user_${"b".repeat(32)}`;
const input = provider => ({ provider, name: "Personal", companies: [], allowUnassigned: true });
async function setup(t, provider) {
  const records = new MemoryRecords(), fixture = provider === "claude" ? claudeAccountFixture() : codexAccountFixture();
  const revoked = [], accounts = new AgentAccounts({ records, clientFactory: fixture.factory, onRevoke: async (owner, id) => {
    revoked.push({ owner, id }); await assert.rejects(() => accounts.select(owner, id, { agent: provider }), { statusCode: accounts.removing.has(id) ? 404 : 409 });
  } });
  await accounts.initialize(); t.after(() => accounts.close());
  const { account } = await accounts.begin(alice, input(provider));
  return { accounts, records, fixture, revoked, id: account.id };
}

for (const provider of ["codex", "claude"]) {
  test(`${provider} deletion erases only the owner's selected account, cancels consent and survives restart`, async t => {
    const { accounts, records, fixture, revoked, id } = await setup(t, provider);
    const first = fixture.clients[0];
    await assert.rejects(() => accounts.remove(bob, id), { statusCode: 404 });
    assert.notEqual(first.cancelled, true);
    const other = await accounts.begin(alice, { ...input(provider), name: "Company" });
    assert.deepEqual(await accounts.remove(alice, id), { deleted: true, id });
    first.approve(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(first.closed, true); assert.equal(await records.get("agent-account", id), null);
    assert.deepEqual(accounts.list(alice).map(account => account.id), [other.account.id]);
    assert.deepEqual(revoked, [{ owner: alice, id }]);
    for (const action of [() => accounts.status(alice, id), () => accounts.begin(alice, { ...input(provider), id }),
      () => accounts.credentials(alice, id, { agent: provider }), () => accounts.models(alice, id)]) await assert.rejects(action, { statusCode: 404 });
    const restarted = new AgentAccounts({ records, clientFactory: fixture.factory }); await restarted.initialize(); t.after(() => restarted.close());
    assert.equal(restarted.list(alice).some(account => account.id === id), false);
  });

  for (const phase of ["snapshot", "persistence", "refresh", "models", "starting"]) test(`${provider} deletion wins during gated ${phase} and rejects queued replacement without credential resurrection`, async t => {
    const { accounts, records, fixture, id } = await setup(t, provider);
    const gate = Promise.withResolvers(), entered = Promise.withResolvers();
    let operation;
    if (["refresh", "models", "starting"].includes(phase)) {
      fixture.clients[0].approve(); await waitFor(() => accounts.hasConnected(alice, provider));
      const factory = accounts.clientFactory;
      accounts.clientFactory = () => {
        const client = factory(), start = client.start.bind(client);
        client.start = async (...args) => { entered.resolve(); await gate.promise; return start(...args); };
        return client;
      };
      if (phase === "starting") { await accounts.disconnect(alice, id); operation = accounts.begin(alice, { ...input(provider), id }); }
      else operation = phase === "refresh" ? accounts.credentials(alice, id, { agent: provider }) : accounts.models(alice, id);
      operation.catch(() => {});
    } else {
      if (phase === "snapshot") {
        const client = fixture.clients[0], snapshot = client.snapshot.bind(client);
        client.snapshot = async (...args) => { entered.resolve(); await gate.promise; return snapshot(...args); };
      } else {
        const put = records.put.bind(records);
        records.put = async (...args) => { await put(...args); if (args[2].status === "connected") { entered.resolve(); await gate.promise; } };
      }
      fixture.clients[0].approve();
    }
    await entered.promise;
    const replacing = accounts.begin(alice, { ...input(provider), id }); replacing.catch(() => {});
    await new Promise(resolve => setImmediate(resolve));
    const deleting = accounts.remove(alice, id);
    await assert.rejects(() => accounts.select(alice, id, { agent: provider }), { statusCode: 404 });
    assert.equal(accounts.hasConnected(alice, provider), false);
    gate.resolve(); await deleting;
    await assert.rejects(replacing, { statusCode: 404 });
    if (operation) await assert.rejects(operation, { statusCode: 404 });
    assert.equal(await records.get("agent-account", id), null); assert.deepEqual(accounts.list(alice), []);
    assert.equal(accounts.flows.has(id), false); assert.ok(fixture.clients.every(client => client.closed));
  });
}

test("failed erasure durably disconnects and blocks access until the owner retries; concurrent deletion is one operation", async t => {
  const { accounts, records, fixture, revoked, id } = await setup(t, "codex");
  fixture.clients[0].approve(); await waitFor(() => accounts.hasConnected(alice, "codex"));
  const erase = records.delete.bind(records); let failOnce = true;
  records.delete = async (...args) => { if (failOnce) { failOnce = false; throw Error("private database diagnostic"); } return erase(...args); };
  const first = accounts.remove(alice, id), second = accounts.remove(alice, id);
  await Promise.all([assert.rejects(first, { statusCode: 503 }), assert.rejects(second, { statusCode: 503 })]);
  assert.equal(revoked.length, 1); assert.equal((await records.get("agent-account", id)).auth, null);
  assert.doesNotMatch(JSON.stringify(accounts.list(alice)), /private database/);
  await assert.rejects(() => accounts.credentials(alice, id, { agent: "codex" }), { statusCode: 404 });
  await accounts.remove(alice, id); assert.equal(await records.get("agent-account", id), null);
});

test("failed worker stop retains a retryable account card without retaining credentials", async t => {
  const { accounts, records, id } = await setup(t, "claude");
  accounts.onRevoke = async () => { throw Error("private worker diagnostic"); };
  await assert.rejects(() => accounts.remove(alice, id), { statusCode: 503 });
  assert.equal(await records.get("agent-account", id), null); assert.equal(accounts.list(alice)[0].status, "disconnected");
  accounts.onRevoke = async () => {};
  await accounts.remove(alice, id); assert.deepEqual(accounts.list(alice), []);
});
