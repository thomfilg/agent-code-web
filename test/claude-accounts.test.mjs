import assert from "node:assert/strict";
import test from "node:test";
import { AgentAccounts } from "../src/agent-accounts.mjs";
import { ModelCatalog } from "../src/models.mjs";
import { MemoryRecords, RecordCipher } from "../src/database.mjs";
import { claudeAccountFixture } from "./fixtures/claude-account.mjs";
import { codexAccountFixture } from "./fixtures/codex-account.mjs";
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
  await assert.rejects(() => accounts.select(alice, id, { ...chat, repositories: [{ fullName: "12-apps/private" }] }), { statusCode: 403 });
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
