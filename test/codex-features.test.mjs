import test from "node:test";
import assert from "node:assert/strict";
import { CodexFeatures } from "../src/codex-features.mjs";
import { CodexAdapter } from "../src/adapters/codex.mjs";
import { createAgentWebServer } from "../src/server.mjs";
import { MemoryRecords } from "../src/database.mjs";
import { temporaryDirectory, testConfig } from "./helpers.mjs";

const feature = (extra = {}) => ({ name: "network_proxy", stage: "beta", displayName: "Network proxy", description: "Restrict sandbox network traffic", announcement: "Restart to apply startup-only changes", enabled: false, defaultEnabled: false, ...extra });
function fixture(options = {}) {
  const state = { thread: "root", busy: false, items: [feature(), feature({ name: "not_beta", stage: "underDevelopment" })], requirements: null, origins: {}, before: async () => {}, afterWrite: async () => {}, methods: [], writes: [], status: "ok" };
  const features = new CodexFeatures({ workspace: "/fixture/workspace", thread: () => state.thread, mutable: true, busy: () => state.busy,
    request: async (method, params) => {
      state.methods.push({ method, params }); await state.before(method, params);
      if (method === "experimentalFeature/list") return structuredClone({ data: state.items, nextCursor: null });
      if (method === "configRequirements/read") return structuredClone({ requirements: state.requirements });
      if (method === "config/read") return structuredClone({ config: { api_key: "private-secret", features: {} }, origins: { provider: { name: { type: "user", file: "/secret-host-path" }, version: "secret" }, ...state.origins } });
      if (method === "config/batchWrite") {
        for (const edit of params.edits) {
          state.writes.push(edit); const selected = state.items.find(item => `features.${item.name}` === edit.keyPath); assert.ok(selected);
          selected.enabled = edit.value; state.origins[edit.keyPath] = { name: { type: "user", file: "/private-config-path", profile: null }, version: `v${state.writes.length}` };
        }
        await state.afterWrite(params); return { status: state.status, version: "native-version", filePath: "/private-config-path" };
      }
      assert.fail(`Unexpected method: ${method}`);
    }, ...options });
  const input = (catalog, action = "enable") => ({ id: "network_proxy", action, confirm: true, threadId: catalog.threadId, revision: catalog.revision });
  const change = async action => features.change(input(await features.list(), action));
  return { features, state, input, change };
}

test("experimental features use thread-scoped native beta metadata and verified allowlisted writes", async () => {
  const { features, state, change } = fixture();
  const catalog = await features.list(); assert.equal(catalog.features.length, 1); assert.deepEqual(catalog.features[0].actions, ["enable"]);
  assert.deepEqual(state.methods.find(call => call.method === "experimentalFeature/list").params, { threadId: "root", limit: 100 });
  assert.deepEqual(state.methods.find(call => call.method === "config/read").params, { cwd: "/fixture/workspace", includeLayers: false });
  assert.equal((await change("enable")).features[0].enabled, true); assert.equal(features.restartRequired, true);
  assert.equal((await change("disable")).features[0].enabled, false);
  assert.deepEqual(state.writes, [{ keyPath: "features.network_proxy", value: true, mergeStrategy: "replace" }, { keyPath: "features.network_proxy", value: false, mergeStrategy: "replace" }]);
  assert.doesNotMatch(JSON.stringify(await features.list()), /private-secret|secret-host-path|private-config-path|filePath|api_key/);
  assert.ok(state.methods.every(call => ["experimentalFeature/list", "configRequirements/read", "config/read", "config/batchWrite"].includes(call.method)));
});

test("native feature revisions ignore JSON property ordering but retain changed policy and definitions", async () => {
  const { features, state, input } = fixture();
  state.origins = { "features.network_proxy": { name: { type: "user", file: "/private-config-path", profile: null }, version: "v1" }, "features.other": { name: { type: "user", profile: null, file: "/private-config-path" }, version: "v1" } };
  const catalog = await features.list(); state.origins = Object.fromEntries(Object.entries(state.origins).reverse());
  state.origins["features.network_proxy"] = { version: "v1", name: { profile: null, file: "/private-config-path", type: "user" } }; state.items[0] = Object.fromEntries(Object.entries(state.items[0]).reverse());
  assert.equal((await features.list()).revision, catalog.revision); assert.equal((await features.change(input(catalog))).features[0].enabled, true);
});

test("experimental shared-host profiles never write and pinned, overridden or missing policy fails closed", async () => {
  const shared = fixture({ mutable: false }); const readonly = await shared.features.list();
  assert.deepEqual(readonly.features[0].actions, []); await assert.rejects(shared.features.change(shared.input(readonly)), /Shared host configuration is read-only/);
  assert.ok(shared.state.methods.every(call => call.method !== "config/batchWrite"));
  for (const requirements of [undefined, {}, { featureRequirements: [] }, { featureRequirements: { unknown: "invalid-policy-value" } }, { featureRequirements: { network_proxy: false } }, { featureRequirements: { network_proxy: true } }]) {
    const { features, state, change } = fixture(); state.requirements = requirements;
    assert.deepEqual((await features.list()).features[0].actions, []); await assert.rejects(change("enable"), /not permitted/); assert.deepEqual(state.writes, []);
  }
  for (const name of [{ type: "project" }, { type: "sessionFlags" }, { type: "mdm" }, { type: "enterpriseManaged" }, { type: "legacyManagedConfigTomlFromFile" }, { type: "newUnknownSource" }, { type: "user", profile: "different-profile" }]) {
    const { features, state } = fixture(); state.origins["features.network_proxy.enabled"] = { name, version: "policy" };
    assert.deepEqual((await features.list()).features[0].actions, [], name.type);
  }
});

test("experimental catalog bounds pagination, rejects duplicate identities and incomplete beta definitions", async () => {
  for (const extra of [{ name: "unsafe.dot.path" }, { enabled: null }, { defaultEnabled: undefined }, { displayName: null }, { description: "x".repeat(2001) }]) {
    const { features, state } = fixture(); state.items = [feature(extra)]; assert.deepEqual((await features.list()).features[0].actions, [], JSON.stringify(extra).slice(0, 80));
  }
  const unknown = fixture(); unknown.state.items = [feature({ enabled: null, defaultEnabled: undefined })];
  const invalid = (await unknown.features.list()).features[0]; assert.equal(invalid.enabled, null); assert.equal(invalid.defaultEnabled, null);
  const repeated = fixture(); repeated.state.items.push(feature({ enabled: true })); assert.deepEqual((await repeated.features.list()).features[0].actions, []);
  const pages = fixture(), request = pages.features.request; let calls = 0;
  pages.features.request = async (method, params) => {
    if (method !== "experimentalFeature/list") return request(method, params);
    calls++; return { data: Array.from({ length: 100 }, (_, i) => feature({ name: `flag_${calls}_${i}` })), nextCursor: `page-${calls}` };
  };
  const bounded = await pages.features.list(); assert.equal(calls, 5); assert.equal(bounded.truncated, true); assert.equal(bounded.features.length, 200); assert.ok(bounded.features.every(item => !item.actions.length));
  pages.features.request = async (method, params) => method === "experimentalFeature/list" ? { data: [], nextCursor: "repeated" } : request(method, params);
  await assert.rejects(pages.features.list(), /pagination did not advance/);
});

test("experimental changes require fresh configuration, native root, confirmation and idle agents", async () => {
  const { features, state, input } = fixture(), catalog = await features.list();
  for (const extra of [{ confirm: false }, { id: "--arbitrary" }, { action: "account/logout" }]) await assert.rejects(features.change({ ...input(catalog), ...extra }), /Choose and confirm/);
  await assert.rejects(features.change({ ...input(catalog), id: "not_beta" }), /not permitted/);
  await assert.rejects(features.change({ ...input(catalog), threadId: "another" }), /native session changed/);
  state.items[0].description = "Changed capability description"; await assert.rejects(features.change(input(catalog)), /configuration changed/);
  state.busy = true; await assert.rejects(features.change(input(catalog)), /idle/);
  const at = state.methods.length; assert.equal((await features.list()).busy, true); assert.ok(state.methods.slice(at).every(call => call.method !== "config/batchWrite"));
  assert.deepEqual(state.writes, []);
});

test("pending feature changes reject concurrent mutation and check authorization again before writing", async () => {
  for (const reason of ["revoked", "busy", "thread"]) {
    const { features, state, input } = fixture(), catalog = await features.list(), entered = Promise.withResolvers(), release = Promise.withResolvers(); let revoked = false;
    state.before = async method => { if (method === "experimentalFeature/list") { entered.resolve(); await release.promise; } };
    const pending = features.change(input(catalog), () => { if (revoked) throw new Error("Access revoked"); });
    const rejected = assert.rejects(pending, /revoked|idle|native session changed/); await entered.promise;
    await assert.rejects(features.change(input(catalog)), /idle/); await assert.rejects(features.list(), /current feature change/);
    if (reason === "revoked") revoked = true; else if (reason === "busy") state.busy = true; else state.thread = "another";
    release.resolve(); await rejected; assert.deepEqual(state.writes, []); assert.equal(features.changing, false);
  }
});

test("partial feature writes and effective overrides require reconciliation without exposing raw errors", async () => {
  const { features, state, input } = fixture(), catalog = await features.list(); let fail = true;
  state.afterWrite = async params => { if (params.edits.length && fail) { fail = false; throw new Error("secret-native-error"); } };
  await assert.rejects(features.change(input(catalog)), error => /Native feature operation/.test(error.message) && !error.message.includes("secret-native-error"));
  assert.equal(features.needsRefresh, true); await assert.rejects(features.change(input(catalog)), /reconcile/);
  state.busy = true; await assert.rejects(features.list(), /idle/); state.busy = false;
  const recovered = await features.list(); assert.equal(recovered.features[0].enabled, true); assert.equal(features.needsRefresh, false); assert.equal(recovered.restartRequired, true);
  state.status = "okOverridden"; await assert.rejects(features.change(input(recovered, "disable")), /overridden/); assert.equal(features.needsRefresh, true);
  state.status = "ok"; const refreshed = await features.list();
  state.afterWrite = async params => { if (params.edits.length) state.items[0].enabled = false; };
  await assert.rejects(features.change(input(refreshed)), /effective state/); assert.equal(features.needsRefresh, true);
});

async function controller(t, mutable = true) {
  const root = await temporaryDirectory(t), native = fixture({ mutable }), hooks = { needsRefresh: false }; let turns = 0;
  const app = await createAgentWebServer({ config: testConfig(root, { AGENT_WEB_AUTH_TOKEN: "features-fixture", AGENT_IDLE_TIMEOUT_MS: "10000" }), records: new MemoryRecords(), models: { creationSettings: async () => ({}), turnSettings: async () => ({}) },
    adapterFactory: ({ chat, hooks: callbacks }) => { native.state.thread = chat.agentSessionId || `root-${chat.id}`; native.features.workspace = chat.workspace;
      return { featureControls: native.features, hookControls: hooks, agents: { busy: () => false, send: async () => assert.fail("Blocked feature state must not start child input") }, start: async () => callbacks.onSessionId(native.state.thread), stop: async () => {}, send: async () => { turns++; return { text: "fixture" }; } }; } });
  const { url } = await app.start(); t.after(() => app.stop()); const chat = await app.manager.createChat({ agent: "codex", title: "Feature controller" });
  const request = (tail, body = {}) => fetch(`${url}/api/chats/${chat.id}/${tail}`, { method: "POST", headers: { authorization: "Bearer features-fixture", "content-type": "application/json" }, body: JSON.stringify(body) });
  return { app, chat, native, hooks, request, url, turns: () => turns };
}

test("feature API requires origin and ownership, preserves messages and cannot mutate shared host profiles", async t => {
  const { app, chat, native, request, url, turns } = await controller(t);
  assert.equal((await fetch(`${url}/api/chats/${chat.id}/experimental`, { method: "POST" })).status, 401);
  assert.equal((await fetch(`${url}/api/chats/${chat.id}/experimental`, { method: "POST", headers: { authorization: "Bearer features-fixture", origin: "https://evil.invalid" } })).status, 403);
  const catalog = await (await request("experimental")).json();
  assert.equal((await request("experimental/change", { ...native.input(catalog), filePath: "/elsewhere", keyPath: "approval_policy", value: "never" })).status, 200);
  assert.deepEqual(native.state.writes, [{ keyPath: "features.network_proxy", value: true, mergeStrategy: "replace" }]);
  assert.equal(turns(), 0); assert.deepEqual(app.store.get(chat.id).messages, []);
  await app.store.update(chat.id, { ownerId: "other-user" }); assert.equal((await request("experimental")).status, 404);
  const shared = await controller(t, false), readonly = await (await shared.request("experimental")).json();
  assert.equal((await shared.request("experimental/change", shared.native.input(readonly))).status, 409); assert.ok(shared.native.state.methods.every(call => call.method !== "config/batchWrite"));
});

test("feature controller cancels changed company, owner or stopped worker and respects other native-setting recovery", async t => {
  for (const reason of ["owner", "company", "stop"]) {
    const { app, chat, native, request } = await controller(t), catalog = await (await request("experimental")).json(), entered = Promise.withResolvers(), release = Promise.withResolvers();
    assert.equal(catalog.threadId, native.state.thread);
    native.state.before = async method => { if (method === "experimentalFeature/list") { entered.resolve(); await release.promise; } };
    const pending = request("experimental/change", native.input(catalog)); await entered.promise;
    if (reason === "owner") await app.store.update(chat.id, { ownerId: "different-user" });
    else if (reason === "company") await app.store.update(chat.id, { repositories: [{ owner: "other", name: "repo", fullName: "other/repo" }] });
    else await app.manager.stop(chat.id);
    release.resolve(); assert.equal((await pending).status, reason === "owner" ? 404 : 409); assert.deepEqual(native.state.writes, []);
  }
  const { app, chat, native, hooks, request } = await controller(t), catalog = await (await request("experimental")).json();
  hooks.needsRefresh = true; const blocked = await request("experimental/change", native.input(catalog)); assert.equal(blocked.status, 409); assert.match((await blocked.json()).error, /Refresh \/hooks/); assert.deepEqual(native.state.writes, []);
  hooks.needsRefresh = false; native.features.needsRefresh = true;
  await assert.rejects(app.manager.agentThreadAction(chat.id, "messages", { rootThreadId: catalog.threadId, threadId: "child", text: "Must not send" }), /Refresh \/experimental/);
});

test("unreconciled feature state blocks main and side input before any native call", async () => {
  for (const field of ["featureControls", "sharedParent"]) for (const flag of ["changing", "needsRefresh"]) {
    const adapter = Object.create(CodexAdapter.prototype); adapter[field] = field === "sharedParent" ? { featureControls: { [flag]: true } } : { [flag]: true };
    await assert.rejects(adapter.send("Must not send"), /feature change/);
  }
});
