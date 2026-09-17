import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { mkdir, writeFile, readFile, symlink, link } from "node:fs/promises";
import { CLAUDE_PERMISSION_MODES, claudeConfigRequest, claudeSettingsChanges, inspectClaudeSettings, readPrivateClaudeSettings } from "../src/claude-settings.mjs";
import { ClaudeAdapter } from "../src/adapters/claude.mjs";
import { RuntimeManager } from "../src/runtime-manager.mjs";
import { ChatStore } from "../src/store.mjs";
import { ModelCatalog } from "../src/models.mjs";
import { CapabilityBroker } from "../src/capabilities.mjs";
import { spawnWorker, terminateWorker } from "../src/worker-process.mjs";
import { messageCommand } from "../src/message-command.mjs";
import { temporaryDirectory, testConfig, waitFor } from "./helpers.mjs";

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
  assert.equal(result.effort, null); assert.equal(result.environmentEffort, "auto");
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

test("reselecting the same web values is still newer than an in-flight native command", async t => {
  const f = await fixture(t, { fake: true }); f.gate = Promise.withResolvers();
  const pending = f.manager.send(f.chat.id, "/config model=sonnet permissionMode=plan"); await waitFor(() => f.calls.length === 1);
  await f.manager.setModel(f.chat.id, { model: f.chat.model, effort: f.chat.effort }); await f.manager.setMode(f.chat.id, f.chat.mode);
  f.gate.resolve(); await pending;
  assert.equal(f.store.get(f.chat.id).model, f.chat.model); assert.equal(f.store.get(f.chat.id).mode, f.chat.mode);
  assert(f.store.get(f.chat.id).messages.some(message => /newer web choices/.test(message.text)));
});
