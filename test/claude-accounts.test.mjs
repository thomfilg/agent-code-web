import assert from "node:assert/strict";
import test from "node:test";
import { AgentAccounts } from "../src/agent-accounts.mjs";
import { ModelCatalog } from "../src/models.mjs";
import { MemoryRecords, RecordCipher } from "../src/database.mjs";
import { claudeAccountFixture } from "./fixtures/claude-account.mjs";
import { codexAccountFixture } from "./fixtures/codex-account.mjs";
import { ClaudeAccountClient } from "../src/claude-account-client.mjs";
import { waitFor } from "./helpers.mjs";
const alice = `user_${"a".repeat(32)}`, bob = `user_${"b".repeat(32)}`;
const input = { provider: "claude", name: "Claude Personal", companies: ["thomfilg"], allowUnassigned: false };
const chat = { agent: "claude", repositories: [{ fullName: "thomfilg/relay" }] };
async function setup(t) {
  const records = new MemoryRecords(), claude = claudeAccountFixture(), codex = codexAccountFixture();
  const factory = provider => provider === "claude" ? claude.factory() : codex.factory();
  const accounts = new AgentAccounts({ records, clientFactory: factory }); await accounts.initialize(); t.after(() => accounts.close());
  return { accounts, records, claude, codex, factory };
}
async function connect(ctx, data = input) {
  const pending = await ctx.accounts.begin(alice, data);
  await ctx.accounts.submitCode(alice, pending.account.id, { code: "fixture-code#fixture-state" });
  await waitFor(() => ctx.accounts.list(alice).find(item => item.id === pending.account.id)?.status === "connected");
  return pending.account.id;
}
test("Claude consent, user/company boundaries, encrypted persistence and access-only credentials are separate from Codex", async t => {
  const ctx = await setup(t), { accounts, records, claude, codex } = ctx;
  const pending = await accounts.begin(alice, input), id = pending.account.id;
  assert.equal(pending.login.inputRequired, true); assert.equal(pending.login.userCode, undefined); assert.equal(accounts.hasConnected(alice, "claude"), false);
  await assert.rejects(() => accounts.submitCode(bob, id, { code: "fixture-code#fixture-state" }), { statusCode: 404 });
  await assert.rejects(() => accounts.submitCode(alice, id, { code: "wrong" }), /could not be verified/);
  await accounts.submitCode(alice, id, { code: "fixture-code#fixture-state" }); await waitFor(() => accounts.hasConnected(alice, "claude"));
  assert.equal((await accounts.status(alice, id)).login, undefined); assert.equal(codex.clients.length, 0);
  for (const action of [() => accounts.credentials(bob, id, chat), () => accounts.models(bob, id), () => accounts.disconnect(bob, id)]) await assert.rejects(action, { statusCode: 404 });
  await assert.rejects(() => accounts.select(alice, id, { ...chat, agent: "codex" }), /selected agent/);
  assert.equal((await accounts.select(alice, id, { ...chat, repositories: [{ fullName: "12-apps/private" }] })).id, id);
  assert.equal((await accounts.select(alice, id, { ...chat, repositories: [] })).id, id);
  await assert.rejects(() => accounts.models(alice, id, "codex"), /selected agent/);
  const credentials = await accounts.credentials(alice, id, chat, { refresh: true });
  assert.deepEqual(Object.keys(credentials).sort(), ["accessToken", "accountId", "email", "expiresAt", "organizationId"]);
  assert.equal(claude.clients.at(-1).closed, true); assert.doesNotMatch(JSON.stringify(accounts.list(alice)), /fixture-claude-(?:access|refresh)-value/);
  const record = await records.get("agent-account", id), cipher = new RecordCipher(Buffer.alloc(32, 6));
  const sealed = cipher.seal("agent-account", id, record); assert.equal(sealed.includes(Buffer.from("fixture-claude-refresh-value")), false);
  const restarted = new AgentAccounts({ records, clientFactory: ctx.factory }); await restarted.initialize(); t.after(() => restarted.close());
  assert.equal(restarted.hasConnected(alice, "claude"), true); assert.equal(restarted.list(bob).length, 0);
});
test("Claude models use the selected native account, not shared host aliases", async t => {
  const ctx = await setup(t), id = await connect(ctx);
  const catalog = new ModelCatalog({ google: { enabled: true }, claude: { model: "opus", effort: "max" } }, ctx.accounts);
  const models = await catalog.list("claude", { ownerId: alice, agentAccountId: id });
  assert.equal(models.source, "claude-account"); assert.deepEqual(models.models.map(model => model.id), ["default", "sonnet"]);
  assert.equal(models.defaults.model, "default"); assert.equal(models.defaults.effort, "max");
  await assert.rejects(() => catalog.list("claude", { ownerId: bob, agentAccountId: id }), { statusCode: 404 });
  await assert.rejects(() => catalog.list("claude", { ownerId: alice }), /Connect and select/);
});
test("Claude reconnect cannot replace organization or user, cancel erases pending code, disconnect fails closed", async t => {
  const ctx = await setup(t), id = await connect(ctx), { accounts, claude } = ctx;
  await accounts.disconnect(alice, id);
  await assert.rejects(() => accounts.begin(alice, { ...input, id, provider: "codex" }), /cannot change providers/);
  await assert.rejects(() => accounts.credentials(alice, id, chat), /Reconnect/);
  await accounts.begin(alice, { ...input, id }); claude.clients.at(-1).organization = "wrong-company";
  await accounts.submitCode(alice, id, { code: "fixture-code#fixture-state" }); await waitFor(() => accounts.list(alice)[0].status === "disconnected");
  assert.match(accounts.list(alice)[0].error, /different Claude workspace or user/);
  await accounts.begin(alice, { ...input, id }); await accounts.cancel(alice, id);
  await assert.rejects(() => accounts.submitCode(alice, id, { code: "fixture-code#fixture-state" }), { statusCode: 409 });
  assert.equal((await accounts.status(alice, id)).login, undefined); assert.equal(accounts.list(alice).length, 1);
});

for (const provider of ["claude", "codex"]) for (const phase of ["snapshot", "persistence"]) test(`${provider} cancellation wins during gated ${phase} without publishing or admitting credentials`, async t => {
  const ctx = await setup(t), { accounts, records } = ctx, fixture = provider === "claude" ? ctx.claude : ctx.codex;
  const pending = await accounts.begin(alice, { ...input, provider }), id = pending.account.id;
  const gate = Promise.withResolvers(), entered = Promise.withResolvers(), client = fixture.clients.at(-1), published = [];
  accounts.onChange = () => published.push(accounts.list(alice)[0]?.status);
  if (phase === "snapshot") { const snapshot = client.snapshot.bind(client); client.snapshot = async (...args) => { entered.resolve(); await gate.promise; return snapshot(...args); }; }
  else { const put = records.put.bind(records); records.put = async (...args) => { const result = await put(...args); if (args[2].status === "connected") { entered.resolve(); await gate.promise; } return result; }; }
  client.approve(); await entered.promise;
  const cancelled = accounts.cancel(alice, id);
  try {
    await new Promise(resolve => setImmediate(resolve));
    await assert.rejects(() => accounts.select(alice, id, { ...chat, agent: provider }), { statusCode: 409 });
    assert.notEqual((await accounts.status(alice, id)).account.status, "connected");
  } finally { gate.resolve(); await cancelled; }
  assert.equal(accounts.list(alice)[0].status, "disconnected");
  assert.equal((await records.get("agent-account", id)).auth, null);
  assert.equal(published.includes("connected"), false);
});

test("Claude rotation survives temporary profile outage and restart without giving out unverified credentials", async t => {
  const ctx = await setup(t), id = await connect(ctx), { accounts, records } = ctx;
  let unavailable = true, refreshes = 0;
  const factory = () => new ClaudeAccountClient({ claude: { bin: "unused" } }, { fetchImpl: async (url, options) => {
    if (url.endsWith("/oauth/token")) {
      refreshes++; assert.equal(JSON.parse(options.body).refresh_token, "fixture-claude-refresh-value");
      return new Response(JSON.stringify({ access_token: "rotated-access", refresh_token: "rotated-refresh", expires_in: 3600, scope: "user:profile user:inference" }));
    }
    assert.equal(options.headers.Authorization, "Bearer rotated-access");
    return unavailable ? new Response("Temporary provider error with private diagnostic", { status: 500 }) : new Response(JSON.stringify({ account: { uuid: "fixture-claude-user" }, organization: { uuid: "fixture-claude-company" } }));
  } });
  accounts.clientFactory = factory;
  await assert.rejects(() => accounts.credentials(alice, id, chat, { refresh: true }), { statusCode: 503 });
  const saved = await records.get("agent-account", id);
  assert.equal(saved.auth.claudeAiOauth.refreshToken, "rotated-refresh");
  assert.equal(saved.status, "connected"); assert.equal(saved.accountIdentity, "fixture-claude-company");
  assert.doesNotMatch(JSON.stringify(accounts.list(alice)), /rotated-access|rotated-refresh|private diagnostic/);
  const restarted = new AgentAccounts({ records, clientFactory: factory }); await restarted.initialize(); t.after(() => restarted.close());
  unavailable = false;
  assert.equal((await restarted.credentials(alice, id, chat)).accessToken, "rotated-access");
  assert.equal(refreshes, 1);
});

test("another owner cannot cancel an account being verified", async t => {
  const { accounts, claude } = await setup(t), pending = await accounts.begin(alice, input), id = pending.account.id;
  const client = claude.clients.at(-1), snapshot = client.snapshot.bind(client), gate = Promise.withResolvers(), entered = Promise.withResolvers();
  client.snapshot = async () => { entered.resolve(); await gate.promise; return snapshot(); };
  client.approve(); await entered.promise;
  const denied = assert.rejects(() => accounts.cancel(bob, id), { statusCode: 404 });
  assert.notEqual(accounts.flows.get(id).cancelled, true); gate.resolve(); await denied;
  assert.equal(accounts.hasConnected(alice, "claude"), true);
});

test("a late failure from a cancelled Claude ceremony cannot cancel its replacement", async t => {
  const { accounts, claude } = await setup(t), first = await accounts.begin(alice, input), id = first.account.id;
  const old = claude.clients.at(-1); old.cancel = async () => {};
  await accounts.cancel(alice, id); await accounts.begin(alice, { ...input, id });
  old.reject(Error("late private native failure")); await new Promise(resolve => setImmediate(resolve));
  assert.equal(accounts.list(alice)[0].status, "pending"); assert.equal(accounts.flows.get(id).client, claude.clients.at(-1));
  await accounts.submitCode(alice, id, { code: "fixture-code#fixture-state" }); await waitFor(() => accounts.hasConnected(alice, "claude"));
});

test("cancelling a verifying Claude flow cannot erase an already queued replacement", async t => {
  const { accounts, claude } = await setup(t), first = await accounts.begin(alice, input), id = first.account.id;
  const client = claude.clients.at(-1), snapshot = client.snapshot.bind(client), entered = Promise.withResolvers(), gate = Promise.withResolvers();
  client.snapshot = async () => { entered.resolve(); await gate.promise; return snapshot(); };
  client.approve(); await entered.promise;
  const replacing = accounts.begin(alice, { ...input, id }); await new Promise(resolve => setImmediate(resolve));
  const cancelling = accounts.cancel(alice, id); gate.resolve(); await Promise.all([replacing, cancelling]);
  assert.equal(accounts.list(alice)[0].status, "pending");
  assert.equal(accounts.flows.get(id).client, claude.clients.at(-1));
  await accounts.submitCode(alice, id, { code: "fixture-code#fixture-state" }); await waitFor(() => accounts.hasConnected(alice, "claude"));
});

test("account disconnection still invalidates a replacement queued during cancelled verification", async t => {
  const { accounts, claude, records } = await setup(t), first = await accounts.begin(alice, input), id = first.account.id;
  const client = claude.clients.at(-1), snapshot = client.snapshot.bind(client), entered = Promise.withResolvers(), gate = Promise.withResolvers();
  client.snapshot = async () => { entered.resolve(); await gate.promise; return snapshot(); };
  client.approve(); await entered.promise;
  const replacing = accounts.begin(alice, { ...input, id }); await new Promise(resolve => setImmediate(resolve));
  const rejectedReplacement = assert.rejects(replacing, { statusCode: 409 });
  const disconnecting = accounts.disconnect(alice, id); gate.resolve(); await Promise.all([rejectedReplacement, disconnecting]);
  claude.clients.at(-1).approve(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(accounts.list(alice)[0].status, "disconnected"); assert.equal(accounts.flows.has(id), false);
  assert.equal((await records.get("agent-account", id)).auth, null);
});

for (const failure of ["revoked", "identity"]) test(`Claude rotated ${failure} access stays unavailable without losing the saved rotation`, async t => {
  const { accounts, records } = await setup(t);
  // Finish the native ceremony using the fixture before replacing network I/O.
  const pending = await accounts.begin(alice, input), id = pending.account.id;
  await accounts.submitCode(alice, id, { code: "fixture-code#fixture-state" }); await waitFor(() => accounts.hasConnected(alice, "claude"));
  accounts.clientFactory = () => new ClaudeAccountClient({ claude: { bin: "unused" } }, { fetchImpl: async url => url.endsWith("/oauth/token")
    ? new Response(JSON.stringify({ access_token: "rotated-access", refresh_token: "rotated-refresh", expires_in: 3600, scope: "user:inference" }))
    : failure === "revoked" ? new Response("private auth diagnostic", { status: 401 }) : new Response(JSON.stringify({ account: { uuid: "wrong-user" }, organization: { uuid: "fixture-claude-company" } })) });
  await assert.rejects(() => accounts.credentials(alice, id, chat, { refresh: true }), { statusCode: 409 });
  const saved = await records.get("agent-account", id);
  assert.equal(saved.status, "reconnect"); assert.equal(saved.subject, "fixture-claude-user"); assert.equal(saved.accountIdentity, "fixture-claude-company");
  assert.equal(saved.auth.claudeAiOauth.refreshToken, "rotated-refresh");
  await assert.rejects(() => accounts.credentials(alice, id, chat), { statusCode: 409 });
  assert.doesNotMatch(JSON.stringify(accounts.list(alice)), /rotated-access|rotated-refresh|private auth diagnostic/);
});
