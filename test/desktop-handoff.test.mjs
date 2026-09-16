import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { desktopBinding, desktopInfo, inspectDesktopSession } from "../src/desktop-handoff.mjs";
import { CodexAdapter } from "../src/adapters/codex.mjs";
import { createAgentWebServer } from "../src/server.mjs";
import { MemoryRecords } from "../src/database.mjs";
import { RuntimeManager } from "../src/runtime-manager.mjs";
import { CapabilityBroker } from "../src/capabilities.mjs";
import { messageCommand } from "../src/message-command.mjs";
import { webCommands } from "../public/web-commands.js";
import { temporaryDirectory, testConfig, waitFor } from "./helpers.mjs";

const threadId = "01950000-0000-7000-8000-000000000001";
const snapshot = { threadId, workspace: "/fixture/workspace", profile: "/fixture/codex", backend: "local", authMode: "host", checkedAt: "2026-09-16T10:00:00.000Z" };

test("/app is a Codex-only web action; only verified local host profiles get the canonical same-session URL", () => {
  assert(webCommands("codex").some(command => command.name === "app")); assert(!webCommands("claude").some(command => command.name === "app"));
  for (const text of ["/app", "/app new", "/app\nanything"]) assert.throws(() => messageCommand("codex", text), /web composer/);
  assert.equal(messageCommand("claude", "/app"), null); assert.equal(messageCommand("codex", "/apple"), null);
  const chat = { agentSessionId: threadId };
  const local = desktopInfo(chat, snapshot, { awake: true, busy: true });
  assert.equal(local.url, `codex://threads/${threadId}`); assert.equal(local.source, "connected"); assert.equal(local.busy, true);
  assert.equal(desktopInfo(chat, snapshot).source, "saved");
  assert.match(desktopInfo(chat, { ...snapshot, authMode: "gateway" }).reason, /private Relay worker profile/);
  assert.equal(desktopInfo(chat, { ...snapshot, authMode: "gateway" }).url, null);
  assert.match(desktopInfo(chat, { ...snapshot, backend: "ec2" }).reason, /remote worker/);
  assert.equal(desktopInfo(chat, { ...snapshot, backend: "ec2" }).url, null);
  assert.equal(desktopInfo(chat, null).source, "unknown"); assert.equal(desktopInfo({}, snapshot).threadId, null);
  for (const change of [{ threadId: randomUUID() }, { profile: "relative" }, { workspace: "/fixture/../secret" }, { checkedAt: "unknown" }, { backend: "invented" }, { authMode: "invented" }]) assert.equal(desktopInfo(chat, { ...snapshot, ...change }).url, null);
  assert.equal(desktopInfo({ agentSessionId: "../../new?prompt=send" }, snapshot).url, null);
});

function adapterFixture() {
  const calls = [], thread = { id: threadId, cwd: snapshot.workspace, path: `${snapshot.profile}/sessions/fixture.jsonl`, ephemeral: false };
  const adapter = Object.assign(Object.create(CodexAdapter.prototype), { threadId, workspace: snapshot.workspace, nativeHome: snapshot.profile, nativeAuthMode: "host", config: { codex: { authMode: "host" } },
    rpc: { request: async (method, params) => { calls.push({ method, params }); return { thread }; } } });
  return { adapter, calls, thread };
}
test("the production adapter reads only its saved thread locator, not turns, accounts, configuration or history bytes", async () => {
  const f = adapterFixture(), info = await f.adapter.desktopSession();
  assert.deepEqual(f.calls, [{ method: "thread/read", params: { threadId, includeTurns: false } }]);
  assert.equal(info.profile, snapshot.profile); assert.equal(info.workspace, snapshot.workspace); assert.equal(info.threadId, threadId);
  assert.equal(info.path, undefined); assert.equal(info.backend, "local");
  f.adapter.executor = { metadata: { backend: "ec2", host: "secret-host" } }; assert.equal((await inspectDesktopSession(f.adapter)).backend, "ec2");
  assert(!JSON.stringify(await inspectDesktopSession(f.adapter)).includes("secret-host"));
  f.thread.path = `${snapshot.profile}/archived_sessions/fixture.jsonl`; assert.equal((await f.adapter.desktopSession()).threadId, threadId);
});

test("native identity, path, missing rollout, revocation and late-worker changes fail closed without secret errors", async () => {
  for (const patch of [{ id: randomUUID() }, { cwd: "/other" }, { path: null }, { ephemeral: true }, { path: "/other/sessions/secret.jsonl" }, { path: `${snapshot.profile}/sessions/../auth.json` }]) {
    const f = adapterFixture(); Object.assign(f.thread, patch); await assert.rejects(f.adapter.desktopSession(), { statusCode: 409 });
  }
  for (const patch of [{ sharedParent: {} }, { intentionalStop: true }, { threadId: "bad" }, { nativeAuthMode: "gateway" }]) {
    const f = adapterFixture(); Object.assign(f.adapter, patch); await assert.rejects(f.adapter.desktopSession()); assert.equal(f.calls.length, 0);
  }
  const f = adapterFixture(); await assert.rejects(f.adapter.desktopSession(() => { throw Error("Revoked"); }), /Revoked/); assert.equal(f.calls.length, 0);
  f.adapter.rpc.request = async () => { f.adapter.threadId = randomUUID(); return { thread: f.thread }; }; await assert.rejects(f.adapter.desktopSession(), { statusCode: 409 });
  f.adapter.threadId = threadId; f.adapter.rpc.request = async () => { throw Error("PRIVATE_TOKEN=do-not-expose"); };
  await assert.rejects(f.adapter.desktopSession(), error => error.statusCode === 409 && !error.message.includes("PRIVATE_TOKEN"));
});

async function fixture(t, env = {}) {
  const root = await temporaryDirectory(t), records = new MemoryRecords(), calls = { starts: 0, reads: 0, inputs: [] };
  const config = testConfig(root, { CODEX_AUTH_MODE: "host", AGENT_WEB_AUTH_TOKEN: "desktop-fixture", AGENT_IDLE_TIMEOUT_MS: "60000", ...env });
  const app = await createAgentWebServer({ config, records, adapterFactory: ({ chat, hooks }) => {
    const adapter = { start: async () => { calls.starts++; await hooks.onSessionId(threadId); }, stop: async () => { calls.turnGate?.resolve(); },
      desktopSession: async check => { calls.reads++; calls.entered?.resolve(); await calls.readGate?.promise; check(); return { ...snapshot, workspace: chat.workspace, authMode: config.codex.authMode }; },
      send: async text => { calls.inputs.push(text); await calls.turnGate?.promise; return { text: "Fixture response" }; } };
    return adapter;
  } });
  const { url } = await app.start(); t.after(() => app.stop());
  const chat = await app.manager.createChat({ agent: "codex", title: "Desktop fixture" });
  const request = (pathname = `/api/chats/${chat.id}/desktop-handoff`, options = {}) => fetch(`${url}${pathname}`, { ...options, headers: { authorization: "Bearer desktop-fixture", "content-type": "application/json", ...options.headers } });
  return { app, config, records, calls, chat, request, url };
}

test("controller handoff does not wake, send or stop; a checked locator survives worker and manager restart", async t => {
  const f = await fixture(t), first = await (await f.request()).json(); assert.equal(first.url, null); assert.equal(f.calls.starts, 0);
  f.calls.turnGate = Promise.withResolvers(); const turn = f.app.manager.send(f.chat.id, "Actual fixture request"); await waitFor(() => f.calls.inputs.length);
  const result = await f.request(), active = await result.json(); assert.equal(result.headers.get("cache-control"), "private, no-store");
  assert.equal(active.url, `codex://threads/${threadId}`); assert.equal(active.busy, true); assert.equal(active.source, "connected"); assert.equal(f.calls.inputs.length, 1);
  assert(f.app.manager.isBusy(f.chat.id)); f.calls.turnGate.resolve(); await turn; await f.app.manager.stop(f.chat.id);
  const saved = await (await f.request()).json(); assert.equal(saved.url, active.url); assert.equal(saved.source, "saved"); assert.equal(f.calls.starts, 1); assert.equal(f.calls.reads, 1);
  const restored = new RuntimeManager({ store: f.app.store, config: f.config, broker: new CapabilityBroker({ ttlMs: 1000 }), adapterFactory: () => assert.fail("Handoff must not start a worker") });
  t.after(() => restored.shutdown()); assert.equal((await restored.desktopHandoff(f.chat.id)).url, active.url);
  await f.app.manager.remove(f.chat.id); assert.equal(await f.records.get("desktop-handoff", f.chat.id), null);
});

test("saved desktop locators are bound to owner, company, environment, workspace, provider, session and backend", async t => {
  const f = await fixture(t); await f.app.store.update(f.chat.id, { agentSessionId: threadId });
  const original = f.app.store.get(f.chat.id), binding = desktopBinding(original, f.config);
  await f.records.put("desktop-handoff", f.chat.id, { binding, snapshot });
  assert.equal((await f.app.manager.desktopHandoff(f.chat.id)).url, `codex://threads/${threadId}`);
  for (const change of [{ ownerId: "other" }, { repositories: [{ fullName: "g2i/private" }] }, { environmentId: "other" }, { workspace: "/other" }, { agentSessionId: randomUUID() }, { runtimeMetadata: { backend: "ec2" } }]) {
    assert.notEqual(desktopBinding({ ...original, ...change }, f.config), binding);
    await f.app.store.update(f.chat.id, change); assert.equal((await f.app.manager.desktopHandoff(f.chat.id)).url, null); await f.app.store.update(f.chat.id, original);
  }
  f.config.codex.authMode = "gateway"; assert.equal((await f.app.manager.desktopHandoff(f.chat.id)).url, null);
  f.config.codex.authMode = "host"; f.config.workerBackend = "ec2"; assert.equal((await f.app.manager.desktopHandoff(f.chat.id)).url, null);
  assert.equal(f.calls.starts, 0);
});

test("handoff HTTP enforces auth, private chat ownership, account revocation and provider; no native action POST exists", async t => {
  const f = await fixture(t);
  assert.equal((await fetch(`${f.url}/api/chats/${f.chat.id}/desktop-handoff`)).status, 401);
  assert.equal((await f.request(undefined, { method: "POST", headers: { origin: "https://foreign.invalid" }, body: "{}" })).status, 403);
  assert.equal((await f.request(undefined, { method: "POST", body: "{}" })).status, 404);
  const register = async username => (await f.request("/api/browser-account/register", { method: "POST", body: JSON.stringify({ username, password: "desktop-test-password" }) })).headers.get("set-cookie").split(";")[0];
  const first = await register("desktop-first"), second = await register("desktop-second");
  const account = await (await f.request("/api/browser-account", { headers: { cookie: first } })).json();
  await f.app.store.update(f.chat.id, { ownerId: account.user.id });
  assert.equal((await f.request()).status, 404); assert.equal((await f.request(undefined, { headers: { cookie: second } })).status, 404);
  assert.equal((await f.request(undefined, { headers: { cookie: first } })).status, 200);
  await f.request("/api/browser-account", { method: "DELETE", headers: { cookie: first } }); assert.equal((await f.request(undefined, { headers: { cookie: first } })).status, 404);
  await f.app.store.update(f.chat.id, { ownerId: null, agent: "claude" }); assert.equal((await f.request()).status, 400); assert.equal(f.calls.starts, 0);
});

test("stopping, changing company or revoking an account during inspection cannot return an old locator", async t => {
  for (const change of ["stop", "company", "owner"]) {
    const f = await fixture(t); await f.app.manager.send(f.chat.id, "Seed fixture");
    f.calls.readGate = Promise.withResolvers(); f.calls.entered = Promise.withResolvers();
    const pending = f.request(); await f.calls.entered.promise;
    if (change === "stop") await f.app.manager.stop(f.chat.id);
    else await f.app.store.update(f.chat.id, change === "company" ? { repositories: [{ fullName: "other/private" }] } : { ownerId: "other-account" });
    f.calls.readGate.resolve(); const response = await pending; assert([404, 409].includes(response.status)); assert.equal((await response.json()).url, undefined);
    assert.equal(await f.records.get("desktop-handoff", f.chat.id), null); assert.equal(f.calls.inputs.length, 1);
  }
});

test("sign-out during an authorized request hides its locator, even when the chat is still shared", async t => {
  const f = await fixture(t);
  const registration = await f.request("/api/browser-account/register", { method: "POST", body: JSON.stringify({ username: "handoff-revocation", password: "desktop-test-password" }) });
  const cookie = registration.headers.get("set-cookie").split(";")[0];
  await f.app.manager.send(f.chat.id, "Seed fixture"); f.calls.readGate = Promise.withResolvers(); f.calls.entered = Promise.withResolvers();
  const pending = f.request(undefined, { headers: { cookie } }); await f.calls.entered.promise;
  await f.request("/api/browser-account", { method: "DELETE", headers: { cookie } }); f.calls.readGate.resolve();
  const response = await pending; assert.equal(response.status, 409); assert.equal((await response.json()).profile, undefined);
  assert.equal(f.calls.inputs.length, 1);
});

test("a late locator cache write cannot restore deleted chat metadata", async t => {
  const f = await fixture(t); await f.app.manager.send(f.chat.id, "Seed fixture");
  const entered = Promise.withResolvers(), release = Promise.withResolvers(), put = f.records.put.bind(f.records);
  f.records.put = async (kind, key, value) => { if (kind === "desktop-handoff") { entered.resolve(); await release.promise; } return put(kind, key, value); };
  const pending = f.request(); await entered.promise; await f.app.manager.remove(f.chat.id); release.resolve();
  assert([404, 409].includes((await pending).status)); assert.equal(await f.records.get("desktop-handoff", f.chat.id), null);
});
