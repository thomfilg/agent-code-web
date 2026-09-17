import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { RuntimeManager } from "../src/runtime-manager.mjs";
import { ClaudeAdapter } from "../src/adapters/claude.mjs";
import { ChatStore } from "../src/store.mjs";
import { CapabilityBroker } from "../src/capabilities.mjs";
import { CommandCatalog } from "../src/command-catalog.mjs";
import { loadConfig } from "../src/config.mjs";

// Installed CLI and actual command expansion, with disposable profiles and
// deterministic loopback model replies. No personal settings or real inference.
const directory = await mkdtemp("/tmp/relay-claude-commands-");
const requests = [];
let manager, timer;
const server = http.createServer(async (request, response) => {
  let raw = ""; for await (const chunk of request) raw += chunk;
  if (request.url.includes("count_tokens")) { response.writeHead(200, { "content-type": "application/json" }); response.end('{"input_tokens":100}'); return; }
  if (request.method !== "POST" || !/\/messages(?:\?|$)/.test(request.url)) { response.writeHead(404); response.end(); return; }
  const body = JSON.parse(raw), index = requests.push(body), text = "Local command integration fixture completed.";
  const message = { id: `msg_fixture_${index}`, type: "message", role: "assistant", model: body.model, content: [{ type: "text", text }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 100, output_tokens: 20 } };
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
  manager = new RuntimeManager({ store, config, broker, gatewayOrigin, commands: catalog, adapterFactory: params => new ClaudeAdapter({ ...params, store, config, broker, gatewayOrigin }) });
  timer = setTimeout(() => { void manager.shutdown(); server.closeAllConnections(); }, 60000);
  const chat = await manager.createChat({ agent: "claude", title: "Disposable native commands" });
  const submit = async text => {
    const before = store.get(chat.id).messages.length;
    await manager.send(chat.id, text);
    const added = store.get(chat.id).messages.slice(before);
    assert.deepEqual(added.filter(message => message.kind === "error").map(message => message.text), [], text);
    const result = added.filter(message => message.role === "assistant").at(-1)?.text;
    assert(result?.trim(), `${text} must have a visible native result`);
    assert.doesNotMatch(result, /Unknown command|Couldn't parse|No conversation found/i);
    return result;
  };
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
} finally {
  clearTimeout(timer); await manager?.shutdown(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true });
}
