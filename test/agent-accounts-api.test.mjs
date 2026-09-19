import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { createAgentWebServer } from "../src/server.mjs";
import { MemoryRecords } from "../src/database.mjs";
import { temporaryDirectory, testConfig, waitFor } from "./helpers.mjs";
import { googleOidcFixture, googleTestEnv, cookieClient } from "./fixtures/google-oidc.mjs";
import { codexAccountFixture } from "./fixtures/codex-account.mjs";

async function setup(t, records = new MemoryRecords()) {
  const root = await temporaryDirectory(t), google = googleOidcFixture(), codex = codexAccountFixture();
  const config = testConfig(root, { ...googleTestEnv, CODEX_BIN: path.resolve("test/fixtures/fake-codex.mjs"), CODEX_MODEL: "fixture-gpt", OPENAI_API_KEY: "", ANTHROPIC_API_KEY: "", AGENT_ENABLE_MOCK: "0", AGENT_IDLE_TIMEOUT_MS: "60000" });
  const app = await createAgentWebServer({ config, records, googleAuthOptions: { fetchImpl: google.fetch }, agentAccountsOptions: { clientFactory: codex.factory } });
  const { url } = await app.start(); config.google.origin = url; await app.googleAuth.initialize();
  t.after(() => app.stop());
  const browser = cookieClient(url), user = await browser.login(google);
  return { app, browser, user, url, google, codex };
}
const post = (browser, route, body = {}) => browser.request(route, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
async function connect(ctx) {
  const response = await post(ctx.browser, "/api/agent-accounts", { provider: "codex", name: "Personal", companies: [], allowUnassigned: true });
  assert.equal(response.status, 201); const { account } = await response.json();
  ctx.codex.clients.at(-1).approve(); await waitFor(() => ctx.app.agentAccounts.list(ctx.user.id).find(item => item.id === account.id)?.status === "connected");
  return account.id;
}

test("Google identity owns login URLs, account/model routes and explicit chat admission", async t => {
  const ctx = await setup(t), { app, browser, url } = ctx;
  assert.equal((await fetch(`${url}/api/agent-accounts`)).status, 401);
  assert.equal((await post(browser, "/api/agent-accounts", { provider: "claude" })).status, 400);
  assert.equal((await browser.request("/api/agent-accounts", { method: "POST", headers: { origin: "https://evil.example" }, body: "{}" })).status, 403);
  assert.equal((await browser.request("/api/models?agent=codex")).status, 409);
  let config = await (await browser.request("/api/config")).json(); assert.equal(config.agents.some(agent => agent.enabled), false);
  const id = await connect(ctx);
  config = await (await browser.request("/api/config")).json(); assert.equal(config.agents.find(agent => agent.id === "codex").enabled, true);
  assert.equal(config.agents.find(agent => agent.id === "codex").authMode, "account");
  assert.equal((await browser.request(`/api/models?agent=codex&account=${id}`)).status, 200);
  const member = cookieClient(url); await member.login(ctx.google, { sub: "member", email: "member@example.com", email_verified: true });
  for (const route of [`/api/agent-accounts/${id}`, `/api/models?agent=codex&account=${id}`]) assert.equal((await member.request(route)).status, 404);
  assert.deepEqual((await (await member.request("/api/agent-accounts")).json()).accounts, []);
  assert.equal((await post(member, `/api/agent-accounts/${id}/disconnect`)).status, 404);
  assert.notEqual((await post(browser, "/api/chats", { agent: "codex" })).status, 201);
  const created = await post(browser, "/api/chats", { agent: "codex", agentAccountId: id }); assert.equal(created.status, 201);
  const chat = (await created.json()).chat; assert.equal(chat.ownerId, ctx.user.id); assert.equal(chat.agentAccountId, id);
  assert.equal(app.broker.size, 0);
  assert.doesNotMatch(JSON.stringify(await (await browser.request("/api/agent-accounts")).json()), /fixture-(access|refresh)-token/);
});

test("real worker transport logs in to the chosen account, runs a fixture turn, resumes, and stops on disconnect", { timeout: 20000 }, async t => {
  const ctx = await setup(t), { app, browser, user } = ctx; const id = await connect(ctx);
  const response = await post(browser, "/api/chats", { agent: "codex", agentAccountId: id, title: "Account runtime test" });
  const chat = (await response.json()).chat; await app.manager.setMode(chat.id, "auto");
  const first = await app.manager.submit(chat.id, "fixture turn");
  first.completion.catch(() => {});
  const request = await waitFor(() => app.store.get(chat.id).pendingRequest);
  await app.manager.respond(chat.id, request.requestId, { decision: "accept" }); await first.completion;
  assert.equal(app.store.get(chat.id).messages.some(message => message.text.includes("hello world")), true);
  assert.equal(app.broker.size, 0, "native account never creates a gateway capability");
  await app.manager.stop(chat.id, "test-resume");
  const second = await app.manager.submit(chat.id, "fixture resume");
  second.completion.catch(() => {});
  const resumed = await waitFor(() => app.store.get(chat.id).pendingRequest);
  await app.manager.respond(chat.id, resumed.requestId, { decision: "accept" }); await second.completion;
  assert.equal(app.store.get(chat.id).agentAccountId, id); assert.equal(app.store.get(chat.id).ownerId, user.id);
  assert.equal((await post(browser, `/api/agent-accounts/${id}/disconnect`)).status, 200);
  assert.equal(app.store.get(chat.id).status, "stopped");
  const nativeClients = ctx.codex.clients.length;
  await app.manager.send(chat.id, "must not run");
  assert.match(app.store.get(chat.id).queueError, /Reconnect/);
  assert.equal(app.store.get(chat.id).status, "stopped");
  assert.equal(ctx.codex.clients.length, nativeClients, "disconnected account cannot start an auth client or worker");
  assert.ok(app.store.get(chat.id).messages.length >= 4, "disconnect does not delete messages");
  assert.doesNotMatch(JSON.stringify(app.store.get(chat.id)), /fixture-(access|refresh)-token/);
});

test("account selection is explicit for old chats, remains user-owned after controller restart, and does not switch on reconnect", async t => {
  const records = new MemoryRecords(), ctx = await setup(t, records), { app, browser, user } = ctx;
  const personal = await connect(ctx);
  const legacy = await app.store.create({ agent: "codex", ownerId: user.id, title: "Old chat" });
  await assert.rejects(() => app.manager.switchAgent(legacy.id, "codex"), /Choose a Codex account/);
  const update = (client, id, body) => client.request(`/api/chats/${id}/agent`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  assert.equal((await update(browser, legacy.id, { agent: "codex", agentAccountId: personal })).status, 200);
  const member = cookieClient(ctx.url); await member.login(ctx.google, { sub: "member", email: "member@example.com", email_verified: true });
  assert.equal((await update(member, legacy.id, { agent: "codex", agentAccountId: personal })).status, 404);
  await app.stop();
  const restarted = await setup(t, records);
  const account = (await (await restarted.browser.request("/api/agent-accounts")).json()).accounts[0];
  assert.equal(account.id, personal); assert.equal(account.status, "connected");
  const restored = (await (await restarted.browser.request(`/api/chats/${legacy.id}`)).json()).chat;
  assert.equal(restored.agentAccountId, personal); assert.equal(restored.ownerId, user.id);
  assert.equal((await restarted.browser.request(`/api/models?agent=codex&account=${personal}`)).status, 200);
  assert.equal(restarted.codex.clients.some(client => client.approve), false, "restart does not open a new consent ceremony");
});

test("disconnect stops an active selected-account turn before gated refresh finishes and reconnect resumes its saved session", { timeout: 20000 }, async t => {
  const ctx = await setup(t), { app, browser, user } = ctx, id = await connect(ctx);
  const { chat } = await (await post(browser, "/api/chats", { agent: "codex", agentAccountId: id, title: "Active revocation" })).json();
  await app.manager.setMode(chat.id, "auto");
  const turn = await app.manager.submit(chat.id, "fixture turn awaiting approval"); turn.completion.catch(() => {});
  await waitFor(() => app.store.get(chat.id).pendingRequest);
  const session = app.store.get(chat.id).agentSessionId;
  const factory = app.agentAccounts.clientFactory, entered = Promise.withResolvers(), gate = Promise.withResolvers();
  app.agentAccounts.clientFactory = () => {
    const client = factory(), start = client.start.bind(client);
    client.start = async (...args) => { entered.resolve(); await gate.promise; return start(...args); }; return client;
  };
  const refresh = app.agentAccounts.credentials(user.id, id, chat, { refresh: true }); refresh.catch(() => {}); await entered.promise;
  const disconnecting = post(browser, `/api/agent-accounts/${id}/disconnect`);
  try {
    await waitFor(() => app.store.get(chat.id).status === "stopped");
    assert.equal(app.store.get(chat.id).pendingRequest, null);
    assert.equal(app.store.get(chat.id).agentSessionId, session);
    assert.equal(app.agentAccounts.hasConnected(user.id, "codex"), false);
  } finally { gate.resolve(); }
  assert.equal((await disconnecting).status, 200); await assert.rejects(refresh, { statusCode: 409 });
  app.agentAccounts.clientFactory = factory;
  const reconnected = await post(browser, "/api/agent-accounts", { id, provider: "codex", name: "Personal" }); assert.equal(reconnected.status, 201);
  ctx.codex.clients.at(-1).approve(); await waitFor(() => app.agentAccounts.hasConnected(user.id, "codex"));
  const resumed = await app.manager.submit(chat.id, "fixture resumed after account reconnect"); resumed.completion.catch(() => {});
  const request = await waitFor(() => app.store.get(chat.id).pendingRequest);
  await app.manager.respond(chat.id, request.requestId, { decision: "accept" }); await resumed.completion;
  assert.equal(app.store.get(chat.id).agentSessionId, session); assert.equal(app.store.get(chat.id).agentAccountId, id);
  assert.ok(app.store.get(chat.id).messages.some(message => message.text === "fixture turn awaiting approval"));
});

test("account deletion enforces owner and Origin, stops its worker, keeps messages/binding and never falls back to another account", { timeout: 20000 }, async t => {
  const ctx = await setup(t), { app, browser, user } = ctx, id = await connect(ctx);
  const created = await post(browser, "/api/chats", { agent: "codex", agentAccountId: id, title: "Keep my conversation" });
  const { chat } = await created.json(); await app.manager.setMode(chat.id, "auto");
  const turn = await app.manager.submit(chat.id, "fixture deletion turn"); turn.completion.catch(() => {});
  const approval = await waitFor(() => app.store.get(chat.id).pendingRequest);
  await app.manager.respond(chat.id, approval.requestId, { decision: "accept" }); await turn.completion;
  const messages = structuredClone(app.store.get(chat.id).messages);
  const replacement = await connect(ctx);
  const member = cookieClient(ctx.url); await member.login(ctx.google, { sub: "member", email: "member@example.com", email_verified: true });
  const route = `/api/agent-accounts/${id}`;
  assert.equal((await member.request(route, { method: "DELETE" })).status, 404);
  assert.equal((await browser.request(route, { method: "DELETE", headers: { origin: "https://evil.example" } })).status, 403);
  assert.equal((await fetch(`${ctx.url}${route}`, { method: "DELETE", headers: { origin: ctx.url } })).status, 401);
  assert.equal(app.agentAccounts.hasConnected(user.id, "codex"), true);
  const deleted = await browser.request(route, { method: "DELETE" });
  assert.equal(deleted.status, 200); assert.deepEqual(await deleted.json(), { deleted: true, id });
  assert.equal(app.store.get(chat.id).status, "stopped"); assert.equal(app.store.get(chat.id).agentAccountId, id);
  assert.deepEqual(app.store.get(chat.id).messages, messages);
  assert.equal((await browser.request(route)).status, 404);
  assert.equal((await browser.request(`/api/models?agent=codex&account=${id}`)).status, 404);
  assert.deepEqual(app.agentAccounts.list(user.id).map(account => account.id), [replacement]);
  const nativeClients = ctx.codex.clients.length;
  await app.manager.send(chat.id, "must not use replacement automatically");
  assert.match(app.store.get(chat.id).queueError, /account not found/);
  assert.equal(app.store.get(chat.id).agentAccountId, id); assert.equal(ctx.codex.clients.length, nativeClients);
  assert.equal(app.agentAccounts.hasConnected(user.id, "codex"), true);
});
