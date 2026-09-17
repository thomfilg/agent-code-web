import assert from "node:assert/strict";
import test from "node:test";
import { AgentAccounts } from "../src/agent-accounts.mjs";
import { MemoryRecords, RecordCipher } from "../src/database.mjs";
import { codexAccountFixture } from "./fixtures/codex-account.mjs";
import { waitFor } from "./helpers.mjs";

const alice = `user_${"a".repeat(32)}`, bob = `user_${"b".repeat(32)}`;
const input = { provider: "codex", name: "Personal", companies: ["thomfilg"], allowUnassigned: true };
const chat = { agent: "codex", repositories: [{ fullName: "thomfilg/relay" }] };
async function setup(t, options = {}) {
  const records = new MemoryRecords(), fixture = codexAccountFixture();
  const accounts = new AgentAccounts({ records, clientFactory: fixture.factory, ...options });
  await accounts.initialize(); t.after(() => accounts.close());
  return { accounts, records, fixture };
}
async function connect(accounts, fixture, person = alice, data = input) {
  const pending = await accounts.begin(person, data);
  fixture.clients.at(-1).approve();
  await waitFor(() => accounts.hasConnected(person, "codex"));
  return pending.account.id;
}

test("device ceremony stays pending until consent; public records never include credentials", async t => {
  const { accounts, records, fixture } = await setup(t);
  const result = await accounts.begin(alice, input);
  assert.equal(result.account.status, "pending"); assert.equal(accounts.hasConnected(alice, "codex"), false);
  assert.equal(result.login.verificationUrl, "https://auth.openai.com/codex/device"); assert.equal(result.login.userCode, "TEST-1234");
  fixture.clients[0].approve(); await waitFor(() => accounts.hasConnected(alice, "codex"));
  const status = await accounts.status(alice, result.account.id);
  assert.equal(status.login, undefined); assert.equal(status.account.email, "codex@example.test");
  assert.equal(fixture.clients[0].closed, true);
  assert.doesNotMatch(JSON.stringify([status, accounts.list(alice)]), /token|workspace-fixture|auth_mode/);
  const stored = await records.get("agent-account", result.account.id);
  const cipher = new RecordCipher(Buffer.alloc(32, 5)), sealed = cipher.seal("agent-account", stored.id, stored);
  assert.equal(sealed.includes(Buffer.from("fixture-refresh-token")), false);
  assert.deepEqual(cipher.open("agent-account", stored.id, sealed), stored);
});

test("cross-user, cross-company and wrong-provider selection fail without any host fallback", async t => {
  const { accounts, fixture } = await setup(t); const id = await connect(accounts, fixture);
  assert.deepEqual(accounts.list(bob), []);
  for (const action of [() => accounts.status(bob, id), () => accounts.disconnect(bob, id), () => accounts.models(bob, id), () => accounts.credentials(bob, id, chat)]) await assert.rejects(action, { statusCode: 404 });
  await assert.rejects(() => accounts.select(alice, id, { ...chat, repositories: [{ fullName: "g2i/private" }] }), { statusCode: 403 });
  await assert.rejects(() => accounts.select(alice, id, { ...chat, agent: "claude" }), /selected agent/);
  await assert.rejects(() => accounts.credentials(alice, id, chat, { previousAccountId: "another-company" }), { statusCode: 403 });
  await assert.rejects(() => accounts.begin(null, input), { statusCode: 401 });
  await assert.rejects(() => accounts.begin(alice, { ...input, companies: ["*"] }), { statusCode: 400 });
  assert.equal(fixture.clients.length, 1, "denied operations never start a native process");
});

test("multiple named accounts persist independently and refresh only the selected identity", async t => {
  const { accounts, records, fixture } = await setup(t);
  const personal = await connect(accounts, fixture);
  const company = await accounts.begin(alice, { ...input, name: "Company", companies: ["12-apps"], allowUnassigned: false });
  fixture.clients.at(-1).identity = "company-workspace"; fixture.clients.at(-1).approve();
  await waitFor(() => accounts.list(alice).filter(a => a.status === "connected").length === 2);
  const restarted = new AgentAccounts({ records, clientFactory: fixture.factory }); await restarted.initialize(); t.after(() => restarted.close());
  assert.equal(restarted.list(alice).length, 2);
  const credentials = await restarted.credentials(alice, company.account.id, { ...chat, repositories: [{ fullName: "12-apps/app" }] }, { refresh: true, previousAccountId: "company-workspace" });
  assert.deepEqual(Object.keys(credentials).sort(), ["accessToken", "chatgptAccountId", "chatgptPlanType"]);
  assert.equal(credentials.chatgptAccountId, "company-workspace");
  assert.deepEqual(fixture.clients.at(-1).snapshotCalls, [{ refresh: true }]); assert.equal(fixture.clients.at(-1).closed, true);
  assert.equal((await records.get("agent-account", personal)).auth.tokens.account_id, "workspace-fixture");
});

test("cancellation, failure, expiry and server shutdown close the native profile without connecting", async t => {
  let now = 100; const { accounts, fixture } = await setup(t, { now: () => now, loginTimeoutMs: 10000 });
  const first = await accounts.begin(alice, input); await accounts.cancel(alice, first.account.id);
  fixture.clients[0].approve();
  const second = await accounts.begin(alice, input); fixture.clients[1].reject(new Error("native-secret"));
  await waitFor(() => accounts.list(alice)[1].status === "disconnected");
  const third = await accounts.begin(alice, input); now += 11000; fixture.clients[2].approve();
  await waitFor(() => accounts.list(alice)[2].status === "disconnected");
  await accounts.begin(alice, input); await accounts.close();
  assert.equal(accounts.hasConnected(alice, "codex"), false); assert.equal(accounts.flows.size, 0);
  assert.ok(fixture.clients.every(client => client.closed));
  assert.doesNotMatch(JSON.stringify(accounts.list(alice)), /native-secret/);
  assert.equal((await accounts.status(alice, third.account.id)).account.error, "Sign-in expired. Connect again.");
  assert.equal((await accounts.status(alice, second.account.id)).login, undefined);
});

test("disconnect revokes before stopping workers and reconnect cannot change the saved workspace", async t => {
  let accountsRef; const revoked = [];
  const { accounts, fixture } = await setup(t, { onRevoke: async (person, id) => {
    revoked.push(id); await assert.rejects(() => accountsRef.credentials(person, id, chat), { statusCode: 409 });
  } }); accountsRef = accounts;
  const id = await connect(accounts, fixture);
  await assert.rejects(() => accounts.begin(alice, { ...input, id }), { statusCode: 409 });
  await accounts.disconnect(alice, id); assert.deepEqual(revoked, [id]);
  await accounts.begin(alice, { ...input, id }); fixture.clients.at(-1).identity = "wrong-company"; fixture.clients.at(-1).approve();
  await waitFor(() => accounts.list(alice)[0].status === "disconnected");
  assert.match(accounts.list(alice)[0].error, /different Codex workspace/);
});

test("refresh failure is sanitized and failed consent must never mark access verified", async t => {
  const { accounts, fixture } = await setup(t); const id = await connect(accounts, fixture);
  const factory = accounts.clientFactory;
  accounts.clientFactory = () => { const client = factory(); client.snapshotError = true; return client; };
  await assert.rejects(() => accounts.credentials(alice, id, chat, { refresh: true }), /Reconnect/);
  assert.equal(accounts.list(alice)[0].status, "reconnect");
  assert.doesNotMatch(JSON.stringify(accounts.list(alice)), /secret-native-output/);
  assert.equal(fixture.clients.at(-1).closed, true);
});

test("reconnecting as another user in the same workspace is rejected", async t => {
  const { accounts, fixture } = await setup(t), id = await connect(accounts, fixture);
  await accounts.disconnect(alice, id); await accounts.begin(alice, { ...input, id });
  fixture.clients.at(-1).subject = "another-user-in-the-same-company"; fixture.clients.at(-1).approve();
  await waitFor(() => accounts.list(alice)[0].status === "disconnected");
  assert.match(accounts.list(alice)[0].error, /different Codex workspace or user/);
});

test("shutdown drains a login still registering its temporary profile", async t => {
  const { accounts, records, fixture } = await setup(t);
  const original = records.put.bind(records), gate = Promise.withResolvers(), entered = Promise.withResolvers();
  let hold = true;
  records.put = async (...args) => { if (hold) { hold = false; entered.resolve(); await gate.promise; } return original(...args); };
  const login = accounts.begin(alice, input); await entered.promise;
  const closing = accounts.close(); gate.resolve(); await login; await closing;
  assert.equal(accounts.flows.size, 0); assert.ok(fixture.clients.every(client => client.closed));
  assert.equal(accounts.hasConnected(alice, "codex"), false);
});
