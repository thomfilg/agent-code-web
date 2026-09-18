import assert from "node:assert/strict";
import test from "node:test";
import { AgentAccounts } from "../src/agent-accounts.mjs";
import { CodexAccountError } from "../src/codex-account-client.mjs";
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

test("own accounts work in any project; foreign users and wrong providers still fail without host fallback", async t => {
  const { accounts, fixture } = await setup(t); const id = await connect(accounts, fixture);
  assert.deepEqual(accounts.list(bob), []);
  for (const action of [() => accounts.status(bob, id), () => accounts.disconnect(bob, id), () => accounts.models(bob, id), () => accounts.credentials(bob, id, chat)]) await assert.rejects(action, { statusCode: 404 });
  assert.equal((await accounts.select(alice, id, { ...chat, repositories: [{ fullName: "g2i/private" }] })).id, id);
  assert.equal((await accounts.select(alice, id, { agent: "codex", repositories: [] })).id, id);
  await assert.rejects(() => accounts.select(alice, id, { ...chat, agent: "claude" }), /selected agent/);
  await assert.rejects(() => accounts.credentials(alice, id, chat, { previousAccountId: "another-company" }), { statusCode: 403 });
  await assert.rejects(() => accounts.begin(null, input), { statusCode: 401 });
  assert.equal(fixture.clients.length, 1, "denied operations never start a native process");
  assert.equal(accounts.list(alice)[0].companies, undefined);
  assert.equal(accounts.list(alice)[0].allowUnassigned, undefined);
});

test("project choices survive restart, use only the primary repo, and never expose another user's accounts", async t => {
  const { accounts, records, fixture } = await setup(t);
  const personal = await connect(accounts, fixture, alice, { provider: "codex", name: "Personal" });
  const pending = await accounts.begin(alice, { provider: "codex", name: "Work" }); fixture.clients.at(-1).approve();
  await waitFor(() => accounts.list(alice).filter(a => a.status === "connected").length === 2);
  const work = pending.account.id;
  const first = { agent: "codex", agentAccountId: personal, repositories: [{ fullName: "Acme/App", branch: "main" }, { fullName: "Other/Secondary" }] };
  await accounts.rememberProject(alice, first);
  await accounts.rememberProject(alice, { ...first, agentAccountId: work, repositories: [{ fullName: "Other/Project", branch: "dev" }] });
  const restarted = new AgentAccounts({ records, clientFactory: fixture.factory }); await restarted.initialize(); t.after(() => restarted.close());
  assert.deepEqual(await restarted.projectPreferences(alice), { "acme/app": { agent: "codex", agentAccountId: personal }, "other/project": { agent: "codex", agentAccountId: work } });
  assert.deepEqual(await restarted.projectPreferences(bob), {});
  await assert.rejects(() => restarted.rememberProject(bob, first), { statusCode: 404 });
  await assert.rejects(() => restarted.rememberProject(alice, { ...first, agent: "claude" }), /selected agent/);
  await restarted.rememberProject(alice, { ...first, agentAccountId: work, repositories: [{ fullName: "ACME/app", branch: "feature/new" }] });
  assert.equal((await restarted.projectPreferences(alice))["acme/app"].agentAccountId, work);
  await restarted.disconnect(alice, work);
  assert.deepEqual(await restarted.projectPreferences(alice), {});
  await assert.rejects(() => restarted.rememberProject(alice, { ...first, agentAccountId: work }), { statusCode: 409 });
  assert.deepEqual(await restarted.projectPreferences(bob), {});
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

test("login failure preserves only fixed diagnostic messages and remains retryable", async t => {
  for (const safe of [true, false]) {
    const { accounts, fixture } = await setup(t), factory = accounts.clientFactory;
    accounts.clientFactory = () => {
      const client = factory();
      client.start = async () => {
        const error = safe ? new CodexAccountError("startup_timeout") : new Error("private-code-secret https://example.test/token");
        if (safe) error.message += " private-code-secret";
        throw error;
      };
      return client;
    };
    const expected = safe ? new CodexAccountError("startup_timeout").message : "Codex sign-in could not start on the server. Try again.";
    await assert.rejects(() => accounts.begin(alice, input), { message: expected, statusCode: 502 });
    const saved = accounts.list(alice)[0];
    assert.equal(saved.error, expected); assert.equal(saved.status, "disconnected");
    assert.equal(fixture.clients[0].closed, true); assert.equal(accounts.flows.size, 0);
    assert.doesNotMatch(JSON.stringify(saved), /private-code-secret|example\.test/);
    accounts.clientFactory = factory;
    const result = await accounts.begin(alice, { ...input, id: saved.id });
    assert.equal(result.account.id, saved.id); assert.equal(result.account.status, "pending");
    assert.equal(accounts.list(alice).length, 1);
  }
});

test("post-consent verification reports safe diagnostics without persisting unverified credentials", async t => {
  const { accounts, records, fixture } = await setup(t);
  const pending = await accounts.begin(alice, input), client = fixture.clients[0];
  client.snapshot = async () => {
    const error = new CodexAccountError("verification_timeout");
    error.message = "secret-native-output https://example.test/private";
    throw error;
  };
  client.approve();
  await waitFor(() => accounts.list(alice)[0].status === "disconnected");
  await waitFor(() => client.closed);
  const saved = await records.get("agent-account", pending.account.id);
  assert.equal(saved.auth, null);
  assert.equal(saved.error, new CodexAccountError("verification_timeout").message);
  assert.doesNotMatch(JSON.stringify(accounts.list(alice)), /secret-native-output|example\.test/);
  const retried = await accounts.begin(alice, { ...input, id: saved.id });
  fixture.clients.at(-1).approve();
  await waitFor(() => accounts.hasConnected(alice, "codex"));
  assert.equal(retried.account.id, saved.id);
  assert.equal(accounts.list(alice).length, 1);
});
