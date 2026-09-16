import test from "node:test";
import assert from "node:assert/strict";
import { CodexHooks } from "../src/codex-hooks.mjs";
import { CodexAdapter } from "../src/adapters/codex.mjs";
import { createAgentWebServer } from "../src/server.mjs";
import { MemoryRecords } from "../src/database.mjs";
import { temporaryDirectory, testConfig } from "./helpers.mjs";

const digest = digit => `sha256:${digit.repeat(64)}`;
const raw = (extra = {}) => ({ key: '/fixture/profile/hooks.json:user_prompt_submit:0:0', eventName: "userPromptSubmit", matcher: null, timeoutSec: 60, statusMessage: "Check project", additionalContextLimit: null, sourcePath: "/fixture/profile/hooks.json", source: "user", pluginId: null, displayOrder: 0, enabled: true, isManaged: false, currentHash: digest("a"), trustStatus: "untrusted", handlerType: "command", command: "node check.mjs", async: false, ...extra });
function fixture(options = {}) {
  const state = { hooks: [raw()], thread: "root", busy: false, methods: [], writes: [], before: async () => {}, afterWrite: async () => {}, warnings: [], errors: [] };
  const hooks = new CodexHooks({ workspace: "/fixture/workspace", thread: () => state.thread, busy: () => state.busy, mutable: true,
    request: async (method, params) => {
      state.methods.push({ method, params }); await state.before(method, params);
      if (method === "hooks/list") return structuredClone({ data: [{ cwd: state.cwd || hooks.workspace, hooks: state.hooks, errors: state.errors, warnings: state.warnings }] });
      if (method === "config/batchWrite") {
        for (const edit of params.edits) {
          state.writes.push(edit);
          const hook = state.hooks.find(item => edit.keyPath.startsWith(`hooks.state.${JSON.stringify(item.key)}.`)); assert.ok(hook);
          if (edit.keyPath.endsWith(".enabled")) hook.enabled = edit.value;
          else { assert.ok(edit.keyPath.endsWith(".trusted_hash")); assert.equal(edit.value, hook.currentHash); hook.trustStatus = "trusted"; }
        }
        await state.afterWrite(params); return {};
      }
      assert.fail(`Unexpected native method ${method}`);
    }, ...options });
  const input = (catalog, action = "trust") => ({ id: catalog.hooks[0].id, action, confirm: true, threadId: catalog.threadId, revision: catalog.revision });
  const change = async action => hooks.change(input(await hooks.list(), action));
  return { hooks, state, input, change };
}

test("hook review reloads idle private definitions, scopes native discovery and trusts only the exact native hash", async () => {
  const { hooks, state, input } = fixture();
  state.hooks[0].key = '/fixture/profile/quoted"file.hooks:user_prompt_submit:0:0';
  const catalog = await hooks.list();
  assert.match(catalog.hooks[0].id, /^[a-f0-9]{64}$/); assert.equal(catalog.threadId, "root");
  assert.equal(catalog.hooks[0].command, "node check.mjs"); assert.equal(catalog.hooks[0].sourcePath, "/fixture/profile/hooks.json");
  assert.deepEqual(catalog.hooks[0].actions, ["trust", "disable"]); assert.ok(!Object.hasOwn(catalog.hooks[0], "key"));
  assert.deepEqual(state.methods.slice(0, 2), [{ method: "config/batchWrite", params: { edits: [], reloadUserConfig: true } }, { method: "hooks/list", params: { cwds: ["/fixture/workspace"] } }]);
  const trusted = await hooks.change({ ...input(catalog), currentHash: digest("b"), path: "/not-allowed", keyPath: "approval_policy" });
  assert.equal(trusted.hooks[0].trust, "trusted");
  assert.deepEqual(state.writes, [{ keyPath: `hooks.state.${JSON.stringify(state.hooks[0].key)}.trusted_hash`, value: digest("a"), mergeStrategy: "replace" }]);
  assert.ok(state.methods.every(call => ["hooks/list", "config/batchWrite"].includes(call.method)));
});

test("hook trust preserves disabled state, enable requires trust, and explicit toggles verify effective state", async () => {
  const { hooks, state, change } = fixture(); state.hooks[0].enabled = false;
  assert.deepEqual((await hooks.list()).hooks[0].actions, ["trust"]);
  await assert.rejects(change("enable"), /not permitted/);
  assert.equal((await change("trust")).hooks[0].enabled, false);
  assert.equal((await change("enable")).hooks[0].enabled, true);
  assert.equal((await change("disable")).hooks[0].enabled, false);
  assert.deepEqual(state.writes.map(edit => edit.value), [digest("a"), true, false]);
});

test("shared host hook profiles never write or reveal executable definitions, paths or native errors", async () => {
  const { hooks, state, input } = fixture({ mutable: false });
  state.hooks[0] = raw({ command: "echo private-secret", matcher: "private-secret", statusMessage: "private-secret", sourcePath: "/private-secret/hooks.json", pluginId: "private-secret", server: "private-secret" });
  state.errors = [{ path: "/secret-path", message: "credential=never-expose" }];
  const catalog = await hooks.list(); assert.equal(catalog.mutable, false); assert.deepEqual(catalog.hooks[0].actions, []);
  assert.doesNotMatch(JSON.stringify(catalog), /private-secret|secret-path|never-expose|currentHash|matcher|"command":/);
  await assert.rejects(hooks.change(input(catalog)), /Shared host configuration is read-only/);
  assert.ok(state.methods.every(call => call.method === "hooks/list")); assert.deepEqual(state.writes, []);
  const failed = fixture({ request: async () => { throw new Error("secret-native-error"); } });
  await assert.rejects(failed.hooks.list(), error => /Native hook operation/.test(error.message) && !error.message.includes("secret-native-error"));
});

test("hook policy rejects managed, unsupported, ambiguous, incomplete and unknown trust decisions", async () => {
  for (const extra of [{ isManaged: true }, { trustStatus: "managed" }, ...["system", "mdm", "cloudRequirements", "cloudManagedConfig", "legacyManagedConfigFile", "legacyManagedConfigMdm", "unknown"].map(source => ({ source })), { handlerType: "prompt" }, { handlerType: "agent" }, { eventName: "unrecognized" }, { enabled: null }, { currentHash: "not-a-hash" }, { trustStatus: "new-native-value" }]) {
    const { hooks, state, change } = fixture(); Object.assign(state.hooks[0], extra);
    assert.deepEqual((await hooks.list()).hooks[0].actions, [], JSON.stringify(extra));
    await assert.rejects(change("trust"), /not permitted/); assert.deepEqual(state.writes, []);
  }
  for (const extra of [{ command: "x".repeat(16001) }, { sourcePath: "" }, { matcher: "x".repeat(4001) }, { handlerType: "mcpTool", server: "", tool: "send" }]) {
    const { hooks, state } = fixture(); Object.assign(state.hooks[0], extra);
    assert.deepEqual((await hooks.list()).hooks[0].actions, ["disable"], "Incomplete review does not prevent disabling an unsafe hook");
  }
  const duplicates = fixture(); duplicates.state.hooks.push(raw({ command: "other command" }));
  assert.deepEqual((await duplicates.hooks.list()).hooks[0].actions, []);
  const errors = fixture(); errors.state.errors = [{ message: "secret error" }];
  const catalog = await errors.hooks.list(); assert.deepEqual(catalog.hooks[0].actions, []); assert.doesNotMatch(JSON.stringify(catalog), /secret error/);
  const sessionEnd = fixture(); Object.assign(sessionEnd.state.hooks[0], { handlerType: "mcpTool", server: "fixture", tool: "record", eventName: "sessionEnd" });
  assert.deepEqual((await sessionEnd.hooks.list()).hooks[0].actions, [], "Native SessionEnd does not support MCP hooks");
});

test("hook catalogs support MCP metadata, make hidden text visible and bound review without trusting hidden entries", async () => {
  const { hooks, state, input } = fixture(); state.hooks[0].command = "echo safe\u202e\u001bmalicious";
  const first = await hooks.list(); assert.equal(first.hooks[0].command, "echo safe\\u202e\\u001bmalicious");
  state.hooks = [raw({ handlerType: "mcpTool", command: undefined, server: "fixture", tool: "record", source: "plugin", pluginId: "fixture@local" })];
  const mcp = await hooks.list(); assert.equal(mcp.hooks[0].server, "fixture"); assert.equal(mcp.hooks[0].tool, "record"); assert.ok(mcp.hooks[0].actions.includes("trust"));
  state.hooks = Array.from({ length: 220 }, (_, i) => raw({ key: `hook-${i}` }));
  const catalog = await hooks.list(); assert.equal(catalog.hooks.length, 200); assert.equal(catalog.truncated, true);
  await assert.rejects(hooks.change({ ...input(catalog), id: "0".repeat(64) }), /not permitted/); assert.deepEqual(state.writes, []);
  state.cwd = "/different/workspace"; await assert.rejects(hooks.list(), /this chat's workspace/);
});

test("hook changes require confirmation, a fresh source revision and the current session", async () => {
  const { hooks, state, input } = fixture(), catalog = await hooks.list();
  for (const extra of [{ confirm: false }, { id: "arbitrary-key" }, { action: "delete" }]) await assert.rejects(hooks.change({ ...input(catalog), ...extra }), /Choose and confirm/);
  await assert.rejects(hooks.change({ ...input(catalog), threadId: "other" }), /native session changed/);
  state.hooks[0].currentHash = digest("b"); state.hooks[0].command = "changed source";
  await assert.rejects(hooks.change(input(catalog)), /definition or state changed/);
  state.busy = true; await assert.rejects(hooks.change(input(catalog)), /idle/);
  const reads = state.methods.length; const busy = await hooks.list(); assert.equal(busy.busy, true);
  assert.deepEqual(state.methods.slice(reads).map(call => call.method), ["hooks/list"]);
  assert.deepEqual(state.writes, []);
});

test("in-flight hook changes reject concurrent, revoked, busy and replaced-thread writes", async () => {
  for (const reason of ["revoked", "busy", "thread"]) {
    const { hooks, state, input } = fixture(), catalog = await hooks.list(), entered = Promise.withResolvers(), release = Promise.withResolvers();
    let revoked = false; state.before = async method => { if (method === "hooks/list") { entered.resolve(); await release.promise; } };
    const pending = hooks.change(input(catalog), () => { if (revoked) throw new Error("Access revoked"); });
    const rejected = assert.rejects(pending, /revoked|idle|native session changed/); await entered.promise;
    await assert.rejects(hooks.change(input(catalog)), /idle/); await assert.rejects(hooks.list(), /current hook change/);
    if (reason === "revoked") revoked = true; else if (reason === "busy") state.busy = true; else state.thread = "other";
    release.resolve(); await rejected; assert.deepEqual(state.writes, []); assert.equal(hooks.changing, false);
  }
});

test("partial hook writes and policy overrides remain blocked until refreshed and never report unverified success", async () => {
  const { hooks, state, input } = fixture(), catalog = await hooks.list(); let fail = true;
  state.afterWrite = async params => { if (params.edits.length && fail) { fail = false; throw new Error("connection lost after write"); } };
  await assert.rejects(hooks.change(input(catalog)), /Native hook operation/); assert.equal(hooks.needsRefresh, true);
  await assert.rejects(hooks.change(input(catalog)), /reconcile/); state.busy = true; await assert.rejects(hooks.list(), /idle/);
  state.busy = false; const recovered = await hooks.list(); assert.equal(recovered.hooks[0].trust, "trusted"); assert.equal(hooks.needsRefresh, false);
  state.afterWrite = async params => { if (params.edits.length) state.hooks[0].enabled = true; };
  await assert.rejects(hooks.change(input(recovered, "disable")), /overridden/); assert.equal(hooks.needsRefresh, true);
  assert.equal((await hooks.list()).hooks[0].enabled, true); assert.equal(hooks.needsRefresh, false);
  state.hooks[0].trustStatus = "untrusted"; state.hooks[0].enabled = false;
  const disabled = await hooks.list(); state.hooks[0].enabled = false;
  await assert.rejects(hooks.change(input(disabled)), /overridden/, "Trust must not silently enable a disabled hook");
  state.afterWrite = async () => {}; await hooks.list(); state.hooks[0].enabled = false;
  const enable = await hooks.list(); state.afterWrite = async params => { if (params.edits.length) state.hooks[0].trustStatus = "untrusted"; };
  await assert.rejects(hooks.change(input(enable, "enable")), /overridden/, "Enabling must not claim success if trust was revoked");
});

async function controller(t, mutable = true) {
  const root = await temporaryDirectory(t), native = fixture({ mutable }); let turns = 0;
  const app = await createAgentWebServer({ config: testConfig(root, { AGENT_WEB_AUTH_TOKEN: "hook-fixture", AGENT_IDLE_TIMEOUT_MS: "10000" }), records: new MemoryRecords(), models: { creationSettings: async () => ({}), turnSettings: async () => ({}) },
    adapterFactory: ({ chat, hooks }) => { native.state.thread = chat.agentSessionId || `root-${chat.id}`; native.hooks.workspace = chat.workspace; return { hookControls: native.hooks, start: async () => hooks.onSessionId(native.state.thread), stop: async () => {}, send: async () => { turns++; return { text: "fixture" }; } }; } });
  const { url } = await app.start(); t.after(() => app.stop()); const chat = await app.manager.createChat({ agent: "codex", title: "Hook controller" });
  const request = (tail, body = {}) => fetch(`${url}/api/chats/${chat.id}/${tail}`, { method: "POST", headers: { authorization: "Bearer hook-fixture", "content-type": "application/json" }, body: JSON.stringify(body) });
  return { app, chat, native, request, url, turns: () => turns };
}

test("hook endpoints enforce origin and ownership, with no agent message or shared-profile write", async t => {
  const { app, chat, native, request, url, turns } = await controller(t);
  assert.equal((await fetch(`${url}/api/chats/${chat.id}/hooks`, { method: "POST" })).status, 401);
  assert.equal((await fetch(`${url}/api/chats/${chat.id}/hooks`, { method: "POST", headers: { authorization: "Bearer hook-fixture", origin: "https://evil.invalid" } })).status, 403);
  const catalog = await (await request("hooks")).json(); assert.equal((await request("hooks/change", native.input(catalog))).status, 200);
  assert.equal(turns(), 0); assert.deepEqual(app.store.get(chat.id).messages, []);
  await app.store.update(chat.id, { ownerId: "different-user" }); assert.equal((await request("hooks")).status, 404);
  const shared = await controller(t, false), readonly = await (await shared.request("hooks")).json();
  assert.equal((await shared.request("hooks/change", shared.native.input(readonly))).status, 409);
  assert.ok(shared.native.state.methods.every(call => call.method === "hooks/list"));
});

test("hook controller rejects changed company, owner or stopped worker before a pending write", async t => {
  for (const reason of ["owner", "company", "stop"]) {
    const { app, chat, native, request } = await controller(t), catalog = await (await request("hooks")).json(), entered = Promise.withResolvers(), release = Promise.withResolvers();
    native.state.before = async method => { if (method === "hooks/list") { entered.resolve(); await release.promise; } };
    const pending = request("hooks/change", native.input(catalog)); await entered.promise;
    if (reason === "owner") await app.store.update(chat.id, { ownerId: "other" });
    else if (reason === "company") await app.store.update(chat.id, { repositories: [{ owner: "other-org", name: "repo", fullName: "other-org/repo" }] });
    else await app.manager.stop(chat.id);
    release.resolve(); assert.equal((await pending).status, reason === "owner" ? 404 : 409);
    assert.deepEqual(native.state.writes, []); assert.deepEqual(app.store.get(chat.id).messages, []);
  }
});

test("pending or unreconciled hooks block main and side sends and native settings see active goals and agents", async () => {
  for (const field of ["hookControls", "sharedParent"]) for (const flag of ["changing", "needsRefresh"]) {
    const adapter = Object.create(CodexAdapter.prototype); adapter[field] = field === "sharedParent" ? { hookControls: { [flag]: true } } : { [flag]: true };
    await assert.rejects(adapter.send("No native call allowed"), /hook change/);
  }
  const adapter = Object.create(CodexAdapter.prototype); adapter.children = new Set();
  assert.equal(adapter.nativeSettingsBusy(), false); adapter.goal = { status: "active" }; assert.equal(adapter.nativeSettingsBusy(), true);
  adapter.goal = null; adapter.agents = { busy: () => true }; assert.equal(adapter.nativeSettingsBusy(), true);
  adapter.agents = null; adapter.children.add({ current: {} }); assert.equal(adapter.nativeSettingsBusy(), true);
});
