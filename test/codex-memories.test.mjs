import test from "node:test";
import assert from "node:assert/strict";
import { CodexMemories } from "../src/codex-memories.mjs";
import { CodexAdapter } from "../src/adapters/codex.mjs";
import { createAgentWebServer } from "../src/server.mjs";
import { MemoryRecords } from "../src/database.mjs";
import { temporaryDirectory, testConfig } from "./helpers.mjs";

function fixture(options = {}) {
  const state = { thread: "root", busy: false, flags: [{ name: "memories", stage: "stable", enabled: false, defaultEnabled: false }], config: { memories: null }, requirements: null, origins: {}, calls: [], writes: [], modes: [], resets: 0,
    before: async () => {}, after: async () => {}, writeStatus: "ok" };
  const memories = new CodexMemories({ workspace: "/private/workspace", thread: () => state.thread, mutable: true, busy: () => state.busy,
    request: async (method, params) => {
      state.calls.push({ method, params }); await state.before(method, params); let result;
      if (method === "experimentalFeature/list") result = { data: state.flags, nextCursor: null };
      else if (method === "config/read") result = { config: { api_key: "secret-provider-key", ...state.config }, origins: { private_key: { name: { type: "user", file: "/private/account/path" } }, ...state.origins } };
      else if (method === "configRequirements/read") result = { requirements: state.requirements };
      else if (method === "config/batchWrite") {
        for (const edit of params.edits) {
          state.writes.push(edit);
          if (edit.keyPath === "features.memories") state.flags[0].enabled = edit.value;
          else { assert.ok(["memories.use_memories", "memories.generate_memories"].includes(edit.keyPath)); state.config.memories ||= {}; state.config.memories[edit.keyPath.split(".")[1]] = edit.value; }
          state.origins[edit.keyPath] = { name: { type: "user", file: "/private/profile/config.toml", profile: null }, version: `v${state.writes.length}` };
        }
        result = { status: state.writeStatus };
      } else if (method === "thread/memoryMode/set") { assert.equal(params.threadId, state.thread); state.modes.push(params.mode); result = {}; }
      else if (method === "memory/reset") { assert.equal(params, undefined); state.resets++; result = {}; }
      else assert.fail(`Unexpected method ${method}`);
      await state.after(method, params); return structuredClone(result);
    }, ...options });
  const input = (catalog, id = "feature", action = "enable") => ({ id, action, confirm: true, threadId: catalog.threadId, revision: catalog.revision });
  const change = async (id, action) => memories.change(input(await memories.list(), id, action));
  return { memories, state, input, change };
}
const control = (catalog, id) => catalog.controls.find(item => item.id === id);

test("memory settings discover native defaults and independently update use, generation and feature gating", async () => {
  const { memories, state, change } = fixture(); const catalog = await memories.list();
  assert.deepEqual(catalog.controls.map(item => item.enabled), [false, true, true]);
  assert.deepEqual(state.calls.find(call => call.method === "experimentalFeature/list").params, { threadId: "root", limit: 100 });
  assert.equal((await change("generate", "disable")).currentThreadGeneration, false);
  assert.equal((await change("feature", "enable")).currentThreadGeneration, false, "Enabling the feature must honor an explicit generation opt-out");
  const enabled = await change("generate", "enable"); assert.equal(enabled.currentThreadGeneration, true);
  const use = await change("use", "disable"); assert.equal(control(use, "use").enabled, false); assert.equal(use.currentThreadGeneration, true); assert.equal(use.nextSessionRequired, true);
  assert.equal((await change("feature", "disable")).currentThreadGeneration, false);
  assert.deepEqual(state.modes, ["disabled", "disabled", "enabled", "disabled"]);
  assert.deepEqual(state.writes.map(edit => [edit.keyPath, edit.value]), [["memories.generate_memories", false], ["features.memories", true], ["memories.generate_memories", true], ["memories.use_memories", false], ["features.memories", false]]);
  assert.doesNotMatch(JSON.stringify(await memories.list()), /secret-provider-key|private\/account|private\/profile|api_key/);
  const calls = state.calls.filter(call => call.method === "thread/memoryMode/set" || (call.method === "config/batchWrite" && call.params.edits.length));
  assert.equal(calls[0].method, "thread/memoryMode/set", "Opt-out precedes saving defaults");
  assert.ok(state.calls.every(call => ["experimentalFeature/list", "config/read", "configRequirements/read", "config/batchWrite", "thread/memoryMode/set"].includes(call.method)));
});

test("native memory reset is confirmed, profile-only and does not rewrite settings or remove threads", async () => {
  const { memories, state, input } = fixture(), before = await memories.list();
  await assert.rejects(memories.change({ ...input(before, "reset", "reset"), confirm: false }), /Choose and confirm/);
  await assert.rejects(memories.change(input(before, "feature", "reset")), /Choose and confirm/);
  const after = await memories.change(input(before, "reset", "reset"));
  assert.equal(after.reset, true); assert.deepEqual(after.controls, before.controls); assert.equal(state.resets, 1); assert.deepEqual(state.writes, []); assert.deepEqual(state.modes, []);
  state.after = async method => { if (method === "memory/reset") throw new Error("secret-native-reset-path"); };
  await assert.rejects(memories.change(input(after, "reset", "reset")), error => /Native memory operation/.test(error.message) && !error.message.includes("secret-native-reset-path"));
  assert.equal(memories.needsRefresh, true); const refreshed = await memories.list(); assert.match(refreshed.warning, /may already have been removed/); assert.equal(state.resets, 2, "Refresh must not repeat a destructive reset");
});

test("host profiles never mutate; native overrides, unknown policy and invalid settings are locked", async () => {
  const host = fixture({ mutable: false }), shared = await host.memories.list();
  assert.ok(shared.controls.every(item => !item.actions.length)); assert.equal(shared.resetAllowed, false);
  for (const [id, action] of [["feature", "enable"], ["reset", "reset"]]) await assert.rejects(host.memories.change(host.input(shared, id, action)), /Shared host configuration is read-only/);
  assert.ok(host.state.calls.every(call => !["config/batchWrite", "thread/memoryMode/set", "memory/reset"].includes(call.method)));
  for (const requirements of [undefined, {}, { featureRequirements: [] }, { featureRequirements: { memories: "invalid" } }, { featureRequirements: { memories: true } }]) {
    const { memories, state, change } = fixture(); state.requirements = requirements;
    const result = await memories.list(); assert.ok(result.controls.every(item => !item.actions.length)); assert.equal(result.resetAllowed, false);
    await assert.rejects(change("feature", "enable"), /not permitted/); assert.deepEqual(state.writes, []);
  }
  for (const name of [{ type: "project" }, { type: "sessionFlags" }, { type: "mdm" }, { type: "enterpriseManaged" }, { type: "legacyManagedConfigTomlFromFile" }, { type: "legacyManagedConfigTomlFromMdm" }, { type: "unknown" }, { type: "user", profile: "managed-profile" }]) {
    const { memories, state } = fixture(); state.origins.memories = { name }; assert.deepEqual(control(await memories.list(), "generate").actions, [], name.type);
  }
  const pinned = fixture(); pinned.state.requirements = { featureRequirements: { memories: false } };
  assert.deepEqual(control(await pinned.memories.list(), "feature").actions, []);
  const incomplete = fixture(); incomplete.state.config.memories = { use_memories: "bad" };
  assert.equal(control(await incomplete.memories.list(), "use").enabled, null); assert.deepEqual(control(await incomplete.memories.list(), "use").actions, []);
});

test("memory discovery rejects missing/duplicate flags and bounded pagination; equivalent config retains its revision", async () => {
  for (const flags of [[], [{ name: "memories", stage: "removed", enabled: true }], [{ name: "memories", stage: "stable", enabled: null }], [{ name: "memories", stage: "stable", enabled: true }, { name: "memories", stage: "stable", enabled: false }]]) {
    const { memories, state } = fixture(); state.flags = flags; const result = await memories.list(); assert.equal(result.resetAllowed, false); assert.ok(result.controls.every(item => !item.actions.length));
  }
  const { memories, state } = fixture(); state.config.memories = { generate_memories: true, use_memories: false };
  state.origins.memories = { version: "v1", name: { type: "user", profile: null } }; const before = await memories.list();
  state.config.memories = { use_memories: false, generate_memories: true }; state.origins.memories = { name: { profile: null, type: "user" }, version: "v1" };
  assert.equal((await memories.list()).revision, before.revision);
  const request = memories.request; let pages = 0;
  memories.request = async (method, params) => method === "experimentalFeature/list" ? { data: state.flags, nextCursor: `page-${++pages}` } : request(method, params);
  const limited = await memories.list(); assert.equal(pages, 5); assert.equal(limited.resetAllowed, false); assert.ok(limited.controls.every(item => !item.actions.length));
  memories.request = async (method, params) => method === "experimentalFeature/list" ? { data: [], nextCursor: "same" } : request(method, params);
  await assert.rejects(memories.list(), /pagination did not advance/);
});

test("memory mutations recheck revision, root, authorization and activity before native writes", async () => {
  const base = fixture(), catalog = await base.memories.list();
  await assert.rejects(base.memories.change({ ...base.input(catalog), id: "memories.extract_model" }), /Choose and confirm/);
  await assert.rejects(base.memories.change({ ...base.input(catalog), threadId: "other" }), /session changed/);
  base.state.config.memories = { use_memories: false }; await assert.rejects(base.memories.change(base.input(catalog)), /configuration changed/);
  base.state.busy = true; await assert.rejects(base.memories.change(base.input(catalog)), /idle/); const at = base.state.calls.length; assert.equal((await base.memories.list()).busy, true); assert.ok(base.state.calls.slice(at).every(call => call.method !== "config/batchWrite"));
  for (const reason of ["revoked", "busy", "thread"]) {
    const { memories, state, input } = fixture(), before = await memories.list(), entered = Promise.withResolvers(), release = Promise.withResolvers(); let revoked = false;
    state.before = async method => { if (method === "experimentalFeature/list") { entered.resolve(); await release.promise; } };
    const pending = memories.change(input(before), () => { if (revoked) throw new Error("Access revoked"); });
    const rejected = assert.rejects(pending, /revoked|idle|session changed/); await entered.promise;
    await assert.rejects(memories.change(input(before)), /idle/); await assert.rejects(memories.list(), /current memory change/);
    if (reason === "revoked") revoked = true; else if (reason === "busy") state.busy = true; else state.thread = "other";
    release.resolve(); await rejected; assert.deepEqual(state.writes, []); assert.deepEqual(state.modes, []); assert.equal(memories.changing, false);
  }
});

test("uncertain memory changes block input until refresh, without undoing an opt-out or re-enabling a changed preference", async () => {
  const { memories, state, input } = fixture(); state.flags[0].enabled = true;
  const before = await memories.list(); let fail = true;
  state.before = async (method, params) => { if (method === "config/batchWrite" && params.edits.length && fail) { fail = false; throw new Error("secret-native-config"); } };
  await assert.rejects(memories.change(input(before, "generate", "disable")), error => /Native memory operation/.test(error.message) && !error.message.includes("secret-native-config"));
  assert.deepEqual(state.modes, ["disabled"]); assert.equal(memories.needsRefresh, true);
  await assert.rejects(memories.change(input(before)), /reconcile/); state.busy = true; await assert.rejects(memories.list(), /idle/); state.busy = false;
  const recovered = await memories.list(); assert.equal(recovered.currentThreadGeneration, false); assert.equal(control(recovered, "generate").enabled, true); assert.deepEqual(state.modes, ["disabled"], "Reload cannot reverse a successful current-chat opt-out");
  state.config.memories = { generate_memories: false }; const next = await memories.list();
  state.before = async method => { if (method === "thread/memoryMode/set" && fail) { fail = false; throw new Error("Failed mode update"); } }; fail = true;
  await assert.rejects(memories.change(input(next, "generate", "enable")), /Native memory operation/); assert.equal(memories.pendingGeneration.value, true);
  state.config.memories.generate_memories = false; const changed = await memories.list(); assert.equal(changed.currentThreadGeneration, false); assert.deepEqual(state.modes, ["disabled", "disabled"]);
  state.writeStatus = "okOverridden"; await assert.rejects(memories.change(input(changed, "use", "disable")), /overridden/); assert.equal(memories.needsRefresh, true);
});

test("a concurrent native contribution opt-out wins while an enable is being applied", async () => {
  const { memories, state, input } = fixture(); state.flags[0].enabled = true; state.config.memories = { generate_memories: false };
  const catalog = await memories.list();
  state.after = async (method, params) => { if (method === "thread/memoryMode/set" && params.mode === "enabled") state.config.memories.generate_memories = false; };
  await assert.rejects(memories.change(input(catalog, "generate", "enable")), /preferences changed/);
  assert.deepEqual(state.modes, ["enabled", "disabled"]); assert.equal(memories.needsRefresh, true);
  const result = await memories.list(); assert.equal(result.currentThreadGeneration, false); assert.equal(control(result, "generate").enabled, false);
});

async function controller(t, mutable = true) {
  const root = await temporaryDirectory(t), native = fixture({ mutable }), featureControls = { needsRefresh: false }; let turns = 0;
  const app = await createAgentWebServer({ config: testConfig(root, { AGENT_WEB_AUTH_TOKEN: "memory-fixture", AGENT_IDLE_TIMEOUT_MS: "10000" }), records: new MemoryRecords(), models: { creationSettings: async () => ({}), turnSettings: async () => ({}) },
    adapterFactory: ({ chat, hooks }) => { native.state.thread = chat.agentSessionId || `root-${chat.id}`; native.memories.workspace = chat.workspace;
      return { memoryControls: native.memories, featureControls, agents: { busy: () => false, send: async () => assert.fail("Unreconciled memory state cannot start child input") }, start: async () => hooks.onSessionId(native.state.thread), stop: async () => {}, send: async () => { turns++; return { text: "fixture" }; } }; } });
  const { url } = await app.start(); t.after(() => app.stop()); const chat = await app.manager.createChat({ agent: "codex", title: "Memory controller" });
  const request = (tail, body = {}) => fetch(`${url}/api/chats/${chat.id}/${tail}`, { method: "POST", headers: { authorization: "Bearer memory-fixture", "content-type": "application/json" }, body: JSON.stringify(body) });
  return { app, chat, native, featureControls, request, url, turns: () => turns };
}

test("memory API enforces owner/origin, allowlists actions and preserves saved chat messages", async t => {
  const { app, chat, native, request, url, turns } = await controller(t);
  assert.equal((await fetch(`${url}/api/chats/${chat.id}/memories`, { method: "POST" })).status, 401);
  assert.equal((await fetch(`${url}/api/chats/${chat.id}/memories`, { method: "POST", headers: { authorization: "Bearer memory-fixture", origin: "https://evil.invalid" } })).status, 403);
  const catalog = await (await request("memories")).json(); assert.equal(catalog.threadId, native.state.thread);
  assert.equal((await request("memories/change", { ...native.input(catalog, "reset", "reset"), filePath: "/other/profile", method: "thread/delete", threadIdToDelete: "other" })).status, 200);
  assert.equal(native.state.resets, 1); assert.deepEqual(app.store.get(chat.id).messages, []); assert.equal(turns(), 0);
  await app.store.update(chat.id, { ownerId: "other-user" }); assert.equal((await request("memories")).status, 404);
  const shared = await controller(t, false), readonly = await (await shared.request("memories")).json();
  assert.equal((await shared.request("memories/change", shared.native.input(readonly, "reset", "reset"))).status, 409); assert.equal(shared.native.state.resets, 0);
});

test("memory controller cancels changed company/owner or Stop, and rejects input during unreconciled changes", async t => {
  for (const reason of ["owner", "company", "stop"]) {
    const { app, chat, native, request } = await controller(t), catalog = await (await request("memories")).json(), entered = Promise.withResolvers(), release = Promise.withResolvers(); assert.equal(catalog.threadId, native.state.thread);
    native.state.before = async method => { if (method === "experimentalFeature/list") { entered.resolve(); await release.promise; } };
    const pending = request("memories/change", native.input(catalog, "reset", "reset")); await entered.promise;
    if (reason === "owner") await app.store.update(chat.id, { ownerId: "other-user" });
    else if (reason === "company") await app.store.update(chat.id, { repositories: [{ owner: "other-company", name: "repo", fullName: "other-company/repo" }] });
    else await app.manager.stop(chat.id);
    release.resolve(); assert.equal((await pending).status, reason === "owner" ? 404 : 409); assert.equal(native.state.resets, 0); assert.deepEqual(native.state.writes, []);
  }
  const { app, chat, native, featureControls, request } = await controller(t), catalog = await (await request("memories")).json();
  featureControls.needsRefresh = true; const blocked = await request("memories/change", native.input(catalog)); assert.equal(blocked.status, 409); assert.match((await blocked.json()).error, /Refresh \/experimental/);
  featureControls.needsRefresh = false; native.memories.needsRefresh = true;
  await assert.rejects(app.manager.agentThreadAction(chat.id, "messages", { rootThreadId: catalog.threadId, threadId: "child", text: "Must not send" }), /Refresh \/memories/);
  for (const field of ["memoryControls", "sharedParent"]) for (const flag of ["changing", "needsRefresh"]) {
    const adapter = Object.create(CodexAdapter.prototype); adapter[field] = field === "sharedParent" ? { memoryControls: { [flag]: true } } : { [flag]: true };
    await assert.rejects(adapter.send("Must not send"), /memory change/);
  }
});
