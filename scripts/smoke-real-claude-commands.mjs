import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { RuntimeManager } from "../src/runtime-manager.mjs";
import { ClaudeAdapter } from "../src/adapters/claude.mjs";
import { ChatStore } from "../src/store.mjs";
import { CapabilityBroker } from "../src/capabilities.mjs";
import { CommandCatalog } from "../src/command-catalog.mjs";
import { ModelCatalog } from "../src/models.mjs";
import { loadConfig } from "../src/config.mjs";
import { spawnWorker } from "../src/worker-process.mjs";

// Installed CLI and actual command expansion, with disposable profiles and
// deterministic loopback model replies. No personal settings or real inference.
const directory = await mkdtemp("/tmp/relay-claude-commands-");
const requests = [];
const settingsOnly = process.argv.includes("--settings");
const trace = process.argv.includes("--trace");
const autocompactOnly = process.argv.includes("--autocompact");
const autocompactDisabled = process.argv.includes("--autocompact-disabled");
const adapters = new Map();
let inputTokens = 100;
let manager, timer, timedOut = false;
// The full settings matrix starts more than a dozen real CLI processes. Keep
// an overall bound without canceling its final commands after healthy replies.
const deadlineMs = settingsOnly ? 120000 : 60000;
const server = http.createServer(async (request, response) => {
  let raw = ""; for await (const chunk of request) raw += chunk;
  if (request.url.includes("count_tokens")) { response.writeHead(200, { "content-type": "application/json" }); response.end('{"input_tokens":100}'); return; }
  if (request.method !== "POST" || !/\/messages(?:\?|$)/.test(request.url)) { response.writeHead(404); response.end(); return; }
  const body = JSON.parse(raw), index = requests.push(body), text = "Local command integration fixture completed.";
  const message = { id: `msg_fixture_${index}`, type: "message", role: "assistant", model: body.model, content: [{ type: "text", text }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: inputTokens, output_tokens: 20 } };
  if (!body.stream) { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(message)); return; }
  response.writeHead(200, { "content-type": "text/event-stream" });
  for (const event of [
    { type: "message_start", message: { ...message, content: [], stop_reason: null } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 20 } },
    { type: "message_stop" },
  ]) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  response.end();
});
try {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const config = loadConfig({ AGENT_DATA_DIR: directory, AGENT_DATABASE_MODE: "memory", AGENT_PROCESS_ISOLATION: "none", AGENT_IDLE_TIMEOUT_MS: "60000", CLAUDE_AUTH_MODE: "gateway", ANTHROPIC_API_KEY: "fixture-only" });
  const store = new ChatStore(directory); await store.initialize();
  const catalog = new CommandCatalog(config), broker = new CapabilityBroker({ ttlMs: 120000 }), gatewayOrigin = `http://127.0.0.1:${server.address().port}`;
  manager = new RuntimeManager({ store, config, broker, gatewayOrigin, commands: catalog, models: new ModelCatalog(config), adapterFactory: params => {
    // This fixture normally uses the local adapter directly, without a worker
    // backend. Supply the same local executor contract for the environment
    // precedence case; do not rewrite CLI flags or bypass native policy.
    const executor = autocompactDisabled ? { workspace: params.chat.workspace, runtimeHome: store.runtimeHome(params.chat.id), metadata: { backend: "local" }, environmentVariables: {}, mkdir: directory => mkdir(directory, { recursive: true, mode: 0o700 }), spawn: spawnWorker } : params.executor;
    const adapter = new ClaudeAdapter({ ...params, store, config, broker, gatewayOrigin, executor }); adapters.set(params.chat.id, adapter); return adapter;
  } });
  timer = setTimeout(() => { timedOut = true; if (trace) console.log("Fixture deadline reached"); void manager.shutdown(); server.closeAllConnections(); }, deadlineMs);
  const chat = await manager.createChat({ agent: "claude", title: "Disposable native commands" });
  const submit = async text => {
    const started = performance.now();
    if (trace) console.log(JSON.stringify({ command: text, state: "start" }));
    const before = store.get(chat.id).messages.length;
    await manager.send(chat.id, text);
    assert(!timedOut, `Native command fixture exceeded its ${deadlineMs / 1000}s overall deadline`);
    const added = store.get(chat.id).messages.slice(before);
    if (trace) console.log(JSON.stringify({ command: text, state: store.get(chat.id).status, durationMs: Math.round(performance.now() - started), messages: added.map(message => ({ role: message.role, kind: message.kind, text: message.text?.slice(0, 800) })) }));
    assert.deepEqual(added.filter(message => message.kind === "error").map(message => message.text), [], text);
    const result = added.filter(message => message.role === "assistant" || message.kind === "notice").at(-1)?.text;
    assert(result?.trim(), `${text} must have a visible native result`);
    assert.doesNotMatch(result, /Unknown command|Couldn't parse|No conversation found/i);
    return result;
  };
  if (autocompactDisabled) {
    const saved = () => readFile(path.join(store.runtimeHome(chat.id), "claude/settings.json"), "utf8").then(JSON.parse);
    await submit("/config autoCompact=false"); await submit("/autocompact 100k");
    assert.equal((await saved()).autoCompactEnabled, false, "Changing the threshold must not enable disabled auto-compaction");
    inputTokens = 95000; await submit("Seed high usage while automatic compaction is disabled."); inputTokens = 100;
    await manager.stop(chat.id); const before = requests.length;
    await submit("Continue without compacting the high-usage fixture.");
    assert.equal(requests.length, before + 1); assert(!store.get(chat.id).messages.some(message => /Context compacted automatically/.test(message.text)));
    await manager.send(chat.id, "/autocompact 99k");
    assert.match(store.get(chat.id).messages.at(-1).text, /Couldn't parse/); assert.equal((await saved()).autoCompactWindow, 100000);
    const executor = adapters.get(chat.id).executor;
    executor.environmentVariables = { ...executor.environmentVariables, CLAUDE_CODE_AUTO_COMPACT_WINDOW: "300000" };
    const overridden = await submit("/autocompact 200k"); assert.match(overridden, /CLAUDE_CODE_AUTO_COMPACT_WINDOW/);
    assert.equal((await saved()).autoCompactWindow, 100000, "Native environment precedence must not be bypassed or reported as an applied setting");
    assert.equal(requests.length, before + 1, "Queries, invalid values and overridden settings must not turn into inference");
    console.log(`PASS: installed Claude disabled auto-compaction, actual no-summary continuation after Stop, invalid values and environment precedence. ${requests.length} loopback replies; no external inference or personal profiles.`);
  } else if (autocompactOnly) {
    const saved = () => readFile(path.join(store.runtimeHome(chat.id), "claude/settings.json"), "utf8").then(JSON.parse);
    const compacted = () => store.get(chat.id).messages.filter(message => /Context compacted automatically/.test(message.text));
    await submit("/autocompact 200k"); assert.equal((await saved()).autoCompactWindow, 200000);
    inputTokens = 95000; await submit("Seed the disposable context-usage fixture.");
    inputTokens = 100;
    const before = requests.length;
    await submit("This should fit within the configured 200k window.");
    assert.equal(requests.length, before + 1); assert.equal(compacted().length, 0);
    inputTokens = 95000; await submit("Seed another usage sample for the lower boundary."); inputTokens = 100;
    await submit("/autocompact 100k"); assert.equal((await saved()).autoCompactWindow, 100000);
    assert.match(await submit("/autocompact"), /100k/);
    const sessionId = store.get(chat.id).agentSessionId;
    await manager.stop(chat.id); const checkpoint = requests.length;
    await submit("Continue after Stop and automatically compact the saved high-usage context.");
    assert.equal(store.get(chat.id).agentSessionId, sessionId);
    assert(compacted().length > 0, "Native automatic compaction must emit its actual compact_boundary, not just acknowledge a setting");
    assert(requests.length > checkpoint + 1, "Native compaction must request a summary before continuing");
    await submit("/autocompact auto"); assert.equal((await saved()).autoCompactWindow, undefined);
    console.log(`PASS: installed Claude auto-compaction threshold, actual native summary/boundary, reset and same-session Stop persistence. ${requests.length} loopback replies; no external inference or personal profiles.`);
  } else if (settingsOnly) {
    await submit("/config model=sonnet permissionMode=plan thinking=false");
    assert.equal(requests.length, 0, "Native configuration must not become a model prompt");
    assert.equal(store.get(chat.id).model, "sonnet", "Relay must reflect the native model choice");
    assert.equal(store.get(chat.id).mode, "plan", "Relay must reflect the native permission choice");
    const sessionId = store.get(chat.id).agentSessionId;
    await submit("Verify the actual configured model and mode.");
    assert.match(requests.at(-1).model, /sonnet/i);
    assert(!requests.at(-1).thinking || requests.at(-1).thinking.type === "disabled", "Native thinking=false must reach the request");
    await manager.stop(chat.id); await submit("Continue after Stop with the saved settings.");
    assert.equal(store.get(chat.id).agentSessionId, sessionId); assert.match(requests.at(-1).model, /sonnet/i);
    await submit("/settings model=haiku madeUp=wrong");
    assert.equal(store.get(chat.id).model, "haiku", "A partially applied native command must not leave the picker lying about the saved value");
    // The installed CLI uses Sonnet for Haiku's Plan turns. Leave Plan to
    // assert the requested execution model instead of that native promotion.
    await submit("/config permissionMode=acceptEdits");
    await submit("Continue with the partially applied model."); assert.match(requests.at(-1).model, /haiku/i);
    for (const permission of ["default", "dontAsk", "acceptEdits", "auto", "plan"]) {
      await submit(`/config permissionMode=${permission}`);
      assert.equal(store.get(chat.id).mode, { acceptEdits: "accept_edits", dontAsk: "dont_ask" }[permission] || permission);
    }
    await submit("/effort auto"); assert.equal(store.get(chat.id).effort, "auto");
    assert.match(await submit("/effort status"), /auto/i);
    await submit("/config model=default"); assert.equal(store.get(chat.id).model, "default");
    await submit("/model sonnet"); await submit("/model default"); assert.equal(store.get(chat.id).model, "default");
    console.log(`PASS: installed Claude configuration effects, partial success, permission modes, effort reset and same-session persistence. ${requests.length} loopback replies; no personal profiles or external inference.`);
  } else {
  // Unlike seeded-only smoke checks, begin with a local command in a new chat.
  await submit("/reload-skills"); assert.equal(requests.length, 0);
  const sessionId = store.get(chat.id).agentSessionId;
  await submit("Continue after the local command."); assert.equal(requests.length, 1);
  assert.equal(store.get(chat.id).agentSessionId, sessionId);
  const initialCatalog = await catalog.list(store.get(chat.id));
  assert(!initialCatalog.commands.some(item => item.name === "fixture-rules"));
  await mkdir(path.join(chat.workspace, ".claude", "commands"), { recursive: true });
  await writeFile(path.join(chat.workspace, ".claude", "commands", "fixture-rules.md"), "---\ndescription: Isolated command argument acceptance\n---\nCLAUDE_COMMAND_RULES_CANARY. Apply these arguments: $ARGUMENTS\n");
  await mkdir(path.join(chat.workspace, ".claude", "skills", "fixture-layout"), { recursive: true });
  await writeFile(path.join(chat.workspace, ".claude", "skills", "fixture-layout", "SKILL.md"), "---\nname: fixture-layout\ndescription: Isolated skill acceptance\ndisable-model-invocation: true\n---\nCLAUDE_SKILL_LAYOUT_CANARY. Additional instructions: $ARGUMENTS\n");
  await submit("/reload-skills");
  const refreshed = await catalog.list(store.get(chat.id));
  assert(refreshed.commands.some(item => item.name === "fixture-rules"), "A native skill reload must invalidate the cached Relay command menu immediately");
  const discovered = await catalog.claude(chat);
  for (const name of ["fixture-rules", "fixture-layout", "reload-skills", "autocompact", "config"]) assert(discovered.some(item => item.name === name), `Installed catalog must include ${name}`);
  await submit("/fixture-rules Keep existing policies\nand preserve Unicode: ação.");
  assert.match(JSON.stringify(requests.at(-1).messages), /CLAUDE_COMMAND_RULES_CANARY/);
  assert.match(JSON.stringify(requests.at(-1).messages), /preserve Unicode: ação/);
  await submit("/fixture-layout Keep existing folders");
  assert.match(JSON.stringify(requests.at(-1).messages), /CLAUDE_SKILL_LAYOUT_CANARY/);
  assert.match(JSON.stringify(requests.at(-1).messages), /Keep existing folders/);
  const beforeLocal = requests.length;
  for (const command of ["/reload-skills", "/autocompact 200k", "/settings --help"]) await submit(command);
  assert.equal(requests.length, beforeLocal, "Local commands and aliases must not invoke the model");
  await manager.stop(chat.id); await submit("Continue after explicit Stop.");
  assert.equal(store.get(chat.id).agentSessionId, sessionId);
  assert.match(JSON.stringify(requests.at(-1).messages), /Continue after the local command/);
  console.log(`PASS: installed Claude command-first continuation, saved session resume, native local aliases and actual custom-command/skill expansion. ${requests.length} loopback replies; no external inference or personal profiles.`);
  }
} finally {
  clearTimeout(timer); await manager?.shutdown(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true });
}
