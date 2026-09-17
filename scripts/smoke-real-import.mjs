import assert from "node:assert/strict";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { JsonRpcProcess } from "../src/json-rpc-process.mjs";
import { planCodexImport } from "../src/codex-import-plan.mjs";
import { CodexImports } from "../src/codex-imports.mjs";
import { inspectCodexImportFiles } from "../src/codex-import-files.mjs";
import { reconcileCodexImport } from "../src/codex-import-runtime.mjs";
import { CodexAdapter } from "../src/adapters/codex.mjs";
import { ChatStore } from "../src/store.mjs";
import { MemoryRecords } from "../src/database.mjs";
import { CapabilityBroker } from "../src/capabilities.mjs";

// No user setup, account or model endpoint is used by this native migration
// fixture. Every source and target belongs to the private temporary directory.
const directory = await mkdtemp("/tmp/relay-native-import-smoke-");
const fixtureHome = path.join(directory, "home"), workspace = path.join(directory, "project");
const nativeHome = path.join(fixtureHome, ".codex"), cursorWorkspace = path.join(directory, "cursor-project");
const otherWorkspace = path.join(directory, "unselected-project"), instructionsWorkspace = path.join(directory, "instructions-project");
const projectInstructions = "# Existing project instructions\nRETAIN_PROJECT_INSTRUCTIONS\n";
const privateInstructions = "# Existing private instructions\nRETAIN_PRIVATE_INSTRUCTIONS\n";
const hookMarker = path.join(directory, "hook-must-not-run");
const sourceFiles = new Map();
const fixture = async (file, content) => {
  await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, content);
  sourceFiles.set(file, content);
};
const rpc = new JsonRpcProcess({ command: process.env.CODEX_BIN || "codex", args: ["app-server"],
  spawnOptions: { cwd: workspace, env: { PATH: process.env.PATH, HOME: fixtureHome, CODEX_HOME: nativeHome, TMPDIR: directory, CI: "1", NO_COLOR: "1" } } });
const notifications = [], protocolErrors = [];
let importService;
const nativeAdapters = [];
rpc.on("notification", message => { if (message.method.startsWith("externalAgentConfig/")) notifications.push(message); importService?.notification(message); });
rpc.on("protocolError", error => protocolErrors.push(error.message));
rpc.on("error", error => protocolErrors.push(error.message));
rpc.on("request", message => rpc.respondError(message.id, -32601, "No model or tool calls are authorized by this fixture"));
const timeout = setTimeout(() => { void rpc.stop(); for (const adapter of nativeAdapters) void adapter.stop(); }, 45000);
const detect = (migrationSource, cwd, includeHome = true) => rpc.request("externalAgentConfig/detect", { includeHome, cwds: [cwd], maxSessions: 50, maxSessionAgeDays: 30, migrationSource });
const importItems = async (migrationSource, migrationItems) => {
  const providerId = `relay-fixture-${migrationSource}`;
  const response = await rpc.request("externalAgentConfig/import", { migrationItems, migrationSource, source: "relay-test", providerId });
  assert.match(response.importId, /^[a-zA-Z0-9-]+$/);
  let history, completion;
  for (let attempt = 0; attempt < 100; attempt++) {
    const result = await rpc.request("externalAgentConfig/import/readHistories", {});
    history = result.data.find(item => item.importId === response.importId);
    completion = notifications.find(item => item.method === "externalAgentConfig/import/completed" && item.params.importId === response.importId);
    if (history && completion) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(history && completion, "Await both persisted results and the matching completion notification, not merely an import ID");
  assert.equal(history.providerId, providerId);
  assert.ok(notifications.some(item => item.method === "externalAgentConfig/import/progress" && item.params.importId === response.importId));
  const sorted = values => values.map(value => JSON.stringify(value)).sort();
  assert.deepEqual(sorted(completion.params.itemTypeResults.flatMap(item => item.successes)), sorted(history.successes));
  assert.deepEqual(sorted(completion.params.itemTypeResults.flatMap(item => item.failures)), sorted(history.failures));
  return history;
};
const sessionFixture = async (cwd, title) => {
  const sessionId = randomUUID(), userId = randomUUID(), timestamp = new Date().toISOString();
  const project = path.join(fixtureHome, ".claude", "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
  const file = path.join(project, `${sessionId}.jsonl`);
  await mkdir(cwd, { recursive: true });
  await fixture(file, [
    { type: "user", uuid: userId, parentUuid: null, sessionId, cwd, timestamp, isSidechain: false, isMeta: false, message: { role: "user", content: title } },
    { type: "assistant", uuid: randomUUID(), parentUuid: userId, sessionId, cwd, timestamp, isSidechain: false, message: { role: "assistant", content: [{ type: "text", text: "Fixture history retained." }] } },
  ].map(value => JSON.stringify(value)).join("\n") + "\n");
  return file;
};
try {
  await mkdir(nativeHome, { recursive: true }); await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "AGENTS.md"), projectInstructions);
  await writeFile(path.join(nativeHome, "AGENTS.md"), privateInstructions);
  await fixture(path.join(workspace, "CLAUDE.md"), "# Fixture project instructions\nPrefer the teal fixture theme.\n");
  await fixture(path.join(instructionsWorkspace, "CLAUDE.md"), "# New fixture instructions\nThis is the instructions-only fixture.\n");
  await fixture(path.join(fixtureHome, ".claude", "CLAUDE.md"), "# Fixture home instructions\nUse the fixture assertions.\n");
  await fixture(path.join(workspace, ".claude", "skills", "fixture-skill", "SKILL.md"), "---\nname: fixture-skill\ndescription: An isolated import fixture\n---\nUse the local fixture.\n");
  await fixture(path.join(workspace, ".claude", "skills", "unselected-skill", "SKILL.md"), "---\nname: unselected-skill\ndescription: An unselected import fixture\n---\nDo not import this skill.\n");
  await fixture(path.join(workspace, ".claude", "commands", "fixture-check.md"), "---\ndescription: Review the import fixture\n---\nReview the fixture $ARGUMENTS.\n");
  await fixture(path.join(workspace, ".claude", "agents", "fixture-reviewer.md"), "---\nname: fixture-reviewer\ndescription: Review fixture changes\n---\nReview only the fixture.\n");
  await fixture(path.join(workspace, ".claude", "settings.json"), JSON.stringify({ permissions: { defaultMode: "default" }, hooks: { Stop: [{ hooks: [{ type: "command", command: `printf executed > ${hookMarker}` }] }] } }));
  await fixture(path.join(fixtureHome, ".claude", "settings.json"), JSON.stringify({ model: "claude-sonnet-4-5", permissions: { defaultMode: "default", deny: ["Read(.env)"] }, env: { FIXTURE_IMPORT_VALUE: "not-a-secret" } }));
  await fixture(path.join(fixtureHome, ".claude", "commands", "home-fixture.md"), "Review the home fixture.\n");
  await fixture(path.join(fixtureHome, ".claude", "commands", "unselected-command.md"), "Do not import this command.\n");
  await fixture(path.join(workspace, ".mcp.json"), JSON.stringify({ mcpServers: { "fixture-mcp": { command: "false", args: [] }, "unselected-mcp": { command: "false", args: [] } } }));
  const selectedSession = await sessionFixture(workspace, "A real-format isolated import fixture, not a live chat.");
  const unselectedSession = await sessionFixture(otherWorkspace, "Unselected project history.");
  await fixture(path.join(path.dirname(selectedSession), "memory", "MEMORY.md"), "# Fixture project memory\nThe theme is teal.\n");
  await fixture(path.join(cursorWorkspace, ".cursorrules"), "# Cursor fixture instructions\nUse cursor-specific assertions.\n");
  await fixture(path.join(cursorWorkspace, ".cursor", "rules", "fixture.mdc"), "---\ndescription: Fixture project rule\nglobs: '**/*.mjs'\nalwaysApply: true\n---\nUse the Cursor fixture rule.\n");
  await fixture(path.join(cursorWorkspace, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: { "cursor-fixture-mcp": { command: "false", args: [] } } }));
  rpc.start();
  await rpc.request("initialize", { clientInfo: { name: "relay_import_smoke", version: "0.1.0" }, capabilities: { experimentalApi: true } });
  rpc.notify("initialized", {});
  const detected = await detect("claude-code", workspace);
  assert.deepEqual(detected.items.map(item => item.itemType).sort(), ["CONFIG", "COMMANDS", "HOOKS", "MCP_SERVER_CONFIG", "SESSIONS", "SKILLS", "SUBAGENTS"].sort());
  assert.ok(detected.items.find(item => item.itemType === "SESSIONS").details.sessions.some(item => item.path === unselectedSession), "Native home discovery is broader than the requested project; the web adapter must filter it");
  const projectOnly = await detect("claude-code", workspace, false);
  assert.ok(projectOnly.items.every(item => item.cwd === workspace));
  const review = planCodexImport(detected, { source: "claude-code", workspace, home: fixtureHome, includeHome: true });
  assert.equal(review.catalog.excludedSessions, 1);
  assert.equal(review.catalog.items.filter(item => item.itemType === "SESSIONS").length, 1);
  const selected = review.select(review.catalog.items.map(item => item.id)).migrationItems.map(item => {
    // Deliberately narrow metadata in this isolated contract probe only. The
    // production plan above retains whole groups, because native ignores these
    // filters for everything except sessions (asserted below).
    const fields = { SESSIONS: ["sessions", value => value.path === selectedSession], SKILLS: ["skills", value => value.name === "fixture-skill"], COMMANDS: ["commands", value => value.name === "source-command-home-fixture"], MCP_SERVER_CONFIG: ["mcpServers", value => value.name === "fixture-mcp"] };
    if (!fields[item.itemType]) return item;
    const [field, accept] = fields[item.itemType], values = item.details[field].filter(accept);
    assert.equal(values.length, 1);
    return { ...item, details: { ...item.details, [field]: values } };
  });
  const history = await importItems("claude-code", selected);
  assert.deepEqual(history.failures, []);
  // In 0.154.0, these detail arrays are catalog metadata, NOT selection
  // filters. Only SESSIONS honors its detail subset. The web UI must select
  // whole non-session migration groups and never promise per-entry isolation.
  assert.equal(history.successes.length, selected.length + 3);
  assert.equal(await readFile(path.join(workspace, "AGENTS.md"), "utf8"), projectInstructions);
  assert.equal(await readFile(path.join(nativeHome, "AGENTS.md"), "utf8"), privateInstructions);
  assert.match(await readFile(path.join(workspace, ".agents", "skills", "fixture-skill", "SKILL.md"), "utf8"), /Use the local fixture/);
  assert.match(await readFile(path.join(workspace, ".agents", "skills", "unselected-skill", "SKILL.md"), "utf8"), /Do not import this skill/);
  assert.match(await readFile(path.join(fixtureHome, ".agents", "skills", "source-command-unselected-command", "SKILL.md"), "utf8"), /Do not import this command/);
  const projectConfig = await readFile(path.join(workspace, ".codex", "config.toml"), "utf8");
  assert.match(projectConfig, /fixture-mcp/); assert.match(projectConfig, /unselected-mcp/);
  assert.match(await readFile(path.join(workspace, ".codex", "hooks.json"), "utf8"), /hook-must-not-run/);
  await assert.rejects(readFile(hookMarker), { code: "ENOENT" });
  const sessions = history.successes.filter(item => item.itemType === "SESSIONS");
  assert.equal(sessions.length, 1); assert.equal(sessions[0].source, selectedSession);
  const { thread } = await rpc.request("thread/read", { threadId: sessions[0].target, includeTurns: true });
  assert.equal(thread.id, sessions[0].target); assert.equal(thread.cwd, workspace);
  assert.match(JSON.stringify(thread.turns), /A real-format isolated import fixture, not a live chat\./);
  assert.match(JSON.stringify(thread.turns), /Fixture history retained\./);
  assert.doesNotMatch(JSON.stringify(thread.turns), /Unselected project history/);
  const after = await detect("claude-code", workspace);
  assert.deepEqual(after.items.find(item => item.itemType === "SESSIONS").details.sessions.map(item => item.path), [unselectedSession]);
  assert.deepEqual(after.items.map(item => item.itemType), ["SESSIONS"]);
  const instructions = await detect("claude-code", instructionsWorkspace, false);
  assert.deepEqual(instructions.items.map(item => item.itemType), ["AGENTS_MD"]);
  const newInstructions = await importItems("claude-code", instructions.items);
  assert.deepEqual(newInstructions.failures, []);
  assert.equal(await readFile(path.join(instructionsWorkspace, "AGENTS.md"), "utf8"), sourceFiles.get(path.join(instructionsWorkspace, "CLAUDE.md")));
  const cursor = await detect("cursor", cursorWorkspace);
  assert.deepEqual(cursor.items.map(item => item.itemType).sort(), ["AGENTS_MD", "MCP_SERVER_CONFIG"]);
  const cursorHistory = await importItems("cursor", cursor.items);
  assert.deepEqual(cursorHistory.failures, []);
  // Native conversion rewrites the product name in the target; the source
  // itself must still stay byte-for-byte unchanged (verified below).
  assert.equal(await readFile(path.join(cursorWorkspace, "AGENTS.md"), "utf8"), "# Codex fixture instructions\nUse cursor-specific assertions.\n");
  assert.match(await readFile(path.join(cursorWorkspace, ".codex", "config.toml"), "utf8"), /cursor-fixture-mcp/);
  const collisionWorkspace = path.join(directory, "collision-project");
  await fixture(path.join(collisionWorkspace, "CLAUDE.md"), "# Late collision fixture\nImported instructions.\n");
  const beforeCollision = await detect("claude-code", collisionWorkspace, false);
  assert.deepEqual(beforeCollision.items.map(item => item.itemType), ["AGENTS_MD"]);
  await writeFile(path.join(collisionWorkspace, "AGENTS.md"), "Retain this file created after detection.\n");
  const collision = await importItems("claude-code", beforeCollision.items);
  assert.deepEqual(collision.successes, []); assert.deepEqual(collision.failures, []);
  assert.equal(await readFile(path.join(collisionWorkspace, "AGENTS.md"), "utf8"), "Retain this file created after detection.\n");
  await rpc.stop(); rpc.start();
  await rpc.request("initialize", { clientInfo: { name: "relay_import_smoke", version: "0.1.0" }, capabilities: { experimentalApi: true } });
  rpc.notify("initialized", {});
  const restored = await rpc.request("externalAgentConfig/import/readHistories", {});
  assert.deepEqual(restored.data.find(item => item.importId === history.importId), history);
  const retainedThread = await rpc.request("thread/read", { threadId: sessions[0].target, includeTurns: true });
  assert.deepEqual(retainedThread.thread.turns, thread.turns);
  const lifecycleWorkspace = path.join(directory, "lifecycle-project"), trackingFile = path.join(directory, "import-operation.json");
  await fixture(path.join(lifecycleWorkspace, "CLAUDE.md"), "# Lifecycle fixture\nRetain this source.\n");
  await sessionFixture(lifecycleWorkspace, "Lifecycle-only imported conversation");
  const root = await rpc.request("thread/start", { cwd: lifecycleWorkspace, model: "gpt-5.4", approvalPolicy: "never", sandbox: "workspace-write" });
  let nativeImportCalls = 0;
  const serviceArgs = {
    workspace: lifecycleWorkspace, home: fixtureHome, binding: `fixture:${lifecycleWorkspace}`, thread: () => root.thread.id, mutable: true,
    request: async (method, params) => { if (method === "externalAgentConfig/import") nativeImportCalls++; return rpc.request(method, params); },
    inspect: (input, check) => inspectCodexImportFiles(null, { ...input, workspace: lifecycleWorkspace, home: fixtureHome, codexHome: nativeHome }, check),
    save: async value => { await writeFile(trackingFile, JSON.stringify(value)); },
    reconcile: (input, check) => reconcileCodexImport({ request: (method, params) => rpc.request(method, params), workspace: lifecycleWorkspace,
      inspect: (selection, guard) => serviceArgs.inspect(selection, guard), changed: () => rpc.request("skills/list", { cwds: [lifecycleWorkspace], forceReload: true }) }, input, check),
  };
  importService = new CodexImports({ ...serviceArgs, workerId: "fixture-native-worker-a" });
  const serviceReview = await importService.list();
  assert.deepEqual(serviceReview.items.map(item => item.itemType).sort(), ["AGENTS_MD", "SESSIONS"]);
  const confirmation = { requestId: randomUUID(), source: serviceReview.source, threadId: serviceReview.threadId, revision: serviceReview.revision, ids: serviceReview.items.map(item => item.id), confirm: true };
  await importService.start(confirmation);
  let serviceState;
  for (let attempt = 0; attempt < 100; attempt++) {
    serviceState = await importService.refresh();
    if (serviceState.operations[0].phase === "completed" && !serviceState.needsRefresh) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(serviceState.operations[0].phase, "completed"); assert.equal(serviceState.needsRefresh, false);
  assert.ok(serviceState.operations[0].results.every(item => item.imported === 1 && item.failed === 0 && item.notReported === 0));
  assert.equal((await importService.start(confirmation)).reused, true); assert.equal(nativeImportCalls, 1);
  const serviceSession = importService.importedSession(confirmation.requestId, serviceState.operations[0].sessions[0].id);
  const importedThread = await rpc.request("thread/read", { threadId: serviceSession.threadId, includeTurns: true });
  assert.equal(importedThread.thread.cwd, lifecycleWorkspace);
  assert.match(JSON.stringify(importedThread.thread.turns), /Lifecycle-only imported conversation/);
  await rpc.stop(); await importService.workerStopped("fixture-native-worker-a");
  const savedOperation = JSON.parse(await readFile(trackingFile, "utf8"));
  rpc.start();
  await rpc.request("initialize", { clientInfo: { name: "relay_import_smoke", version: "0.1.0" }, capabilities: { experimentalApi: true } });
  rpc.notify("initialized", {});
  importService = new CodexImports({ ...serviceArgs, workerId: "fixture-native-worker-b", saved: savedOperation });
  assert.equal((await importService.start(confirmation)).reused, true);
  assert.equal((await importService.refresh()).needsRefresh, false); assert.equal(nativeImportCalls, 1);
  // Exercise the actual production adapter too: its private runtime paths,
  // durable-record callbacks, RPC event routing and exact exit observation.
  // This smoke injects test records; production uses encrypted PostgreSQL.
  const store = new ChatStore(path.join(directory, "relay-adapter"), new MemoryRecords()); await store.initialize();
  const adapterChat = await store.create({ agent: "codex", title: "Private native import smoke" });
  await fixture(path.join(adapterChat.workspace, "CLAUDE.md"), "# Adapter import fixture\nKeep this source unchanged.\n");
  const config = { processIsolation: "none", codex: { bin: process.env.CODEX_BIN || "codex", authMode: "gateway", providerKey: "fixture-not-a-provider-key", model: "gpt-5.4" } };
  const makeAdapter = () => {
    const adapter = new CodexAdapter({ chat: store.get(adapterChat.id), store, config, broker: new CapabilityBroker({ ttlMs: 60000 }), gatewayOrigin: "http://127.0.0.1:9",
      hooks: { onSessionId: id => store.update(adapterChat.id, { agentSessionId: id }), onEvent: () => {}, onFatal: error => protocolErrors.push(error.message) } });
    nativeAdapters.push(adapter); return adapter;
  };
  const adapter = makeAdapter(); await adapter.start();
  const adapterReview = await adapter.importControls.list(); assert.deepEqual(adapterReview.items.map(item => item.itemType), ["AGENTS_MD"]);
  const adapterConfirmation = { requestId: randomUUID(), source: adapterReview.source, threadId: adapterReview.threadId, revision: adapterReview.revision, ids: adapterReview.items.map(item => item.id), confirm: true };
  await adapter.importControls.start(adapterConfirmation);
  let adapterResult;
  for (let attempt = 0; attempt < 100; attempt++) {
    adapterResult = await adapter.importControls.refresh();
    if (!adapterResult.needsRefresh) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(adapterResult.operations[0].phase, "completed"); assert.equal(adapterResult.needsRefresh, false);
  assert.equal(await readFile(path.join(adapterChat.workspace, "AGENTS.md"), "utf8"), await readFile(path.join(adapterChat.workspace, "CLAUDE.md"), "utf8"));
  await adapter.stop(); assert.equal((await store.records.get("native-import", adapterChat.id)).jobs[0].workerStopped, true);
  const restarted = makeAdapter(); await restarted.start();
  assert.equal(restarted.importControls.status().operations[0].phase, "completed");
  // A never-messaged native root may have no rollout to resume. The adapter
  // can replace that empty root, but must retain the import outcome and reject
  // its stale confirmation instead of running it against the replacement.
  if (restarted.threadId === adapterConfirmation.threadId) assert.equal((await restarted.importControls.start(adapterConfirmation)).reused, true);
  else {
    await assert.rejects(restarted.importControls.start(adapterConfirmation), /current import review/);
    await assert.rejects(restarted.importControls.start({ ...adapterConfirmation, threadId: restarted.threadId }), /different selection/);
  }
  const savedAdapterImport = (await store.records.get("native-import", adapterChat.id)).jobs[0];
  assert.equal((await restarted.rpc.request("externalAgentConfig/import/readHistories", {})).data.filter(item => item.providerId === savedAdapterImport.providerId).length, 1);
  await restarted.stop();
  for (const [file, content] of sourceFiles) assert.equal(await readFile(file, "utf8"), content, "Native import must preserve every source file");
  assert.deepEqual(protocolErrors, []);
  console.log("PASS: installed native Claude/Cursor imports, production adapter inspection/reconciliation/storage wiring, exact worker-stop tracking, whole-group imports versus selected sessions, source/history preservation and idempotent recovery across restart. Temporary profiles and test records only; no user account or model calls.");
} finally { clearTimeout(timeout); await Promise.allSettled(nativeAdapters.map(adapter => adapter.stop())); await rpc.stop(); await rm(directory, { recursive: true, force: true }); }
