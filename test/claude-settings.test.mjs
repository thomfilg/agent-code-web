import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { mkdir, writeFile, readFile, symlink, link } from "node:fs/promises";
import { CLAUDE_PERMISSION_MODES, claudeConfigRequest, claudeSettingsChanges, inspectClaudeSettings, readPrivateClaudeSettings, claudePermissionMode } from "../src/claude-settings.mjs";
import { ClaudeAdapter } from "../src/adapters/claude.mjs";
import { RuntimeManager } from "../src/runtime-manager.mjs";
import { ChatStore } from "../src/store.mjs";
import { ModelCatalog } from "../src/models.mjs";
import { CapabilityBroker } from "../src/capabilities.mjs";
import { spawnWorker, terminateWorker } from "../src/worker-process.mjs";
import { messageCommand } from "../src/message-command.mjs";
import { temporaryDirectory, testConfig, waitFor } from "./helpers.mjs";

test("permission mode comes only from an allowlisted main-session native status, never prose or a child", () => {
  const event = { type: "system", subtype: "status", status: null, permissionMode: "plan", session_id: "native-session" };
  for (const [native, mode] of Object.entries(CLAUDE_PERMISSION_MODES)) assert.equal(claudePermissionMode({ ...event, permissionMode: native }, "native-session"), mode);
  for (const invalid of [null, {}, { ...event, type: "assistant" }, { ...event, subtype: "init" }, { ...event, session_id: "different" },
    { ...event, parent_tool_use_id: "child" }, ...["bypassPermissions", "__proto__", "toString", null, { toString: "not callable" }].map(permissionMode => ({ ...event, permissionMode }))]) {
    assert.equal(claudePermissionMode(invalid, "native-session"), null);
  }
  assert.equal(claudePermissionMode({ ...event, session_id: undefined }, undefined), null);
});

test("config parsing leaves native text intact and only reconciles applied or explicitly confirmed values", () => {
  assert.equal(claudeConfigRequest("Explain /config"), null);
  assert.deepEqual(claudeConfigRequest("/settings --help"), { mutate: false, values: {} });
  assert.deepEqual(claudeConfigRequest('/config model="sonnet" language="pt BR" permissionMode=plan'), { mutate: true, values: { model: "sonnet", permissionMode: "plan" } });
  assert.deepEqual(claudeConfigRequest('/config model="sonnet'), { mutate: true, values: {} });
  const before = { model: "opus", permissionMode: "default" }, after = { model: "sonnet", permissionMode: "default" };
  assert.deepEqual(claudeSettingsChanges(before, after, claudeConfigRequest("/config model=sonnet madeUp=wrong")), { model: "sonnet" });
  assert.deepEqual(claudeSettingsChanges(after, after, claudeConfigRequest("/settings model=sonnet")), { model: "sonnet" });
  assert.deepEqual(claudeSettingsChanges(after, after, claudeConfigRequest("/config model=invalid")), {});
  assert.deepEqual(messageCommand("claude", "/settings model=sonnet"), { type: "claudeConfig", prompt: "/settings model=sonnet" });
  assert.equal(messageCommand("claude", "/effort status"), null);
  assert.deepEqual(messageCommand("claude", "/effort auto"), { type: "settings", settings: { effort: "auto" } });
  assert.deepEqual(messageCommand("claude", "/model default"), { type: "settings", settings: { model: "default" } });
  assert.deepEqual(messageCommand("codex", "/model default"), { type: "settings", settings: { model: null } });
});

test("private settings reader exposes only model and default mode, locally and through the owning executor", async t => {
  const root = await temporaryDirectory(t);
  assert.deepEqual(await readPrivateClaudeSettings(root), { model: "default", permissionMode: "default" });
  await mkdir(path.join(root, "claude"));
  await writeFile(path.join(root, "claude/settings.json"), JSON.stringify({ model: "sonnet[1m]", permissions: { defaultMode: "dontAsk", allow: ["Private rule"] }, env: { SECRET: "never-return" }, hooks: { prompt: "private" } }));
  const expected = { model: "sonnet[1m]", permissionMode: "dontAsk" };
  assert.deepEqual(await readPrivateClaudeSettings(root), expected);
  const calls = [], executor = { metadata: { backend: "ec2" }, spawn(command, args, options) { calls.push({ command, args, options }); return spawnWorker(command, args, options); } };
  assert.deepEqual(await inspectClaudeSettings({ runtimeHome: root, executor }), expected);
  assert.equal(calls.length, 1); assert.equal(calls[0].options.cwd, root);
  assert.deepEqual(Object.keys(calls[0].options.env).sort(), ["HOME", "LANG", "PATH"]);
  assert.doesNotMatch(JSON.stringify(calls), /never-return|Private rule/);
});

test("linked profiles, linked files, hardlinks, oversized and malformed files fail closed", async t => {
  const root = await temporaryDirectory(t), secret = path.join(root, "outside.json");
  await writeFile(secret, JSON.stringify({ model: "secret-model" }));
  for (const kind of ["symlink", "hardlink", "oversized", "malformed", "array", "mode", "profile"]) {
    const home = path.join(root, kind); await mkdir(home); const profile = path.join(home, "claude"), file = path.join(profile, "settings.json");
    if (kind === "profile") await symlink(root, profile); else await mkdir(profile);
    if (kind === "symlink") await symlink(secret, file);
    if (kind === "hardlink") await link(secret, file);
    if (kind === "oversized") await writeFile(file, " ".repeat(2 * 1024 * 1024 + 1));
    if (kind === "malformed") await writeFile(file, "not json");
    if (kind === "array") await writeFile(file, "[]");
    if (kind === "mode") await writeFile(file, '{"permissions":{"defaultMode":"bypassPermissions"}}');
    await assert.rejects(readPrivateClaudeSettings(home), undefined, kind);
  }
  assert.equal(JSON.parse(await readFile(secret, "utf8")).model, "secret-model");
});

test("remote inspection is abortable and rejects oversized or invalid responses without returning their data", async t => {
  const root = await temporaryDirectory(t); const children = [];
  t.after(() => Promise.all(children.map(child => terminateWorker(child))));
  const executor = script => ({ metadata: { backend: "ec2" }, spawn() { const child = spawnWorker(process.execPath, ["-e", script]); children.push(child); return child; } });
  const controller = new AbortController();
  const pending = inspectClaudeSettings({ runtimeHome: root, executor: executor("setInterval(() => {}, 1000)"), signal: controller.signal });
  const rejected = assert.rejects(pending, /interrupted/); controller.abort(); await rejected;
  await assert.rejects(inspectClaudeSettings({ runtimeHome: root, executor: executor('process.stdout.write("secret".repeat(900))') }), /interrupted/);
  await assert.rejects(inspectClaudeSettings({ runtimeHome: root, executor: executor('process.stdout.write(JSON.stringify({model:"opus",permissionMode:"__proto__"}))') }), /Invalid/);
});

async function fixture(t, { fake = false, host = false } = {}) {
  const root = await temporaryDirectory(t), store = new ChatStore(root); await store.initialize();
  const config = testConfig(root, { AGENT_IDLE_TIMEOUT_MS: "60000", CLAUDE_BIN: path.resolve("test/fixtures/fake-claude.mjs"), ...(host ? { CLAUDE_AUTH_MODE: "host" } : {}) });
  const models = new ModelCatalog(config);
  models.claude = async () => ({ models: ["opus", "sonnet", "haiku", "default"].map(id => ({ id, efforts: id === "haiku" ? ["auto"] : ["auto", "high", "low"] })) });
  models.codex = async () => ({ models: [{ id: "gpt-5.6-sol", efforts: ["high"] }] });
  const broker = new CapabilityBroker({ ttlMs: 120000 }), calls = [];
  const f = { calls, starts: 0 };
  const manager = new RuntimeManager({ store, config, models, broker, gatewayOrigin: "http://127.0.0.1:9", adapterFactory: params => {
    if (!fake) return new ClaudeAdapter({ ...params, store, config, broker, gatewayOrigin: "http://127.0.0.1:9" });
    return { start: async () => { f.starts++; }, send: async (text, settings) => { calls.push({ text, settings }); await f.gate?.promise; return { text: "Native fixture response", nativeSettings: text.startsWith("/config") ? { model: "sonnet", mode: "plan" } : undefined }; }, stop: async () => f.gate?.resolve() };
  } });
  t.after(() => manager.shutdown());
  const chat = await manager.createChat({ agent: "claude", title: "Private configuration test" });
  return Object.assign(f, { root, store, config, models, broker, manager, chat });
}

test("native modes update immediately and between replies, persist through Stop, and drive the next queued turn", async t => {
  const f = await fixture(t, { fake: true }), other = await f.manager.createChat({ agent: "claude", title: "Other native session" });
  f.gate = Promise.withResolvers();
  const running = f.manager.send(f.chat.id, "Plan the change"); await waitFor(() => f.calls.length === 1);
  const report = f.calls[0].settings.onPermissionMode;
  await report("plan"); assert.equal(f.store.get(f.chat.id).mode, "plan");
  const revision = f.store.get(f.chat.id).modeSettingsRevision, chatRevision = f.store.get(f.chat.id).revision;
  await report("plan"); assert.equal(f.store.get(f.chat.id).modeSettingsRevision, revision, "Duplicate SDK status is not a new selection");
  assert.equal(f.store.get(f.chat.id).revision, chatRevision, "Unchanged native status must not rewrite the stored conversation");
  await report("accept_edits"); assert.equal(f.store.get(f.chat.id).mode, "accept_edits");
  await f.manager.enqueue(f.chat.id, "Continue after approval");
  f.gate.resolve(); await running; await waitFor(() => f.calls.length === 2 && !f.manager.isBusy(f.chat.id));
  assert.equal(f.calls[1].settings.mode, "accept_edits");
  await report("plan"); assert.equal(f.store.get(f.chat.id).mode, "accept_edits", "An older turn cannot publish into a newer one");
  await f.calls[1].settings.onPermissionMode("default");
  assert.equal(f.store.get(f.chat.id).mode, "default", "A retained session can change mode between replies");
  assert.equal(f.store.get(other.id).mode, other.mode);
  await f.manager.stop(f.chat.id);
  await f.calls[1].settings.onPermissionMode("plan"); assert.equal(f.store.get(f.chat.id).mode, "default");
  const restored = new ChatStore(f.root); await restored.initialize(); assert.equal(restored.get(f.chat.id).mode, "default");
  assert(!f.store.get(f.chat.id).messages.some(message => message.kind === "notice"));
});

test("newer web choices, including the same mode, beat live native transitions without repeated notices", async t => {
  for (const selection of ["dont_ask", "plan"]) {
    const f = await fixture(t, { fake: true }); f.gate = Promise.withResolvers();
    const running = f.manager.send(f.chat.id, "Plan the change"); await waitFor(() => f.calls.length === 1);
    const report = f.calls[0].settings.onPermissionMode; await report("plan");
    await f.manager.setMode(f.chat.id, selection); const revision = f.store.get(f.chat.id).modeSettingsRevision;
    await report("accept_edits"); await report("default");
    assert.equal(f.store.get(f.chat.id).mode, selection); assert.equal(f.store.get(f.chat.id).modeSettingsRevision, revision);
    assert.equal(f.store.get(f.chat.id).messages.filter(message => message.kind === "notice" && /newer web selection/.test(message.text)).length, 1);
    f.gate.resolve(); await running;
    await f.manager.send(f.chat.id, "Use my selection"); assert.equal(f.calls[1].settings.mode, selection);
  }
});

test("live native changes and config readback are serialized without confusing our updates with user choices", async t => {
  const f = await fixture(t, { fake: true }); f.gate = Promise.withResolvers();
  const running = f.manager.send(f.chat.id, "/config model=sonnet permissionMode=plan"); await waitFor(() => f.calls.length === 1);
  const report = f.calls[0].settings.onPermissionMode;
  await report("plan"); f.gate.resolve(); await running;
  assert.equal(f.store.get(f.chat.id).mode, "plan"); assert.equal(f.store.get(f.chat.id).model, "sonnet");
  await report("accept_edits"); assert.equal(f.store.get(f.chat.id).mode, "accept_edits");
  assert(!f.store.get(f.chat.id).messages.some(message => message.kind === "notice"));
});

test("Stop, ownership and company changes reject stale native mode callbacks", async t => {
  for (const action of ["stop", "owner", "company"]) {
    const f = await fixture(t, { fake: true }); f.gate = Promise.withResolvers();
    const running = f.manager.send(f.chat.id, "Keep this task running"); await waitFor(() => f.calls.length === 1);
    if (action === "stop") await f.manager.stop(f.chat.id);
    else await f.store.update(f.chat.id, action === "owner" ? { ownerId: "different-owner" } : { repositories: [{ fullName: "other-company/project" }] });
    await f.calls[0].settings.onPermissionMode("plan"); f.gate.resolve(); await running;
    assert.equal(f.store.get(f.chat.id).mode, f.chat.mode);
    assert(!f.store.get(f.chat.id).messages.some(message => /newer web selection/.test(message.text)));
  }
});

test("native saved settings reach following turns and survive Stop without changing other chats", async t => {
  const f = await fixture(t), other = await f.manager.createChat({ agent: "claude", title: "Other company" });
  await f.manager.send(f.chat.id, "/config model=sonnet permissionMode=plan");
  assert.equal(f.store.get(f.chat.id).model, "sonnet"); assert.equal(f.store.get(f.chat.id).mode, "plan");
  assert.equal(f.store.get(other.id).model, "opus"); assert.equal(f.store.get(other.id).mode, other.mode);
  const session = f.store.get(f.chat.id).agentSessionId;
  await f.manager.stop(f.chat.id);
  const restored = new ChatStore(f.root); await restored.initialize(); assert.equal(restored.get(f.chat.id).model, "sonnet");
  await f.manager.send(f.chat.id, "inspect-settings");
  const result = JSON.parse(f.store.get(f.chat.id).messages.filter(message => message.role === "assistant").at(-1).text);
  assert.equal(result.model, "sonnet"); assert.equal(result.mode, "plan"); assert.equal(f.store.get(f.chat.id).agentSessionId, session);
  for (const [native, mode] of Object.entries(CLAUDE_PERMISSION_MODES)) {
    await f.manager.send(f.chat.id, `/config permissionMode=${native}`); assert.equal(f.store.get(f.chat.id).mode, mode);
    await f.manager.send(f.chat.id, "inspect-settings");
    assert.equal(JSON.parse(f.store.get(f.chat.id).messages.at(-1).text).mode, native);
  }
});

test("partial native failures keep applied values, invalid assignments keep web choices, and Auto clears sticky effort", async t => {
  const f = await fixture(t);
  await f.manager.send(f.chat.id, "/config model=sonnet failAfterWrite=true");
  assert.equal(f.store.get(f.chat.id).model, "sonnet");
  assert(f.store.get(f.chat.id).messages.some(message => message.kind === "error" && /failed after writing/.test(message.text)));
  await f.manager.setModel(f.chat.id, { model: "opus", effort: "high" });
  await f.manager.send(f.chat.id, "/config model=invalid"); assert.equal(f.store.get(f.chat.id).model, "opus");
  await f.manager.send(f.chat.id, "/settings model=sonnet"); assert.equal(f.store.get(f.chat.id).model, "sonnet", "Explicit same native value must override the older web selection");
  await f.manager.send(f.chat.id, "/settings model=haiku madeUp=wrong");
  assert.equal(f.store.get(f.chat.id).model, "haiku"); assert.equal(f.store.get(f.chat.id).effort, "auto");
  await f.manager.send(f.chat.id, "/effort auto");
  await f.manager.send(f.chat.id, "inspect-settings");
  const result = JSON.parse(f.store.get(f.chat.id).messages.at(-1).text);
  assert.equal(result.effort, null); assert.equal(result.environmentEffort, null); assert.equal(result.sdkEffortReset, true);
});

test("busy config commands use FIFO and newer web choices win over a late native response", async t => {
  const f = await fixture(t, { fake: true }); f.gate = Promise.withResolvers();
  const running = f.manager.send(f.chat.id, "Current task"); await waitFor(() => f.calls.length === 1);
  await f.manager.enqueue(f.chat.id, "/config model=sonnet permissionMode=plan"); await f.manager.enqueue(f.chat.id, "Next task");
  assert.equal(f.store.get(f.chat.id).model, "opus"); f.gate.resolve(); await running;
  await waitFor(() => f.calls.length === 3 && !f.manager.isBusy(f.chat.id));
  assert.equal(f.calls[2].settings.model, "sonnet"); assert.equal(f.calls[2].settings.mode, "plan");
  f.gate = Promise.withResolvers(); const pending = f.manager.send(f.chat.id, "/config model=sonnet permissionMode=plan"); await waitFor(() => f.calls.length === 4);
  await f.manager.setModel(f.chat.id, { model: "haiku", effort: "auto" }); await f.manager.setMode(f.chat.id, "dont_ask");
  f.gate.resolve(); await pending;
  assert.equal(f.store.get(f.chat.id).model, "haiku"); assert.equal(f.store.get(f.chat.id).mode, "dont_ask");
  assert(f.store.get(f.chat.id).messages.some(message => message.kind === "notice" && /newer web choices/.test(message.text)));
});

test("Stop and ownership changes cannot publish a late native settings update", async t => {
  for (const action of ["stop", "owner"]) {
    const f = await fixture(t, { fake: true }); f.gate = Promise.withResolvers();
    const pending = f.manager.send(f.chat.id, "/config model=sonnet permissionMode=plan"); await waitFor(() => f.calls.length === 1);
    if (action === "stop") await f.manager.stop(f.chat.id); else await f.store.update(f.chat.id, { ownerId: "different-owner" });
    f.gate.resolve(); await pending;
    assert.equal(f.store.get(f.chat.id).model, "opus"); assert.equal(f.store.get(f.chat.id).mode, f.chat.mode);
  }
});

test("config controls reject attachments and shared-host mutation before accepting or queueing a message", async t => {
  const f = await fixture(t, { fake: true }), host = await fixture(t, { fake: true, host: true });
  for (const manager of [f.manager, host.manager]) {
    const chat = manager === f.manager ? f.chat : host.chat;
    await assert.rejects(manager.submit(chat.id, "/config model=sonnet", ["file"]), /do not accept attachments/);
    await assert.rejects(manager.enqueue(chat.id, "/settings model=sonnet", ["file"]), /do not accept attachments/);
    await assert.rejects(manager.enqueue(chat.id, "/effort status", ["file"]), /does not accept attachments/);
  }
  await assert.rejects(host.manager.submit(host.chat.id, "/config model=sonnet"), /shared host profile/);
  await assert.rejects(host.manager.enqueue(host.chat.id, "/settings permissionMode=auto"), /shared host profile/);
  assert.equal(host.starts, 0); assert.equal(host.store.get(host.chat.id).messages.length, 0);
  await host.manager.send(host.chat.id, "/config --help"); assert.equal(host.calls[0].text, "/config --help");
});

test("Claude-only permission modes are rejected for Codex and switching back defaults safely to Plan", async t => {
  const f = await fixture(t, { fake: true }); await f.manager.setMode(f.chat.id, "dont_ask");
  const chat = await f.manager.switchAgent(f.chat.id, "codex"); assert.equal(chat.mode, "plan");
  await assert.rejects(f.manager.setMode(chat.id, "dont_ask"), /supported by this agent/);
  await assert.rejects(f.models.validate("codex", { model: "gpt-5.6-sol", effort: "auto" }), /not supported/);
});

test("plugin reload rejects attachments, invalid arguments and shared-host changes before accepting or queueing", async t => {
  const f = await fixture(t, { fake: true }), host = await fixture(t, { fake: true, host: true });
  for (const candidate of [f, host]) {
    for (const method of ["submit", "enqueue"]) {
      await assert.rejects(candidate.manager[method](candidate.chat.id, "/reload-plugins", ["file"]), /does not accept attachments/);
      await assert.rejects(candidate.manager[method](candidate.chat.id, "/reload-plugins --invented"), /Use \/reload-plugins/);
    }
  }
  await assert.rejects(host.manager.submit(host.chat.id, "/reload-plugins"), /private Claude profile/);
  await assert.rejects(host.manager.enqueue(host.chat.id, "/reload-plugins --force"), /private Claude profile/);
  for (const candidate of [f, host]) { assert.equal(candidate.starts, 0); assert.equal(candidate.store.get(candidate.chat.id).messages.length, 0); }
});

test("reselecting the same web values is still newer than an in-flight native command", async t => {
  const f = await fixture(t, { fake: true }); f.gate = Promise.withResolvers();
  const pending = f.manager.send(f.chat.id, "/config model=sonnet permissionMode=plan"); await waitFor(() => f.calls.length === 1);
  await f.manager.setModel(f.chat.id, { model: f.chat.model, effort: f.chat.effort }); await f.manager.setMode(f.chat.id, f.chat.mode);
  f.gate.resolve(); await pending;
  assert.equal(f.store.get(f.chat.id).model, f.chat.model); assert.equal(f.store.get(f.chat.id).mode, f.chat.mode);
  assert(f.store.get(f.chat.id).messages.some(message => /newer web choices/.test(message.text)));
});

test("auto-compaction is a native private-profile command, not an inferred model prompt or attachment target", async t => {
  assert.deepEqual(claudeConfigRequest("/autocompact"), { mutate: false, values: {} });
  assert.deepEqual(claudeConfigRequest("/autocompact 100k"), { mutate: true, values: {} });
  assert.deepEqual(messageCommand("claude", "/autocompact auto"), { type: "claudeConfig", prompt: "/autocompact auto" });
  assert.equal(messageCommand("codex", "/autocompact 100k"), null);
  const f = await fixture(t, { fake: true }), host = await fixture(t, { fake: true, host: true });
  for (const text of ["/autocompact", "/autocompact 100k", "/autocompact auto"]) {
    await assert.rejects(f.manager.submit(f.chat.id, text, ["file"]), /does not accept attachments/);
    await assert.rejects(f.manager.enqueue(f.chat.id, text, ["file"]), /does not accept attachments/);
  }
  for (const text of ["/autocompact 100k", "/autocompact auto"]) {
    await assert.rejects(host.manager.submit(host.chat.id, text), /shared host profile/);
    await assert.rejects(host.manager.enqueue(host.chat.id, text), /shared host profile/);
  }
  assert.equal(f.starts, 0); assert.equal(host.starts, 0);
  assert.equal(f.store.get(f.chat.id).messages.length, 0); assert.equal(host.store.get(host.chat.id).messages.length, 0);
  await host.manager.send(host.chat.id, "/autocompact"); assert.equal(host.calls[0].text, "/autocompact");
  const adapter = new ClaudeAdapter({ chat: host.chat, store: host.store, config: host.config, broker: host.broker, hooks: {} });
  await assert.rejects(adapter.send("/autocompact 100k"), /shared host profile/); assert.equal(adapter.child, null);
});

test("native auto-compaction windows persist, preserve disabled state and unrelated choices, and reset without touching other chats", async t => {
  const f = await fixture(t), sibling = await f.manager.createChat({ agent: "claude", title: "Sibling auto-compact" });
  const saved = () => readFile(path.join(f.store.runtimeHome(f.chat.id), "claude/settings.json"), "utf8").then(JSON.parse);
  await f.manager.send(f.chat.id, "/config autoCompact=false");
  await f.manager.send(f.chat.id, "/autocompact 100k");
  assert.equal((await saved()).autoCompactWindow, 100000); assert.equal((await saved()).autoCompactEnabled, false);
  assert.equal(f.store.get(f.chat.id).model, f.chat.model); assert.equal(f.store.get(f.chat.id).mode, f.chat.mode);
  const session = f.store.get(f.chat.id).agentSessionId; await f.manager.stop(f.chat.id); await f.manager.send(f.chat.id, "/autocompact");
  assert.equal(f.store.get(f.chat.id).agentSessionId, session); assert.match(f.store.get(f.chat.id).messages.at(-1).text, /100000/);
  await f.manager.send(f.chat.id, "/autocompact 99k"); assert.match(f.store.get(f.chat.id).messages.at(-1).text, /Couldn't parse/); assert.equal((await saved()).autoCompactWindow, 100000);
  await f.manager.send(f.chat.id, "/autocompact auto"); assert.equal((await saved()).autoCompactWindow, undefined); assert.equal((await saved()).autoCompactEnabled, false);
  await assert.rejects(readFile(path.join(f.store.runtimeHome(sibling.id), "claude/settings.json")), { code: "ENOENT" });
});

test("queued auto-compaction stays in FIFO order and cannot overwrite a linked profile file", async t => {
  const f = await fixture(t, { fake: true }); f.gate = Promise.withResolvers();
  const pending = f.manager.send(f.chat.id, "Active task"); await waitFor(() => f.calls.length === 1);
  await f.manager.enqueue(f.chat.id, "/autocompact 200k"); await f.manager.enqueue(f.chat.id, "Later task");
  f.gate.resolve(); await pending; await waitFor(() => f.calls.length === 3 && !f.manager.isBusy(f.chat.id));
  assert.deepEqual(f.calls.map(call => call.text), ["Active task", "/autocompact 200k", "Later task"]);
  const linked = await fixture(t), directory = path.join(linked.store.runtimeHome(linked.chat.id), "claude"), target = path.join(linked.root, "outside-settings.json");
  await mkdir(directory); await writeFile(target, '{"autoCompactWindow":300000}'); await symlink(target, path.join(directory, "settings.json"));
  await linked.manager.send(linked.chat.id, "/autocompact 100k");
  assert.equal(await readFile(target, "utf8"), '{"autoCompactWindow":300000}');
  assert(linked.store.get(linked.chat.id).messages.some(message => message.kind === "error" && /safely verify/.test(message.text)));
});
