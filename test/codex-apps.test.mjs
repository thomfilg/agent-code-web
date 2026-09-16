import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { mkdir, readdir } from "node:fs/promises";
import { CodexApps, appReferencesForTurn } from "../src/codex-apps.mjs";
import { CodexAdapter } from "../src/adapters/codex.mjs";
import { CapabilityBroker } from "../src/capabilities.mjs";
import { ChatStore } from "../src/store.mjs";
import { MemoryRecords } from "../src/database.mjs";
import { createAgentWebServer } from "../src/server.mjs";
import { temporaryDirectory, testConfig, waitFor } from "./helpers.mjs";

function nativeFixture() {
  const state = { enabled: true, before: async () => {}, calls: [], threadId: "native-root" };
  const request = async (method, params) => {
    state.calls.push({ method, params }); await state.before(method);
    if (method === "app/installed") return { apps: [{ id: "app_fixture", enabled: state.enabled, callable: true }, { id: "app_policy", enabled: true, callable: false }] };
    if (method === "app/list") return { data: [
      { id: "app_fixture", name: "Fixture App", description: "Existing connection", isAccessible: true, isEnabled: true, installUrl: "https://not-returned.example/private", private: "never exposed" },
      { id: "app_policy", name: "Policy App", isAccessible: true, isEnabled: true },
      { id: "app_unlinked", name: "Unlinked App", isAccessible: false, isEnabled: true },
    ], nextCursor: null };
    throw new Error(`Unexpected app method: ${method}`);
  };
  return { state, request, apps: new CodexApps(request, () => state.threadId) };
}

test("native apps use a thread-scoped allowlist and preserve access, enablement and callable policy", async () => {
  const { state, apps } = nativeFixture();
  const catalog = await apps.list();
  assert.equal(catalog.threadId, "native-root"); assert.equal(catalog.apps[0].token, "$fixture-app");
  assert.deepEqual(catalog.apps.map(app => app.callable), [true, false, false]);
  assert.doesNotMatch(JSON.stringify(catalog), /private|never exposed|installUrl/);
  assert.ok(state.calls.every(call => call.params.threadId === "native-root"));
  assert.ok(state.calls.every(call => ["app/list", "app/installed"].includes(call.method)));
  assert.deepEqual(await apps.mentions([{ id: "app_fixture" }]), [{ type: "mention", name: "Fixture App", path: "app://app_fixture" }]);
  await assert.rejects(apps.select("app_fixture", "other-thread"), /native session changed/);
  await assert.rejects(apps.select("app_policy", "native-root"), /no longer accessible/);
  await assert.rejects(apps.mentions([{ id: "../app_fixture" }]), /Invalid/);
  state.enabled = false;
  await assert.rejects(apps.mentions([{ id: "app_fixture" }]), /no longer accessible/);
  state.threadId = null; await assert.rejects(apps.list(), /Connect this chat/);
});

test("native app catalogs bound pagination, reject repeated cursors and fail closed on ambiguous permissions", async () => {
  let thread = "root", calls = 0;
  const apps = new CodexApps(async (method, params) => {
    if (method === "app/installed") return { apps: Array.from({ length: 3 }, () => ({ id: "duplicate", enabled: true, callable: true })) };
    calls++;
    return { data: [{ id: "duplicate", name: "Ambiguous", isAccessible: true, isEnabled: true }, ...Array.from({ length: 49 }, (_, i) => ({ id: `p${calls}_${i}`, name: "Example", isEnabled: true, isAccessible: true }))], nextCursor: `page-${calls}` };
  }, () => thread);
  const result = await apps.list(); assert.equal(calls, 4); assert.equal(result.truncated, true); assert.ok(result.apps.length <= 200); assert.equal(result.apps[0].callable, false);
  const repeating = new CodexApps(async method => method === "app/installed" ? { apps: [] } : { data: [], nextCursor: "repeated" }, () => "root");
  await assert.rejects(repeating.list(), /invalid app-list cursor/);
  const changing = new CodexApps(async method => { if (method === "app/installed") return { apps: [] }; thread = "replacement"; return { data: [] }; }, () => thread);
  await assert.rejects(changing.list(), /native session changed/);
});

test("native adapter sends structured app references and cancels before a revoked or interrupted app turn", async t => {
  const root = await temporaryDirectory(t), store = new ChatStore(root); await store.initialize();
  const chat = await store.create({ agent: "codex", title: "App adapter" });
  await mkdir(chat.workspace, { recursive: true });
  const adapter = new CodexAdapter({ chat, store, config: testConfig(root, { CODEX_BIN: path.resolve("test/fixtures/fake-codex.mjs") }), broker: new CapabilityBroker({ ttlMs: 10000 }), hooks: { onRequest: request => adapter.respond(request.requestId, { decision: "accept" }) } });
  t.after(() => adapter.stop()); await adapter.start();
  const fixture = nativeFixture(), original = adapter.rpc.request.bind(adapter.rpc), turns = [];
  adapter.rpc.request = (method, params, timeout) => {
    if (method.startsWith("app/")) return fixture.request(method, params);
    if (method === "turn/start") turns.push(params);
    return original(method, params, timeout);
  };
  await adapter.send("Use $fixture-app", { appReferences: [{ id: "app_fixture" }] });
  assert.deepEqual(turns[0].input.at(-1), { type: "mention", name: "Fixture App", path: "app://app_fixture" });
  assert.ok(fixture.state.calls.every(call => call.params.threadId === "thr_fixture"));
  fixture.state.enabled = false;
  await assert.rejects(adapter.send("Must not reach model", { appReferences: [{ id: "app_fixture" }] }), /no longer accessible/);
  assert.equal(turns.length, 1);
  fixture.state.enabled = true;
  const waiting = Promise.withResolvers(), entered = Promise.withResolvers();
  fixture.state.before = async () => { entered.resolve(); await waiting.promise; };
  const sending = adapter.send("Cancelled app turn", { appReferences: [{ id: "app_fixture" }] });
  const rejection = assert.rejects(sending, /interrupted/);
  await entered.promise; const stopping = adapter.interrupt(); waiting.resolve(); await stopping; await rejection;
  assert.equal(turns.length, 1);
});

async function controller(t) {
  const root = await temporaryDirectory(t), native = nativeFixture(), records = new MemoryRecords(), turns = [];
  let starts = 0, beforeSend = async () => {};
  const config = testConfig(root, { AGENT_WEB_AUTH_TOKEN: "apps-fixture", AGENT_IDLE_TIMEOUT_MS: "10000" });
  const app = await createAgentWebServer({ config, records, models: { creationSettings: async () => ({}), turnSettings: async () => ({}) },
    adapterFactory: ({ chat, hooks }) => {
      const threadId = chat.agentSessionId || `native-${chat.id}`;
      const apps = new CodexApps(native.request, () => threadId);
      return { apps, start: async () => { starts++; await hooks.onSessionId(threadId); }, stop: async () => {},
        send: async (text, settings) => { const mentions = await apps.mentions(settings.appReferences); turns.push({ text, mentions }); await beforeSend(text); return { text: "Fixture response" }; } };
    } });
  const { url } = await app.start(); t.after(() => app.stop());
  const chat = await app.manager.createChat({ agent: "codex", title: "Apps controller" });
  const request = (tail, body = {}, id = chat.id) => fetch(`${url}/api/chats/${id}/${tail}`, { method: "POST", headers: { authorization: "Bearer apps-fixture", "content-type": "application/json" }, body: JSON.stringify(body) });
  const choose = async () => {
    const catalog = await (await request("apps")).json();
    const result = await request("apps/select", { appId: "app_fixture", threadId: catalog.threadId });
    assert.equal(result.status, 200); return (await result.json()).attachment;
  };
  return { app, root, records, chat, request, choose, turns, native, starts: () => starts, url, beforeSend: fn => beforeSend = fn };
}

test("app picker endpoints enforce owner and origin guards; saved references survive stop without copying credentials", async t => {
  const { app, chat, request, choose, starts, url, turns, records } = await controller(t);
  assert.equal((await fetch(`${url}/api/chats/${chat.id}/apps`, { method: "POST" })).status, 401);
  assert.equal((await fetch(`${url}/api/chats/${chat.id}/apps`, { method: "POST", headers: { authorization: "Bearer apps-fixture", origin: "https://evil.example" } })).status, 403);
  const file = await choose(); assert.equal(starts(), 1); assert.deepEqual(app.store.get(chat.id).messages, []); assert.deepEqual(turns, []);
  const uploads = await readdir(path.join(app.store.runtimeHome(chat.id), "uploads")).catch(() => []); assert.deepEqual(uploads, []);
  assert.equal(file.appReference.threadId, app.store.get(chat.id).agentSessionId);
  const forged = await app.manager.attachments.upload(chat.id, { name: "fake.txt", data: "", appReference: file.appReference });
  assert.equal((await app.manager.attachments.resolve(chat.id, [forged.id]))[0].appReference, undefined);
  const other = await app.manager.createChat({ agent: "codex", title: "Other app chat" });
  await assert.rejects(app.manager.submit(other.id, "Cross-chat reference", [file.id]), /not found in this chat/);
  await app.manager.stop(chat.id);
  assert.equal((await records.get("attachment", file.id)).appReference.id, "app_fixture");
  const sent = await app.manager.submit(chat.id, "Use $fixture-app now", [file.id]); await sent.completion;
  assert.equal(starts(), 2); assert.equal(turns.length, 1); assert.equal(turns[0].mentions[0].path, "app://app_fixture");
  const message = app.store.get(chat.id).messages.find(message => message.id === sent.message.id);
  assert.equal(message.attachments[0].path, undefined);
  assert.doesNotMatch(turns[0].text, /User attachments|uploads/);
  await app.store.update(chat.id, { ownerId: "another-user" });
  assert.equal((await request("apps")).status, 404);
});

test("queued app inputs are revalidated and cannot dispatch after access is revoked", async t => {
  const { app, chat, choose, beforeSend, native, turns } = await controller(t), file = await choose();
  const release = Promise.withResolvers(); beforeSend(async text => { if (text.includes("Busy fixture")) await release.promise; });
  const active = await app.manager.submit(chat.id, "Busy fixture"); await waitFor(() => turns.length === 1);
  await app.manager.enqueue(chat.id, "Queued app fixture", [file.id]);
  native.state.enabled = false; release.resolve(); await active.completion;
  await waitFor(() => app.store.get(chat.id).queueError?.includes("no longer accessible"));
  assert.equal(turns.length, 1); assert.equal(app.store.get(chat.id).queuePaused, true);
  assert.ok(app.store.get(chat.id).messages.some(message => message.text === "Queued app fixture" && message.attachments?.[0].id === file.id));
});

test("app capture rejects ownership revocation and manual stop while a native request is pending", async t => {
  for (const action of ["owner", "stop"]) {
    const { app, chat, request, native } = await controller(t);
    const catalog = await (await request("apps")).json();
    const entered = Promise.withResolvers(), waiting = Promise.withResolvers();
    native.state.before = async () => { entered.resolve(); await waiting.promise; };
    const pending = request("apps/select", { appId: "app_fixture", threadId: catalog.threadId });
    await entered.promise;
    if (action === "owner") await app.store.update(chat.id, { ownerId: "another-user" }); else await app.manager.stop(chat.id);
    waiting.resolve(); const result = await pending;
    assert.equal(result.status, action === "owner" ? 404 : 409);
    assert.equal((await app.store.records.list("attachment")).length, 0);
  }
});

test("company, native session and fork changes cannot silently reuse an app reference", async t => {
  const { app, chat, choose } = await controller(t), file = await choose(), current = app.store.get(chat.id);
  assert.deepEqual(appReferencesForTurn(current, [file], null), [{ id: "app_fixture" }]);
  for (const changed of [{ ...current, agent: "claude" }, { ...current, ownerId: "other-user" }, { ...current, agentSessionId: "other-thread" }]) assert.throws(() => appReferencesForTurn(changed, [file], null), /different session or company/);
  assert.throws(() => appReferencesForTurn(current, [file], "other-company"), /different session or company/);
  const target = await app.manager.createChat({ agent: "codex", title: "Fork target fixture" });
  const copy = await app.manager.attachments.forkMessages(chat.id, target.id, [{ role: "user", text: "Historical app use", attachments: [file] }]);
  const rebound = copy.messages[0].attachments[0]; assert.equal(rebound.appReference.inactive, true);
  assert.throws(() => appReferencesForTurn({ ...current, id: target.id }, [rebound], null), /different session or company/);
});
