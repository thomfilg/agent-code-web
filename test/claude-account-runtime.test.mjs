import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { createHash } from "node:crypto";
import { access, mkdir } from "node:fs/promises";
import { ClaudeAdapter } from "../src/adapters/claude.mjs";
import { ChatStore } from "../src/store.mjs";
import { CapabilityBroker } from "../src/capabilities.mjs";
import { createAgentWebServer } from "../src/server.mjs";
import { temporaryDirectory, testConfig, waitFor } from "./helpers.mjs";
import { googleOidcFixture, googleTestEnv, cookieClient } from "./fixtures/google-oidc.mjs";
import { claudeAccountFixture } from "./fixtures/claude-account.mjs";

test("a retained Claude account process resumes only with the exact credential snapshot", async t => {
  const root = await temporaryDirectory(t), store = new ChatStore(root); await store.initialize();
  let chat = await store.create({ agent: "claude", agentAccountId: "named-account", title: "Retained account" });
  await store.update(chat.id, { agentSessionId: "11111111-1111-4111-8111-111111111111", suspension: { nativeRetained: true } }); chat = store.get(chat.id);
  const credentials = { accessToken: "sk-ant-oat01-retained", accountId: "person", organizationId: "company", expiresAt: Date.now() + 3600000 };
  const hash = createHash("sha256").update(JSON.stringify([credentials.accountId, credentials.organizationId, credentials.accessToken])).digest("hex");
  const make = accountCredentialHash => new ClaudeAdapter({ chat, store, config: testConfig(root, { CLAUDE_AUTH_MODE: "host", ANTHROPIC_API_KEY: "" }),
    broker: new CapabilityBroker({ ttlMs: 10000 }), executor: { workspace: chat.workspace, runtimeHome: store.runtimeHome(chat.id), retainedCapabilities: { accountCredentialHash } },
    hooks: { accountCredentials: async () => credentials } });
  const valid = make(hash); t.after(() => valid.stop()); await valid.start();
  const changed = make("0".repeat(64)); t.after(() => changed.stop());
  await assert.rejects(changed.start(), /credential changed/);
});

test("named Claude worker uses only its account, redacts token echoes and retains its session through stop/resume", async t => {
  const root = await temporaryDirectory(t), store = new ChatStore(root); await store.initialize();
  const chat = await store.create({ agent: "claude", agentAccountId: "named-account", title: "Claude account fixture" });
  await mkdir(chat.workspace, { recursive: true }); const events = [], calls = [];
  const broker = new CapabilityBroker({ ttlMs: 10000 });
  const config = testConfig(root, { CLAUDE_BIN: path.resolve("test/fixtures/fake-claude.mjs"), CLAUDE_AUTH_MODE: "host", ANTHROPIC_API_KEY: "" });
  const adapter = new ClaudeAdapter({ chat, store, config, broker, hooks: { onEvent: event => events.push(event), onSessionId: id => store.update(chat.id, { agentSessionId: id }),
    accountCredentials: async options => { calls.push(options); return { accessToken: "sk-ant-oat01-private-fixture-value", accountId: "person", organizationId: "company", expiresAt: Date.now() + 3600000 }; } } });
  t.after(() => adapter.stop()); await adapter.start(); assert.equal(adapter.nativeAuthMode, "account"); assert.equal(broker.size, 0);
  const env = { ANTHROPIC_API_KEY: "bad", ANTHROPIC_BASE_URL: "https://bad.example", CLAUDE_CODE_OAUTH_REFRESH_TOKEN: "bad", CLAUDE_CODE_USE_BEDROCK: "1", CLAUDE_CODE_USER_EMAIL: "other@example.test" };
  adapter.applyAccountEnvironment(env, { accessToken: "sk-ant-oat01-private-fixture-value", accountId: "person", organizationId: "company" });
  assert.equal(env.ANTHROPIC_API_KEY, undefined); assert.equal(env.ANTHROPIC_BASE_URL, undefined); assert.equal(env.CLAUDE_CODE_OAUTH_REFRESH_TOKEN, undefined); assert.equal(env.CLAUDE_CODE_USE_BEDROCK, undefined);
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, "sk-ant-oat01-private-fixture-value"); assert.equal(env.CLAUDE_CODE_SDK_HAS_OAUTH_REFRESH, "1");
  assert.equal(env.CLAUDE_CODE_USER_EMAIL, undefined);
  const result = await adapter.send("sk-ant-oat01-private-fixture-value", { model: "default", resetEffort: true });
  assert.match(result.text, /\[redacted\]/); assert.doesNotMatch(JSON.stringify([result, events]), /sk-ant-oat01-private-fixture-value/);
  await assert.rejects(access(path.join(store.runtimeHome(chat.id), "claude", ".credentials.json")), { code: "ENOENT" });
  assert.ok(store.get(chat.id).agentSessionId); const sessionId = store.get(chat.id).agentSessionId;
  await adapter.stop(); await adapter.start(); const resumed = await adapter.send("resume fixture", { model: "default" });
  assert.match(resumed.text, /resume fixture/); assert.equal(store.get(chat.id).agentSessionId, sessionId); assert.ok(calls.length >= 4);
});

for (const action of ["disconnect", "delete"]) test(`Claude API onboarding, company/account admission, turn, resume and ${action} use the Google owner's account`, async t => {
  const root = await temporaryDirectory(t), google = googleOidcFixture(), claude = claudeAccountFixture();
  const app = await createAgentWebServer({ config: testConfig(root, { ...googleTestEnv, CLAUDE_BIN: path.resolve("test/fixtures/fake-claude.mjs"), ANTHROPIC_API_KEY: "", OPENAI_API_KEY: "", AGENT_ENABLE_MOCK: "0", AGENT_IDLE_TIMEOUT_MS: "60000" }),
    googleAuthOptions: { fetchImpl: google.fetch }, agentAccountsOptions: { clientFactory: claude.factory } });
  t.after(() => app.stop()); const { url } = await app.start(); app.config.google.origin = url; await app.googleAuth.initialize();
  const browser = cookieClient(url), user = await browser.login(google);
  const post = (route, body = {}) => browser.request(route, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const created = await post("/api/agent-accounts", { provider: "claude", name: "Claude Personal", companies: [], allowUnassigned: true }); assert.equal(created.status, 201);
  const { account } = await created.json();
  assert.equal((await post(`/api/agent-accounts/${account.id}/code`, { code: "fixture-code#fixture-state" })).status, 200);
  await waitFor(() => app.agentAccounts.hasConnected(user.id, "claude"));
  assert.equal((await (await browser.request("/api/config")).json()).agents.find(agent => agent.id === "claude").enabled, true);
  assert.equal((await browser.request("/api/models?agent=claude")).status, 409);
  assert.equal((await browser.request(`/api/models?agent=claude&account=${account.id}`)).status, 200);
  assert.notEqual((await post("/api/chats", { agent: "claude", title: "missing account" })).status, 201);
  const response = await post("/api/chats", { agent: "claude", agentAccountId: account.id, title: "Claude fixture turn" }); assert.equal(response.status, 201);
  const { chat } = await response.json(); assert.equal(chat.agentAccountId, account.id); assert.equal(chat.ownerId, user.id);
  const first = await app.manager.submit(chat.id, "first fixture turn"); await first.completion;
  assert.match(app.store.get(chat.id).messages.at(-1).text, /first fixture turn/);
  const session = app.store.get(chat.id).agentSessionId; await app.manager.stop(chat.id, "test-resume");
  const second = await app.manager.submit(chat.id, "second fixture turn"); await second.completion;
  assert.equal(app.store.get(chat.id).agentSessionId, session); assert.equal(app.broker.size, 0);
  const messages = structuredClone(app.store.get(chat.id).messages);
  const removal = action === "delete" ? await browser.request(`/api/agent-accounts/${account.id}`, { method: "DELETE" }) : await post(`/api/agent-accounts/${account.id}/disconnect`);
  assert.equal(removal.status, 200);
  assert.deepEqual(app.store.get(chat.id).messages, messages); assert.equal(app.store.get(chat.id).agentAccountId, account.id);
  await app.manager.send(chat.id, "must not execute"); assert.match(app.store.get(chat.id).queueError, action === "delete" ? /account not found/ : /Reconnect/);
  assert.equal(app.store.get(chat.id).status, "stopped"); assert.ok(app.store.get(chat.id).messages.length >= 4);
});
