import test from "node:test";
import assert from "node:assert/strict";
import { CodexPlugins, CodexPluginCli } from "../src/codex-plugins.mjs";
import { CommandCatalog } from "../src/command-catalog.mjs";
import { spawnWorker } from "../src/worker-process.mjs";
import { createAgentWebServer } from "../src/server.mjs";
import { MemoryRecords } from "../src/database.mjs";
import { temporaryDirectory, testConfig } from "./helpers.mjs";

function fixture(options = {}) {
  const state = { installed: false, enabled: false, busy: false, thread: "root", version: "1.0.0", policy: {}, before: async () => {}, changes: [], methods: [], loads: 0, refreshed: 0 };
  const raw = () => ({ pluginId: "fixture@market", name: "fixture", marketplaceName: "market", installed: state.installed, enabled: state.enabled, version: state.version, installPolicy: "AVAILABLE", source: { source: "git", url: "https://private:secret@registry.invalid/path?token=secret" } });
  const run = async args => {
    await state.before(args[0]);
    if (args[0] === "list") { state.loads++; return { installed: state.installed ? [raw()] : [], available: state.installed ? [] : [raw()] }; }
    state.changes.push(args); state.installed = args[0] === "add"; state.enabled = state.installed; return {};
  };
  const request = async (method, params) => {
    state.methods.push({ method, params }); await state.before(method);
    if (method === "plugin/installed") return { marketplaces: [{ name: "market", plugins: [{ id: "fixture@market", installed: state.installed, enabled: state.enabled, availability: "AVAILABLE", installPolicy: "AVAILABLE", interface: { displayName: "Fixture", longDescription: "Fixture description", capabilities: ["skills"], logoUrl: "https://never-fetched.invalid/private" }, ...state.policy }] }], marketplaceLoadErrors: state.errors || [] };
    if (method === "config/batchWrite") { state.changes.push(params); if (params.edits.length) state.enabled = params.edits[0].value; return {}; }
    if (method === "plugin/reconcile") return {};
    throw new Error(`Unexpected ${method}`);
  };
  const plugins = new CodexPlugins({ run, request, workspace: "/fixture/workspace", thread: () => state.thread, mutable: true, busy: () => state.busy, changed: async () => { state.refreshed++; }, ...options });
  const change = async (action, extra = {}) => {
    const catalog = await plugins.list();
    return plugins.change({ id: "fixture@market", action, confirm: true, threadId: catalog.threadId, revision: catalog.revision, ...extra });
  };
  return { plugins, state, run, request, change };
}

test("plugins use supported native paths, sanitize metadata and verify the complete installation cycle", async () => {
  const { plugins, state, change } = fixture();
  const catalog = await plugins.list();
  assert.deepEqual(catalog.plugins[0].actions, ["install"]);
  assert.doesNotMatch(JSON.stringify(catalog), /secret|registry.invalid|never-fetched|logoUrl/);
  assert.equal((await change("install")).plugins[0].enabled, true);
  assert.equal((await change("disable")).plugins[0].enabled, false);
  assert.equal((await change("enable")).plugins[0].enabled, true);
  assert.equal((await change("remove")).plugins[0].installed, false);
  assert.equal(state.refreshed, 4);
  assert.deepEqual(state.changes.filter(Array.isArray), [["add", "fixture@market", "--json"], ["remove", "fixture@market", "--json"]]);
  const writes = state.methods.filter(call => call.method === "config/batchWrite");
  assert.deepEqual(writes.find(call => call.params.edits.length).params, { edits: [{ keyPath: 'plugins."fixture@market".enabled', value: false, mergeStrategy: "replace" }], reloadUserConfig: true });
  assert.ok(state.methods.every(call => ["plugin/installed", "plugin/reconcile", "config/batchWrite"].includes(call.method)));
});

test("plugin mutations fail closed for shared profiles, native policy, missing policy and installation consent", async () => {
  const shared = fixture({ mutable: false });
  assert.deepEqual((await shared.plugins.list()).plugins[0].actions, []);
  await assert.rejects(shared.change("install"), /Shared host configuration is read-only/);
  assert.deepEqual(shared.state.changes, []);
  for (const policy of [{ installPolicySource: "WORKSPACE_SETTING" }, { installPolicy: "INSTALLED_BY_DEFAULT" }, { installPolicy: "NOT_AVAILABLE" }, { availability: "DISABLED_BY_ADMIN" }, { disabledReason: "required_app_unavailable" }, { mustShowInstallationInterstitial: true }, { installed: undefined }]) {
    const { plugins, state, change } = fixture(); state.policy = policy;
    if (Object.hasOwn(policy, "installed")) state.installed = true;
    assert.deepEqual((await plugins.list()).plugins[0].actions, [], JSON.stringify(policy));
    await assert.rejects(change("install"), /no longer permitted/); assert.deepEqual(state.changes, []);
  }
  const failing = fixture(); failing.state.errors = [{ message: "Secret registry error not exposed" }];
  const catalog = await failing.plugins.list(); assert.deepEqual(catalog.plugins[0].actions, []); assert.doesNotMatch(JSON.stringify(catalog), /Secret registry/);
});

test("plugin actions require confirmation and fresh identity, source revision, and idle state", async () => {
  const { plugins, state, change } = fixture();
  for (const extra of [{ confirm: false }, { id: "--malicious@market" }, { action: "account/logout" }, { id: 'evil";inject@market' }]) await assert.rejects(change("install", extra), /Choose and confirm/);
  await assert.rejects(change("install", { threadId: "foreign" }), /native session changed/);
  const old = await plugins.list(); state.version = "2.0.0";
  await assert.rejects(plugins.change({ id: "fixture@market", action: "install", confirm: true, threadId: old.threadId, revision: old.revision }), /catalog changed/);
  state.busy = true; await assert.rejects(change("install"), /idle/);
  assert.deepEqual(state.changes, []);
});

test("pending plugin actions recheck authorization, reject concurrent mutation and never write after cancellation", async () => {
  for (const action of ["revoked", "busy", "thread"]) {
    const { plugins, state } = fixture(), catalog = await plugins.list(), entered = Promise.withResolvers(), release = Promise.withResolvers();
    let revoked = false;
    state.before = async method => { if (method === "list") { entered.resolve(); await release.promise; } };
    const input = { id: "fixture@market", action: "install", confirm: true, threadId: catalog.threadId, revision: catalog.revision };
    const pending = plugins.change(input, () => { if (revoked) throw new Error("Access revoked"); });
    const rejected = assert.rejects(pending, /revoked|idle|native session changed/);
    await entered.promise; await assert.rejects(plugins.change(input), /idle/);
    if (action === "revoked") revoked = true; else if (action === "busy") state.busy = true; else state.thread = "new-root";
    release.resolve(); await rejected; assert.deepEqual(state.changes, []); assert.equal(plugins.changing, false);
  }
});

test("plugin catalogs bound entries, reject ambiguous identities and do not expose native error details", async () => {
  const { plugins, state } = fixture();
  const duplicate = { pluginId: "fixture@market", name: "fixture", installPolicy: "AVAILABLE", installed: false };
  plugins.run = async () => ({ installed: [{ ...duplicate, installed: true }], available: [duplicate, ...Array.from({ length: 240 }, (_, i) => ({ ...duplicate, pluginId: `plugin${i}@market` }))] });
  const catalog = await plugins.list(); assert.equal(catalog.plugins.length, 200); assert.equal(catalog.truncated, true);
  assert.deepEqual(catalog.plugins.find(plugin => plugin.id === "fixture@market").actions, []);
  const hidden = fixture({ request: async () => { throw new Error("token=secret /private/config.toml"); } });
  await assert.rejects(hidden.plugins.list(), error => /Native plugin operation/.test(error.message) && !/secret|config.toml/.test(error.message));
  assert.deepEqual(state.changes, []);
  const refused = fixture(); refused.state.installed = true; let movedOutsideWindow = false;
  refused.plugins.run = async args => {
    if (args[0] === "remove") { movedOutsideWindow = true; return {}; }
    const result = await refused.run(args);
    if (movedOutsideWindow) result.available = Array.from({ length: 210 }, (_, i) => ({ ...duplicate, pluginId: `aaa${i}@market` }));
    return result;
  };
  await assert.rejects(refused.change("remove"), /did not match/);
  assert.equal(refused.state.installed, true, "Moving outside the bounded catalog is not proof of removal");
});

test("an interrupted plugin mutation requires reconciliation before another change and preserves native policy overrides", async () => {
  const { plugins, state, change } = fixture();
  let once = true;
  state.before = async method => { if (method === "plugin/reconcile" && once) { once = false; throw new Error("lost connection"); } };
  await assert.rejects(change("install"), /Native plugin operation/);
  assert.equal(state.installed, true); assert.equal(plugins.needsRefresh, true);
  await assert.rejects(plugins.change({ id: "fixture@market", action: "remove", confirm: true, threadId: "root", revision: "old" }), /reconcile/);
  const catalog = await plugins.list(); assert.equal(catalog.plugins[0].installed, true); assert.equal(plugins.needsRefresh, false); assert.equal(state.refreshed, 1);
  state.policy = { enabled: true }; // A native project override prevents disabling.
  await assert.rejects(change("disable"), /did not match/); assert.equal(plugins.needsRefresh, true);
  assert.equal((await plugins.list()).plugins[0].enabled, true); assert.equal(plugins.needsRefresh, false);
});

test("plugin CLI bounds output/time, strips credentials, rejects arbitrary argv and cancels only its own children", async t => {
  const root = await temporaryDirectory(t), launches = [];
  let script = 'process.stdout.write(JSON.stringify({installed:[],available:[]}))';
  const cli = new CodexPluginCli({ command: "fixture-codex", workspace: root, env: { HOME: root, CODEX_HOME: `${root}/codex`, PATH: process.env.PATH, OPENAI_API_KEY: "secret", AGENT_SESSION_TOKEN: "secret", CUSTOM_TOKEN: "secret" }, timeoutMs: 500, maxBytes: 400,
    spawn: (command, args, options) => { launches.push({ command, args, options }); return spawnWorker(process.execPath, ["-e", script], options); } });
  t.after(() => cli.stop());
  assert.deepEqual(await cli.run(["list", "--available", "--json"]), { installed: [], available: [] });
  assert.deepEqual(launches[0].args, ["plugin", "list", "--available", "--json"]);
  assert.equal(launches[0].options.cwd, root); assert.doesNotMatch(JSON.stringify(launches[0].options.env), /secret|TOKEN|API_KEY/);
  await assert.rejects(cli.run(["marketplace", "add", "http://evil.invalid"]), /Invalid/);
  script = 'process.stderr.write("secret native error");process.exitCode=1'; await assert.rejects(cli.run(["list", "--available", "--json"]), error => /command failed/.test(error.message) && !error.message.includes("secret"));
  script = 'process.stdout.write("x".repeat(401));setInterval(()=>{},1000)'; await assert.rejects(cli.run(["list", "--available", "--json"]), /output limit/);
  script = 'setInterval(()=>{},1000)'; await assert.rejects(cli.run(["list", "--available", "--json"]), /timed out/);
  const pending = cli.run(["list", "--available", "--json"]), rejected = assert.rejects(pending, /worker stopped/);
  await cli.stop(); await rejected; assert.equal(cli.children.size, 0);
  await assert.rejects(cli.run(["list", "--available", "--json"]), /worker stopped/);
});

async function controller(t, mutable = true) {
  const root = await temporaryDirectory(t), native = fixture({ mutable });
  let starts = 0, turns = 0;
  const app = await createAgentWebServer({ config: testConfig(root, { AGENT_WEB_AUTH_TOKEN: "plugins-fixture", AGENT_IDLE_TIMEOUT_MS: "10000" }), records: new MemoryRecords(), models: { creationSettings: async () => ({}), turnSettings: async () => ({}) },
    adapterFactory: ({ chat, hooks }) => { native.state.thread = chat.agentSessionId || `root-${chat.id}`; return { plugins: native.plugins, start: async () => { starts++; await hooks.onSessionId(native.state.thread); }, stop: async () => {}, send: async () => { turns++; return { text: "fixture" }; } }; } });
  const { url } = await app.start(); t.after(() => app.stop());
  const chat = await app.manager.createChat({ agent: "codex", title: "Plugin controller" });
  const request = (tail, body = {}) => fetch(`${url}/api/chats/${chat.id}/${tail}`, { method: "POST", headers: { authorization: "Bearer plugins-fixture", "content-type": "application/json" }, body: JSON.stringify(body) });
  const input = catalog => ({ id: "fixture@market", action: "install", threadId: catalog.threadId, revision: catalog.revision, confirm: true });
  return { app, chat, native, request, input, url, starts: () => starts, turns: () => turns };
}

test("plugin endpoints enforce origin/owner and do not send messages or turn a shared host write into a private one", async t => {
  const { app, chat, request, input, starts, turns, url } = await controller(t);
  assert.equal((await fetch(`${url}/api/chats/${chat.id}/plugins`, { method: "POST" })).status, 401);
  assert.equal((await fetch(`${url}/api/chats/${chat.id}/plugins`, { method: "POST", headers: { authorization: "Bearer plugins-fixture", origin: "https://evil.invalid" } })).status, 403);
  const catalog = await (await request("plugins")).json(); assert.equal(starts(), 1); assert.equal(turns(), 0);
  assert.equal((await request("plugins/change", input(catalog))).status, 200);
  assert.deepEqual(app.store.get(chat.id).messages, []); assert.equal(turns(), 0);
  await app.store.update(chat.id, { ownerId: "different-user" }); assert.equal((await request("plugins")).status, 404);
  const shared = await controller(t, false), readonly = await (await shared.request("plugins")).json();
  assert.equal((await shared.request("plugins/change", shared.input(readonly))).status, 409); assert.deepEqual(shared.native.state.changes, []);
});

test("plugin controller rejects changed company, owner or stopped worker while a write is being prepared", async t => {
  for (const action of ["owner", "company", "stop"]) {
    const { app, chat, native, request, input } = await controller(t), catalog = await (await request("plugins")).json();
    const entered = Promise.withResolvers(), release = Promise.withResolvers();
    native.state.before = async method => { if (method === "list") { entered.resolve(); await release.promise; } };
    const pending = request("plugins/change", input(catalog)); await entered.promise;
    if (action === "owner") await app.store.update(chat.id, { ownerId: "different-user" });
    else if (action === "company") await app.store.update(chat.id, { repositories: [{ owner: "other-org", name: "repo", fullName: "other-org/repo" }] });
    else await app.manager.stop(chat.id);
    release.resolve(); assert.equal((await pending).status, action === "owner" ? 404 : 409);
    assert.deepEqual(native.state.changes, []); assert.deepEqual(app.store.get(chat.id).messages, []);
  }
});

test("plugin changes invalidate pending command discovery without allowing old results to overwrite new skills", async () => {
  const commands = new CommandCatalog({ workerBackend: "ec2" }), first = Promise.withResolvers(); let count = 0;
  commands.discover = async () => ++count === 1 ? first.promise : { commands: [{ name: "new-skill" }] };
  const chat = { id: "chat", agent: "codex" }, pending = commands.list(chat);
  commands.invalidate(chat.id); assert.equal((await commands.list(chat)).commands[0].name, "new-skill");
  first.resolve({ commands: [{ name: "old-skill" }] }); await pending;
  assert.equal((await commands.list(chat)).commands[0].name, "new-skill");
});
