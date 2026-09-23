import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { RuntimeManager } from "../src/runtime-manager.mjs";
import { ChatStore } from "../src/store.mjs";
import { CapabilityBroker } from "../src/capabilities.mjs";
import { CommandCatalog } from "../src/command-catalog.mjs";
import { messageCommand } from "../src/message-command.mjs";
import { webCommands } from "../public/web-commands.js";
import { temporaryDirectory, testConfig, waitFor } from "./helpers.mjs";

test("concurrent goalAction resume calls queue the literal command at most once", async t => {
  const root = await temporaryDirectory(t), store = new ChatStore(root); await store.initialize();
  const config = testConfig(root, { CODEX_BIN: fileURLToPath(new URL("./fixtures/fake-codex.mjs", import.meta.url)), AGENT_IDLE_TIMEOUT_MS: "10000" });
  const manager = new RuntimeManager({ store, config, broker: new CapabilityBroker({ ttlMs: 10000 }), commands: new CommandCatalog({ workerBackend: "ec2" }) });
  t.after(() => manager.shutdown());
  const chat = await manager.createChat({ agent: "codex", title: "Goal resume race" });
  await manager.submit(chat.id, "hold this turn open");
  await waitFor(() => manager.isBusy(chat.id) && store.get(chat.id).pendingRequest);
  const results = await Promise.allSettled([manager.goalAction(chat.id, "resume"), manager.goalAction(chat.id, "resume")]);
  const queued = store.get(chat.id).queuedMessages.filter(item => item.text === "/goal resume");
  assert.equal(queued.length, 1, "two overlapping resume calls must not double-queue the literal command");
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(results.filter(result => result.status === "rejected").length, 1);
  assert.match(results.find(result => result.status === "rejected").reason.message, /current goal action/);
  // A third, non-overlapping resume call while the item is already queued
  // must also not add a second copy.
  await manager.goalAction(chat.id, "resume");
  assert.equal(store.get(chat.id).queuedMessages.filter(item => item.text === "/goal resume").length, 1);
  await manager.stop(chat.id);
});

test("message commands preserve multiline arguments and Claude plugin goal commands", () => {
  assert.deepEqual(messageCommand("codex", "/plan test\nwith details"), { type: "plan", prompt: "test\nwith details" });
  assert.deepEqual(messageCommand("codex", "/goal build a todo app"), { type: "goal", action: "set", objective: "build a todo app", prompt: "build a todo app" });
  assert.equal(messageCommand("claude", "/goal build"), null); assert.equal(messageCommand("codex", "/goalkeeper"), null);
  assert.equal(messageCommand("codex", "/goal edit revised objective").objective, "revised objective");
  assert.throws(() => messageCommand("codex", "/goal edit"), /revised objective/);
  assert.throws(() => messageCommand("codex", `/goal ${"x".repeat(4001)}`), /4,000/);
});

test("review targets, initialization and queued settings use explicit command actions", () => {
  assert.deepEqual(messageCommand("codex", "/review"), { type: "review", target: { type: "uncommittedChanges" } });
  assert.deepEqual(messageCommand("codex", "/review --base main"), { type: "review", target: { type: "baseBranch", branch: "main" } });
  assert.deepEqual(messageCommand("codex", "/review --commit 1234abc"), { type: "review", target: { type: "commit", sha: "1234abc", title: null } });
  assert.deepEqual(messageCommand("codex", "/review inspect auth\nand tests"), { type: "review", target: { type: "custom", instructions: "inspect auth\nand tests" } });
  assert.throws(() => messageCommand("codex", "/review --base"), /branch/);
  assert.throws(() => messageCommand("codex", "/review --commit nope"), /SHA/);
  assert.equal(messageCommand("claude", "/review"), null);
  assert.match(messageCommand("codex", "/init focus on tests").prompt, /Preserve existing instructions.*\n\nAdditional instructions:\nfocus on tests/s);
  assert.deepEqual(messageCommand("codex", "/model fixture"), { type: "settings", settings: { model: "fixture" } });
  assert.deepEqual(messageCommand("claude", "/reasoning high"), { type: "settings", settings: { effort: "high" } });
  assert.deepEqual(messageCommand("codex", "/effort default"), { type: "settings", settings: { effort: null } });
  assert.deepEqual(messageCommand("codex", "/permissions read-only"), { type: "settings", settings: { mode: "plan" } });
  assert.throws(() => messageCommand("codex", "/permissions invented"), /Use \/permissions/);
});

test("Codex menu contains executable skills and real web controls, not stale terminal placeholders", async () => {
  const catalog = new CommandCatalog({ workerBackend: "ec2" });
  const { commands } = await catalog.list({ id: "fixture", agent: "codex", commandCatalog: [{ name: "vim", kind: "CLI command" }, { name: "work", kind: "Skill", path: "/fixture/work/SKILL.md" }] });
  assert.deepEqual(commands.filter(c => c.web).map(c => c.name).sort(), webCommands("codex").flatMap(c => [c.name, ...c.aliases]).sort());
  assert.equal(commands.find(c => c.name === "name").aliasFor, "rename");
  assert.equal(commands.find(c => c.name === "apps").web, true);
  assert.ok(!webCommands("claude").some(command => command.name === "apps"));
  assert.equal(commands.find(c => c.name === "plugins").web, true);
  assert.ok(!webCommands("claude").some(command => command.name === "plugins"));
  assert.equal(commands.find(c => c.name === "hooks").web, true);
  assert.ok(!webCommands("claude").some(command => command.name === "hooks"));
  assert.equal(commands.find(c => c.name === "experimental").web, true);
  assert.ok(!webCommands("claude").some(command => command.name === "experimental"));
  assert.equal(commands.find(c => c.name === "memories").web, true);
  assert.ok(!webCommands("claude").some(command => command.name === "memories"));
  assert.ok(commands.some(c => c.name === "work" && c.path)); assert.equal(commands.find(c => c.name === "vim").web, true); assert.equal(commands.find(c => c.name === "goal").web, true);
});

test("command discovery gates model-specific commands and refreshes them when the model changes", async () => {
  const catalog = new CommandCatalog({ workerBackend: "ec2" }, { selected: async chat => chat.model === "capable" ? { supportsPersonality: true, serviceTiers: [{ id: "priority", name: "Fast" }] } : {} });
  const chat = { id: "fixture", agent: "codex", model: "plain" };
  let result = await catalog.list(chat); assert.ok(!result.commands.some(command => ["personality", "fast"].includes(command.name)));
  result = await catalog.list({ ...chat, model: "capable" }); assert.ok(["personality", "fast"].every(name => result.commands.some(command => command.name === name)));
});

test("installed Claude namespaces keep same-name commands and aliases distinct from web controls", async () => {
  const catalog = new CommandCatalog({ workerBackend: "ec2" });
  const names = ["one:goal", "two:goal", "one:config", "two:plan", "one:reload-plugins"];
  const commandCatalog = names.map(name => ({ name, description: name, aliases: name === "one:goal" ? ["one:target"] : [] }));
  const { commands } = await catalog.list({ id: "plugin-fixture", agent: "claude", commandCatalog });
  for (const name of [...names, "one:target"]) {
    assert.equal(commands.find(command => command.name === name).web, false);
    assert.equal(messageCommand("claude", `/${name} Keep ação\nand the next line`), null);
  }
  assert.equal(commands.find(command => command.name === "one:target").aliasFor, "one:goal");
  assert.equal(commands.find(command => command.name === "plan").web, true);
  assert.equal(commands.find(command => command.name === "reload-plugins").kind, "SDK control");
  assert.equal(commands.find(command => command.name === "reload-plugins").web, false);
  assert.equal(commandCatalog.length, names.length, "Web/SDK controls must not mutate the worker-reported native inventory");
});

test("plan plus task uses read-only mode; goals persist and stream each native continuation separately", async t => {
  const root = await temporaryDirectory(t), store = new ChatStore(root); await store.initialize();
  const config = testConfig(root, { CODEX_BIN: fileURLToPath(new URL("./fixtures/fake-codex.mjs", import.meta.url)), AGENT_IDLE_TIMEOUT_MS: "10000" });
  const manager = new RuntimeManager({ store, config, broker: new CapabilityBroker({ ttlMs: 10000 }), commands: new CommandCatalog({ workerBackend: "ec2" }) });
  t.after(() => manager.shutdown()); const chat = await manager.createChat({ agent: "codex", title: "Commands" });
  const accept = event => { if (event.type === "request") void manager.respond(chat.id, event.request.requestId, { decision: "accept" }); };
  manager.on("event", accept);
  t.after(() => manager.off("event", accept));
  await manager.send(chat.id, "/plan testing"); assert.equal(store.get(chat.id).mode, "plan");
  assert.equal(store.get(chat.id).messages[0].text, "/plan testing"); assert.ok(!store.get(chat.id).messages.some(m => m.kind === "error"));
  await manager.send(chat.id, "/goal plan a todo app"); assert.equal(store.get(chat.id).goal.status, "paused");
  await manager.setMode(chat.id, "accept_edits"); await manager.send(chat.id, "/goal create a todo app");
  assert.equal(store.get(chat.id).goal.status, "complete");
  assert.equal(store.get(chat.id).messages.filter(m => m.role === "assistant").at(-1).text, "Goal verified complete");
  await manager.send(chat.id, "/review --base main");
  assert.equal(store.get(chat.id).messages.filter(m => m.role === "assistant").at(-1).text, "Native review completed without a normal prompt.");
  const beforeInspection = store.get(chat.id).messages.length;
  const terminals = await manager.inspectCommand(chat.id, "ps");
  assert.equal(terminals.awake, true); assert.equal(terminals.items.length, 2); assert.ok(!JSON.stringify(terminals).includes("fixture-secret"));
  await assert.rejects(manager.inspectCommand(chat.id, "ps", "foreign-process"), /no longer tracked/);
  assert.deepEqual((await manager.inspectCommand(chat.id, "ps", "100")).items.map(item => item.id), ["200"]);
  assert.deepEqual((await manager.inspectCommand(chat.id, "ps", "all")).items, []);
  const configInfo = await manager.inspectCommand(chat.id, "debug-config");
  assert.equal(configInfo.items.find(item => item.id === "model").detail, "user");
  assert.ok(!JSON.stringify(configInfo).includes("never-expose"));
  assert.equal(store.get(chat.id).messages.length, beforeInspection, "Inspections must not inject messages or agent turns");
  await manager.send(chat.id, "/permissions read-only"); assert.equal(store.get(chat.id).mode, "plan");
  assert.ok(!store.get(chat.id).messages.some(m => m.kind === "error"));
  await manager.goalAction(chat.id, "clear"); assert.equal(store.get(chat.id).goal, null);
  await waitFor(() => !manager.isBusy(chat.id));
  await manager.stop(chat.id);
  assert.equal((await manager.inspectCommand(chat.id, "ps")).awake, false);
  await assert.rejects(manager.inspectCommand(chat.id, "ps", "100"), /worker is stopped/);
  await assert.rejects(manager.inspectCommand(chat.id, "account/logout"), /Unknown/);
  assert.equal(store.get(chat.id).status, "stopped");
});
