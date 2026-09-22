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

test("message commands preserve multiline arguments and Claude plugin goal commands", () => {
  assert.deepEqual(messageCommand("codex", "/plan test\nwith details"), { type: "plan", prompt: "test\nwith details" });
  assert.deepEqual(messageCommand("codex", "/goal build a todo app"), { type: "goal", action: "set", objective: "build a todo app", prompt: "build a todo app" });
  assert.deepEqual(messageCommand("claude", "/goal build"), { type: "goal", action: "set", objective: "build", prompt: "/goal build", nativeClaude: true }); assert.equal(messageCommand("codex", "/goalkeeper"), null);
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

test("Google and named-account command discovery cannot inherit host CLI profiles", async t => {
  const root = await temporaryDirectory(t), store = new ChatStore(root); await store.initialize();
  const chat = await store.create({ title: "Private commands", agent: "codex", agentAccountId: "chosen-account" });
  const catalog = new CommandCatalog({ google: { enabled: true }, codex: { authMode: "host" }, claude: { authMode: "host" } });
  for (const provider of ["codex", "claude"]) {
    const env = await catalog.env(provider, chat);
    assert.notEqual(env.HOME, process.env.HOME);
    assert.equal(env[provider === "codex" ? "CODEX_HOME" : "CLAUDE_CONFIG_DIR"], `${store.runtimeHome(chat.id)}/${provider}`);
  }
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

test("configured plugin aliases repair incomplete worker catalogs without hiding web controls", async () => {
  const catalog = new CommandCatalog({ workerBackend: "ec2" }, null, { installed: async () => [
    { name: "work-workflow:brief", aliases: ["brief"], description: "Create a brief" },
    { name: "work-workflow:spec", aliases: ["spec"], description: "Create a spec" },
    { name: "synapsys:status", aliases: ["status"], description: "Workflow status" },
  ] });
  const chat = { id: "configured-plugin-fixture", agent: "claude", commandCatalogRevision: 1, commandCatalog: [
    { name: "goal", kind: "CLI command" },
    { name: "work-workflow:brief", kind: "CLI command", aliases: [] },
    { name: "work-workflow:spec", kind: "CLI command", aliases: ["spec"] },
    { name: "synapsys:status", kind: "CLI command", aliases: [] },
  ] };
  const { commands } = await catalog.list(chat);
  assert.equal(commands.find(command => command.name === "brief").aliasFor, "work-workflow:brief");
  assert.equal(commands.find(command => command.name === "spec").aliasFor, "work-workflow:spec");
  assert.equal(commands.find(command => command.name === "status").web, true);
  assert.equal(commands.find(command => command.name === "status").nativeCommand, "synapsys:status");
  assert(commands.some(command => command.name === "goal" && !command.web));
});

test("every admitted Claude slash name executes canonically and every unknown name stops before the agent", async t => {
  const root = await temporaryDirectory(t), store = new ChatStore(root); await store.initialize();
  const calls = [], commands = { list: async () => ({ commands: [
    { name: "cu", aliasFor: "fixture:cu", kind: "CLI command", web: false },
    { name: "piroca", kind: "CLI command", web: false },
    { name: "foda-se", aliasFor: "fixture:foda-se", kind: "CLI command", web: false },
    { name: "status", kind: "Web control", web: true, nativeCommand: "fixture:status" },
  ] }) };
  const manager = new RuntimeManager({ store, config: testConfig(root), commands, broker: new CapabilityBroker({ ttlMs: 10000 }), adapterFactory: () => ({
    start: async () => {}, stop: async () => {}, send: async text => { calls.push(text); return { text: "Command completed" }; },
  }) });
  t.after(() => manager.shutdown());
  const chat = await manager.createChat({ agent: "claude", title: "Generic slash admission" });
  for (const text of ["/cu ação\nand the next line", "/piroca exact", "/foda-se agora", "/status detailed"]) await manager.send(chat.id, text);
  assert.deepEqual(calls, [
    "/cu ação\nand the next line",
    "/piroca exact",
    "/foda-se agora",
    "/status detailed",
  ], "Claude receives the exact admitted command, alias and arguments");
  assert.deepEqual(store.get(chat.id).messages.filter(message => message.role === "user").map(message => message.text), [
    "/cu ação\nand the next line", "/piroca exact", "/foda-se agora", "/status detailed",
  ], "The transcript preserves exactly what the user typed");
  const before = store.get(chat.id).messages.length;
  await assert.rejects(manager.submit(chat.id, "/inferno qualquer coisa"), error => error.statusCode === 400 && /Unknown command \/inferno/.test(error.message));
  await assert.rejects(manager.enqueue(chat.id, "/nao-existe depois"), error => error.statusCode === 400 && /Unknown command \/nao-existe/.test(error.message));
  assert.equal(calls.length, 4);
  assert.equal(store.get(chat.id).messages.length, before);
  assert.deepEqual(store.get(chat.id).queuedMessages || [], []);
});

test("Claude /goal is visible as active before its exact native command finishes", async t => {
  const root = await temporaryDirectory(t), store = new ChatStore(root); await store.initialize();
  const gate = Promise.withResolvers(), calls = []; let scheduled = true;
  const manager = new RuntimeManager({ store, config: testConfig(root), commands: { list: async () => ({ commands: [{ name: "goal", kind: "CLI command", web: false }] }) },
    broker: new CapabilityBroker({ ttlMs: 10000 }), adapterFactory: () => ({
      start: async () => {}, stop: async () => {}, hasScheduledWork: () => scheduled,
      send: async text => { calls.push(text); await gate.promise; return { text: "Goal work scheduled" }; },
    }) });
  t.after(() => manager.shutdown());
  const chat = await manager.createChat({ agent: "claude", title: "Claude goal state" });
  const exact = "/goal INC-9670\n\nrun /brief then /spec and finish";
  const pending = manager.send(chat.id, exact); await waitFor(() => calls.length === 1);
  assert.deepEqual(calls, [exact], "Relay must not rewrite Claude's installed /goal command");
  assert.equal(store.get(chat.id).goal.status, "active");
  assert.equal(store.get(chat.id).goal.objective, "INC-9670\n\nrun /brief then /spec and finish");
  assert.equal(store.get(chat.id).messages.filter(message => message.kind === "notice").at(-1).text,
    "Goal set: INC-9670\n\nrun /brief then /spec and finish");
  gate.resolve(); await pending;
  assert.equal(store.get(chat.id).goal.status, "active", "A scheduled native continuation must not look complete");
  scheduled = false; await manager.send(chat.id, "/goal clear");
  assert.equal(store.get(chat.id).goal, null);
});

test("Claude /goal resumes internally when native ScheduleWakeup cannot retain the continuation", async t => {
  const root = await temporaryDirectory(t), store = new ChatStore(root); await store.initialize();
  const calls = [], finalTurn = Promise.withResolvers();
  const manager = new RuntimeManager({ store, config: testConfig(root), commands: { list: async () => ({ commands: [{ name: "goal", kind: "CLI command", web: false }] }) },
    broker: new CapabilityBroker({ ttlMs: 10000 }), adapterFactory: ({ hooks }) => ({
      start: async () => {}, stop: async () => {}, hasScheduledWork: () => false, isBackgroundBusy: () => false,
      send: async text => {
        calls.push(text);
        if (calls.length === 1) await hooks.onEvent({ type: "tool", tool: "ScheduleWakeup", itemId: "wake-1", title: "ScheduleWakeup", state: "running", output: "" });
        if (calls.length === 3) await finalTurn.promise;
        return { text: calls.length === 1 ? "Waiting for the server" : calls.length === 2 ? "More work remains" : "Goal finished\n<relay-goal>complete</relay-goal>" };
      },
    }) });
  t.after(() => manager.shutdown());
  const exact = "/goal INC-9670\n\nrun /brief then /spec and finish";
  const chat = await manager.createChat({ agent: "claude", title: "Claude goal wake fallback" });
  await manager.send(chat.id, exact);
  await waitFor(() => calls.length === 3);
  assert.equal(store.get(chat.id).goal.status, "active", "A progress response without explicit completion must continue the goal");
  finalTurn.resolve(); await waitFor(() => !manager.isBusy(chat.id));
  assert.deepEqual(calls, [exact, "/goal resume", "/goal resume"]);
  assert.equal(store.get(chat.id).goal.status, "complete");
  assert.deepEqual(store.get(chat.id).messages.filter(message => message.role === "user").map(message => message.text), [exact], "Relay continuation is not attributed to the user");
  assert.equal(store.get(chat.id).messages.some(message => message.meta?.source === "relay-goal" && message.meta.input === "/goal resume"), true);
  assert.deepEqual(store.get(chat.id).queuedMessages, []);
});

test("Claude retains identical system instructions when a paused Relay goal receives ordinary input", async t => {
  const root = await temporaryDirectory(t), store = new ChatStore(root); await store.initialize();
  const settings = [];
  const manager = new RuntimeManager({ store, config: testConfig(root), commands: { list: async () => ({ commands: [{ name: "goal", kind: "CLI command", web: false }] }) },
    broker: new CapabilityBroker({ ttlMs: 10000 }), adapterFactory: () => ({
      start: async () => {}, stop: async () => {}, hasScheduledWork: () => false,
      send: async (_text, turnSettings) => { settings.push(turnSettings); return { text: settings.length === 1 ? "Need input\n<relay-waiting>yes</relay-waiting>" : "Continuing\n<relay-goal>complete</relay-goal>" }; },
    }) });
  t.after(() => manager.shutdown());
  const chat = await manager.createChat({ agent: "claude", title: "Stable goal instructions", autoTitle: false });
  await manager.send(chat.id, "/goal complete the task");
  assert.equal(store.get(chat.id).goal.status, "paused");
  await manager.send(chat.id, "Here is the requested correction");
  assert.equal(settings.length, 2);
  assert.equal(settings[1].systemPrompt, settings[0].systemPrompt);
  assert.match(settings[0].systemPrompt, /Relay may manage a persistent goal/);
  assert.equal(store.get(chat.id).goal.status, "complete");
});

test("an ordinary correction resumes a paused Claude goal and rearms Relay continuation", async t => {
  const root = await temporaryDirectory(t), store = new ChatStore(root); await store.initialize();
  const calls = [];
  const manager = new RuntimeManager({ store, config: testConfig(root), commands: { list: async () => ({ commands: [{ name: "goal", kind: "CLI command", web: false }] }) },
    broker: new CapabilityBroker({ ttlMs: 10000 }), adapterFactory: () => ({
      start: async () => {}, stop: async () => {}, hasScheduledWork: () => false, isBackgroundBusy: () => false,
      send: async text => {
        calls.push(text);
        if (calls.length === 1) return { text: "Need the correction\n<relay-waiting>yes</relay-waiting>" };
        if (calls.length === 2) return { text: "Correction received; more work remains" };
        return { text: "Everything is finished\n<relay-goal>complete</relay-goal>" };
      },
    }) });
  t.after(() => manager.shutdown());
  const chat = await manager.createChat({ agent: "claude", title: "Goal correction continuation" });
  await manager.send(chat.id, "/goal finish every delivery step");
  assert.equal(store.get(chat.id).goal.status, "paused");
  await manager.send(chat.id, "Use the existing implementation and continue now");
  await waitFor(() => calls.length === 3 && !manager.isBusy(chat.id));
  assert.deepEqual(calls, ["/goal finish every delivery step", "Use the existing implementation and continue now", "/goal resume"]);
  assert.equal(store.get(chat.id).goal.status, "complete");
  assert.deepEqual(store.get(chat.id).messages.filter(message => message.role === "user").map(message => message.text),
    ["/goal finish every delivery step", "Use the existing implementation and continue now"]);
  assert.equal(store.get(chat.id).messages.some(message => message.meta?.source === "relay-goal" && message.meta.input === "/goal resume"), true);
});

test("an admitted Codex skill keeps structured dispatch while unknown names never reach the adapter", async t => {
  const root = await temporaryDirectory(t), store = new ChatStore(root); await store.initialize();
  const calls = [], commands = { list: async () => ({ commands: [{ name: "work", kind: "Skill", path: "/fixture/work/SKILL.md" }] }) };
  const manager = new RuntimeManager({ store, config: testConfig(root), commands, broker: new CapabilityBroker({ ttlMs: 10000 }), adapterFactory: () => ({
    start: async () => {}, stop: async () => {}, send: async (text, settings) => { calls.push({ text, settings }); return { text: "Skill completed" }; },
  }) });
  t.after(() => manager.shutdown()); const chat = await manager.createChat({ agent: "codex", title: "Skill admission" });
  await manager.send(chat.id, "/work inspect this repository");
  assert.match(calls[0].text, /\$work inspect this repository/);
  assert.deepEqual(calls[0].settings.skills, [{ name: "work", path: "/fixture/work/SKILL.md" }]);
  await assert.rejects(manager.submit(chat.id, "/not-installed"), /Unknown command \/not-installed/);
  assert.equal(calls.length, 1);
});

test("a new chat defaults to Auto, validates explicit permission modes and uses its mode on the first turn", async t => {
  const root = await temporaryDirectory(t), store = new ChatStore(root); await store.initialize();
  const calls = [];
  const manager = new RuntimeManager({ store, config: testConfig(root), broker: new CapabilityBroker({ ttlMs: 10000 }), adapterFactory: () => ({
    start: async () => {}, stop: async () => {}, send: async (text, settings) => { calls.push({ text, settings }); return { text: "Done" }; },
  }) });
  t.after(() => manager.shutdown());
  const chat = await manager.createChat({ agent: "codex", title: "First-turn Auto" });
  assert.equal(chat.mode, "auto");
  await manager.send(chat.id, "inspect safely");
  assert.equal(calls[0].settings.mode, "auto");
  await assert.rejects(manager.createChat({ agent: "codex", title: "Invalid mode", mode: "dont_ask" }), /permission mode supported/);
  assert.equal(store.list().filter(item => item.title === "Invalid mode").length, 0);
});

test("permission changes are applied to a live Codex runtime instead of only changing the picker", async t => {
  const root = await temporaryDirectory(t), store = new ChatStore(root); await store.initialize();
  const modes = [], calls = [];
  const manager = new RuntimeManager({ store, config: testConfig(root), broker: new CapabilityBroker({ ttlMs: 10000 }), adapterFactory: () => ({
    start: async () => {}, stop: async () => {},
    send: async (text, settings) => { calls.push({ text, settings }); return { text: "Done" }; },
    setPermissionMode: async (mode, guard, acknowledge) => { guard(); modes.push(mode); acknowledge(); return true; },
  }) });
  t.after(() => manager.shutdown());
  const chat = await manager.createChat({ agent: "codex", title: "Live Auto" });
  await manager.send(chat.id, "start runtime");
  await manager.setMode(chat.id, "accept_edits");
  await manager.setMode(chat.id, "auto");
  assert.deepEqual(modes, ["accept_edits", "auto"]);
  assert.equal(store.get(chat.id).mode, "auto");
  assert.equal(calls[0].settings.mode, "auto");
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
  assert.deepEqual(store.get(chat.id).messages.filter(m => m.kind === "notice" && m.text.startsWith("Goal set:")).map(m => m.text),
    ["Goal set: plan a todo app", "Goal set: create a todo app"]);
  assert.equal(store.get(chat.id).messages.filter(m => m.role === "assistant").at(-1).text, "Goal verified complete");
  await manager.send(chat.id, "/review --base main");
  assert.equal(store.get(chat.id).messages.filter(m => m.role === "assistant").at(-1).text, "Native review completed without a normal prompt.");
  const beforeUnknown = store.get(chat.id).messages.length;
  await assert.rejects(manager.submit(chat.id, "/qualquerporra"), error => error.statusCode === 400 && /Unknown command \/qualquerporra/.test(error.message));
  await assert.rejects(manager.enqueue(chat.id, "/qualquerporra later"), error => error.statusCode === 400 && /Unknown command \/qualquerporra/.test(error.message));
  await assert.rejects(manager.submit(chat.id, "/tmp/project is the folder"), error => error.statusCode === 400 && /Invalid slash command/.test(error.message));
  assert.equal(store.get(chat.id).messages.length, beforeUnknown, "Unknown commands must not become model turns");
  assert.deepEqual(store.get(chat.id).queuedMessages || [], [], "Unknown commands must not enter the queue");
  await manager.send(chat.id, "Inspect /tmp/project as an ordinary path");
  assert.equal(store.get(chat.id).messages.filter(m => m.role === "user").at(-1).text, "Inspect /tmp/project as an ordinary path");
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
