import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { mkdir, readFile } from "node:fs/promises";
import { ClaudeAdapter } from "../src/adapters/claude.mjs";
import { CodexAdapter } from "../src/adapters/codex.mjs";
import { ClaudeDebugLog } from "../src/claude-debug.mjs";
import { ChatStore } from "../src/store.mjs";
import { CapabilityBroker } from "../src/capabilities.mjs";
import { createAgentWebServer } from "../src/server.mjs";
import { temporaryDirectory, testConfig, waitFor } from "./helpers.mjs";
import { googleOidcFixture, googleTestEnv, cookieClient } from "./fixtures/google-oidc.mjs";
import { claudeAccountFixture } from "./fixtures/claude-account.mjs";

const firstToken = "synthetic-private-account-value", nextToken = "renewed-private-account-value";
async function fixture(t, provider) {
  const root = await temporaryDirectory(t), store = new ChatStore(root); await store.initialize();
  const chat = await store.create({ title: "Safe account stream", agent: provider, agentAccountId: "named-account" });
  await mkdir(chat.workspace, { recursive: true });
  const events = [], requests = [], broker = new CapabilityBroker({ ttlMs: 10000 }); let token = firstToken;
  const config = testConfig(root, { CLAUDE_BIN: path.resolve("test/fixtures/fake-claude-secret.mjs"), CODEX_BIN: path.resolve("test/fixtures/fake-codex.mjs") });
  const hooks = { onEvent: event => events.push(event), onRequest: request => requests.push(request), accountCredentials: async ({ refresh } = {}) => {
    if (refresh) token = nextToken;
    return { accessToken: token, accountId: "person", organizationId: "company", expiresAt: Date.now() + 3600000, chatgptAccountId: "company", chatgptPlanType: "pro" };
  } };
  const adapter = new (provider === "claude" ? ClaudeAdapter : CodexAdapter)({ chat, store, config, broker, hooks });
  t.after(() => adapter.stop()); await adapter.start();
  return { adapter, events, requests, store, chat };
}
const noSecrets = value => assert.doesNotMatch(JSON.stringify(value), /synthetic-private-account-value|renewed-private-account-value|sk-ant-historical-fixture-value/);

test("Claude real subprocess masks every split, complete replay, historical tokens, tools and refreshed credentials", async t => {
  const f = await fixture(t, "claude");
  for (const mode of ["all-splits", "historical", "refresh"]) {
    f.events.length = 0;
    const result = await f.adapter.send(mode, { model: "default" });
    const live = f.events.filter(event => event.type === "assistant_delta").map(event => event.delta).join("");
    assert.match(result.text, /^\[redacted\] /); assert.equal(result.text, live);
    noSecrets([result, f.events, f.requests]);
    assert.equal(f.events.find(event => event.type === "tool" && event.state === "completed").output, "[redacted]");
  }
});

test("Claude failure, interrupt and stop mask pending prefixes and never replay them into the next turn", async t => {
  const f = await fixture(t, "claude");
  await assert.rejects(f.adapter.send("error", { model: "default" }), error => { noSecrets(error.message); return /\[redacted\]/.test(error.message); });
  for (const action of ["interrupt", "stop"]) {
    f.events.length = 0;
    const running = f.adapter.send("partial", { model: "default" }); const rejected = assert.rejects(running, /interrupted|stopped/);
    await waitFor(() => f.events.some(event => event.type === "assistant_delta"));
    assert.equal(f.events.filter(event => event.type === "assistant_delta").map(event => event.delta).join(""), "before ");
    await f.adapter[action](); await rejected;
    assert.equal(f.events.filter(event => event.type === "assistant_delta").map(event => event.delta).join(""), "before [redacted]");
    noSecrets(f.events);
    const next = await f.adapter.send("all-splits", { model: "default" }); assert.equal(next.text.includes("before"), false); noSecrets(next);
  }
});

test("Claude private debug log applies the live credential set before writing disk", async t => {
  const f = await fixture(t, "claude"), runtimeHome = f.store.runtimeHome(f.chat.id), sessionId = "11111111-1111-4111-8111-111111111111";
  await mkdir(runtimeHome, { recursive: true });
  const log = await ClaudeDebugLog.open({ runtimeHome, sessionId, sanitize: value => f.adapter.redactAccount(value) }); t.after(() => log.close());
  log.append(firstToken); await f.adapter.hooks.accountCredentials({ refresh: true }); log.append(nextToken); await log.flush();
  const content = await readFile(`${runtimeHome}/claude/debug/${sessionId}.txt`, "utf8");
  assert.equal(content, "[redacted]\n[redacted]\n");
});

test("Codex real RPC frames redact every split, renewed/old tokens and failed/stopped boundaries", async t => {
  const f = await fixture(t, "codex");
  const start = async () => {
    f.events.length = 0; f.requests.length = 0;
    const running = f.adapter.send("fixture stream", { model: "fixture-gpt", mode: "accept_edits" });
    await waitFor(() => f.requests.length > 0);
    return { running, params: { threadId: f.adapter.threadId, turnId: f.adapter.current.turnId } };
  };
  const emit = (notifications, complete = false) => f.adapter.rpc.request("fixture/notifications", { notifications, complete });
  f.adapter.credentialSecrets.add("private"); f.adapter.credentialSecrets.add("private-long-value");
  for (const token of [firstToken, nextToken, firstToken, "private-long-value"]) {
    if (token === nextToken) await f.adapter.rpc.request("fixture/accountRefresh", { previousAccountId: "company" });
    const { running, params } = await start(), notifications = [];
    for (let split = 1; split < token.length; split++) for (const delta of [token.slice(0, split), token.slice(split) + " "]) notifications.push({ method: "item/agentMessage/delta", params: { ...params, delta } });
    notifications.push({ method: "item/completed", params: { ...params, item: { type: "commandExecution", id: "tool", command: token, aggregatedOutput: token } } });
    notifications.push({ method: "item/completed", params: { ...params, item: { type: "agentMessage", text: token } } });
    notifications.push({ method: "turn/completed", params: { ...params, turn: { id: params.turnId, status: "completed" } } });
    await emit(notifications, true); const result = await running;
    assert.equal(result.text, "[redacted] ".repeat(token.length - 1));
    assert.equal(result.text, f.events.filter(event => event.type === "assistant_delta").map(event => event.delta).join("")); noSecrets([result, f.events]);
  }
  for (const status of ["failed", "stopped"]) {
    const { running, params } = await start(), rejected = assert.rejects(running);
    await emit([{ method: "item/agentMessage/delta", params: { ...params, delta: firstToken.slice(0, 15) } }]);
    assert.equal(f.events.some(event => event.type === "assistant_delta"), false);
    if (status === "stopped") await f.adapter.stop();
    else await emit([{ method: "turn/completed", params: { ...params, turn: { id: params.turnId, status } } }], true);
    await rejected; assert.deepEqual(f.events.filter(event => event.type === "assistant_delta").map(event => event.delta), ["[redacted]"]); noSecrets(f.events);
  }
});

test("Claude stored messages and SSE reconnect history contain only sanitized native output", async t => {
  const root = await temporaryDirectory(t), google = googleOidcFixture(), claude = claudeAccountFixture();
  const app = await createAgentWebServer({ config: testConfig(root, { ...googleTestEnv, CLAUDE_BIN: path.resolve("test/fixtures/fake-claude-secret.mjs"), ANTHROPIC_API_KEY: "", OPENAI_API_KEY: "", AGENT_ENABLE_MOCK: "0", AGENT_IDLE_TIMEOUT_MS: "60000" }), googleAuthOptions: { fetchImpl: google.fetch }, agentAccountsOptions: { clientFactory: claude.factory } });
  t.after(() => app.stop()); const { url } = await app.start(); app.config.google.origin = url; await app.googleAuth.initialize();
  const browser = cookieClient(url), user = await browser.login(google);
  const post = (route, body) => browser.request(route, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const { account } = await (await post("/api/agent-accounts", { provider: "claude", name: "Test stream", companies: [], allowUnassigned: true })).json();
  await post(`/api/agent-accounts/${account.id}/code`, { code: "fixture-code#fixture-state" }); await waitFor(() => app.agentAccounts.hasConnected(user.id, "claude"));
  const { chat } = await (await post("/api/chats", { agent: "claude", agentAccountId: account.id, title: "Stream fixture" })).json();
  const turn = await app.manager.submit(chat.id, "all-splits"); await turn.completion;
  const saved = app.store.get(chat.id), replay = app.manager.eventsSince(chat.id);
  // Commentary may have been persisted before the tool, followed by an empty
  // segmented-turn marker. Check actual visible text, not that final marker.
  const assistantText = saved.messages.filter(message => message.role === "assistant" && message.text).map(message => message.text).join("\n\n");
  assert.match(assistantText, /^\[redacted\] /);
  assert.doesNotMatch(JSON.stringify([saved.messages, saved.pendingRequest, replay]), /fixture-claude-access-value/);
  await app.manager.stop(chat.id, "test"); const resumed = await app.manager.submit(chat.id, "all-splits"); await resumed.completion;
  assert.doesNotMatch(JSON.stringify([app.store.get(chat.id).messages, app.manager.eventsSince(chat.id)]), /fixture-claude-access-value/);
});

test("Codex ephemeral side chat inherits the same named-account stream boundary and rotation set", async t => {
  const f = await fixture(t, "codex"), events = [], requests = [];
  const side = await f.adapter.forkSide({ onEvent: event => events.push(event), onRequest: request => requests.push(request) });
  assert.equal(side.nativeAuthMode, "account"); assert.equal(side.credentialSecrets, f.adapter.credentialSecrets);
  await f.adapter.rpc.request("fixture/accountRefresh", { previousAccountId: "company" });
  const running = side.send("side fixture", { model: "fixture-gpt", mode: "accept_edits" }); await waitFor(() => requests.length);
  const params = { threadId: side.threadId, turnId: side.current.turnId }, notifications = [];
  for (const token of [firstToken, nextToken]) for (const delta of [token.slice(0, 11), token.slice(11) + " "]) notifications.push({ method: "item/agentMessage/delta", params: { ...params, delta } });
  notifications.push({ method: "turn/completed", params: { ...params, turn: { id: params.turnId, status: "completed" } } });
  await f.adapter.rpc.request("fixture/notifications", { notifications, complete: true });
  const result = await running; assert.equal(result.text, "[redacted] [redacted] ");
  assert.equal(events.filter(event => event.type === "assistant_delta").map(event => event.delta).join(""), result.text); noSecrets([events, result]);
  await side.stop(); assert.ok(f.adapter.credentialSecrets.has(firstToken));
});
