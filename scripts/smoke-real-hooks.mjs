import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { CodexAdapter } from "../src/adapters/codex.mjs";
import { ChatStore } from "../src/store.mjs";
import { CapabilityBroker } from "../src/capabilities.mjs";
import { loadConfig } from "../src/config.mjs";
import { startMcpFixture } from "../test/fixtures/mcp-server.mjs";

// Private fixture hooks and loopback Responses only. Never a host account,
// paid inference, live chat, real delegated agent, or hook-trust bypass.
const directory = await mkdtemp("/tmp/relay-native-hooks-smoke-");
const requests = [];
const server = http.createServer(async (request, response) => {
  if (request.method !== "POST" || !request.url.endsWith("/responses")) { response.writeHead(404); response.end(); return; }
  let body = ""; for await (const chunk of request) body += chunk;
  requests.push(JSON.parse(body)); const id = requests.length;
  const item = { type: "message", id: `msg_${id}`, role: "assistant", status: "completed", content: [{ type: "output_text", text: `Hook fixture response ${id}`, annotations: [] }] };
  response.writeHead(200, { "content-type": "text/event-stream" });
  for (const event of [{ type: "response.created", response: { id: `resp_${id}`, status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item }, { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { id: `resp_${id}`, status: "completed", output: [item], usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 } } }]) response.write(`data: ${JSON.stringify(event)}\n\n`);
  response.end();
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const mcp = await startMcpFixture({ requireAuth: false });
const config = loadConfig({ AGENT_DATA_DIR: directory, AGENT_DATABASE_MODE: "memory", AGENT_PROCESS_ISOLATION: "none", CODEX_AUTH_MODE: "gateway", OPENAI_API_KEY: "fixture-unused", CODEX_MODEL: "gpt-5.4" });
const store = new ChatStore(directory); await store.initialize();
const chat = await store.create({ agent: "codex", title: "Private hook fixture" });
const profile = path.join(store.runtimeHome(chat.id), "codex"), marker = path.join(directory, "hook-calls.jsonl"), source = path.join(profile, "hooks.json");
await mkdir(profile, { recursive: true }); await mkdir(chat.workspace, { recursive: true });
await writeFile(path.join(profile, "config.toml"), `[mcp_servers.fixture]\nurl = ${JSON.stringify(`${mcp.origin}/mcp`)}\n`);
const script = path.join(chat.workspace, "fixture-hook.mjs");
await writeFile(script, `import { appendFileSync } from 'node:fs'; let raw=''; for await (const chunk of process.stdin) raw+=chunk; const input=JSON.parse(raw); appendFileSync(${JSON.stringify(marker)},JSON.stringify({event:input.hook_event_name,version:process.argv[2]})+'\\n'); process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'UserPromptSubmit',additionalContext:'HOOK_CANARY_'+process.argv[2]}}));\n`);
const writeHook = (version, mcpVersion = null) => writeFile(source, JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [
  { type: "command", command: `${JSON.stringify(process.execPath)} ${JSON.stringify(script)} ${version}`, statusMessage: "Private hook fixture" },
  ...(mcpVersion ? [{ type: "mcp_tool", server: "fixture", tool: "fixture_echo", statusMessage: "Private MCP hook fixture", input: { text: JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: `MCP_HOOK_CANARY_${mcpVersion}` } }) } }] : []),
] }] } }));
const calls = async () => (await readFile(marker, "utf8").catch(error => { if (error.code === "ENOENT") return ""; throw error; })).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
await writeHook("V1");
const adapter = new CodexAdapter({ chat, store, config, broker: new CapabilityBroker({ ttlMs: 120000 }), gatewayOrigin: `http://127.0.0.1:${server.address().port}`, hooks: { onFatal: () => {}, onRequest: () => assert.fail("The fixture model must not request tools") } });
const timeout = setTimeout(() => { void adapter.stop(); server.closeAllConnections(); }, 60000);
try {
  await adapter.start();
  const mcpStatus = await adapter.rpc.request("mcpServerStatus/list", { limit: 100 });
  assert.ok(Object.keys(mcpStatus.data.find(item => item.name === "fixture")?.tools || {}).some(name => name.includes("fixture_echo")));
  let catalog = await adapter.hookControls.list(); assert.equal(catalog.threadId, adapter.threadId);
  let selectedType = "command";
  const selected = () => catalog.hooks.find(hook => hook.event === "userPromptSubmit" && hook.type === selectedType);
  const change = async action => { catalog = await adapter.hookControls.change({ id: selected().id, action, confirm: true, threadId: catalog.threadId, revision: catalog.revision }); };
  assert.equal(selected().trust, "untrusted"); assert.equal(requests.length, 0); assert.deepEqual(await calls(), []);
  await adapter.send("Untrusted hook must not execute"); assert.equal((await calls()).length, 0);
  await change("trust"); assert.equal(selected().trust, "trusted"); assert.equal(requests.length, 1); assert.equal((await calls()).length, 0);
  await adapter.send("Trusted hook fixture"); assert.equal((await calls()).length, 1); assert.match(JSON.stringify(requests.at(-1).input), /HOOK_CANARY_V1/);
  await change("disable"); assert.equal(selected().enabled, false);
  await adapter.send("Disabled hook must not execute"); assert.equal((await calls()).length, 1);
  await change("enable"); assert.equal(selected().enabled, true);
  await adapter.send("Enabled hook fixture"); assert.equal((await calls()).length, 2);
  const old = catalog, oldHash = selected().currentHash;
  await writeHook("V2"); catalog = await adapter.hookControls.list();
  assert.equal(selected().trust, "modified"); assert.notEqual(selected().currentHash, oldHash);
  await assert.rejects(adapter.hookControls.change({ id: selected().id, action: "trust", confirm: true, threadId: old.threadId, revision: old.revision }), /changed/);
  await adapter.send("Modified hook must not execute"); assert.equal((await calls()).length, 2);
  await change("trust"); await adapter.send("Retrusted fixture"); assert.equal((await calls()).length, 3); assert.match(JSON.stringify(requests.at(-1).input), /HOOK_CANARY_V2/);
  await change("disable");
  await adapter.stop(); await adapter.start(); catalog = await adapter.hookControls.list();
  assert.equal(selected().enabled, false); assert.equal(selected().trust, "trusted");
  assert.equal(requests.length, 6); assert.deepEqual((await calls()).map(call => call.version), ["V1", "V1", "V2"]);
  selectedType = "mcpTool"; await writeHook("V2", "V1"); catalog = await adapter.hookControls.list();
  assert.equal(selected().trust, "untrusted"); assert.equal(selected().server, "fixture"); assert.equal(selected().tool, "fixture_echo"); assert.equal(Object.hasOwn(selected(), "input"), false);
  await adapter.send("Untrusted MCP hook must not execute"); assert.equal(mcp.calls, 0);
  await change("trust"); await adapter.send("Trusted MCP hook fixture"); assert.equal(mcp.calls, 1); assert.match(JSON.stringify(requests.at(-1).input), /MCP_HOOK_CANARY_V1/);
  const mcpHash = selected().currentHash; await writeHook("V2", "V2"); catalog = await adapter.hookControls.list();
  assert.equal(selected().trust, "modified"); assert.notEqual(selected().currentHash, mcpHash, "MCP input templates participate in native trust hashes");
  await adapter.send("Modified MCP hook must not execute"); assert.equal(mcp.calls, 1);
  await change("trust"); await adapter.send("Retrusted MCP hook fixture"); assert.equal(mcp.calls, 2); assert.match(JSON.stringify(requests.at(-1).input), /MCP_HOOK_CANARY_V2/);
  await change("disable"); await adapter.send("Disabled MCP hook must not execute"); assert.equal(mcp.calls, 2);
  await adapter.stop(); await adapter.start(); catalog = await adapter.hookControls.list();
  assert.equal(selected().enabled, false); assert.equal(selected().trust, "trusted"); assert.equal(requests.length, 11); assert.equal((await calls()).length, 3);
  console.log("PASS: real Codex command and MCP hook execution, hash-bound trust, disable/enable, changed command/argument rejection, source refresh and restart persistence against loopback fixtures. No host account or paid inference.");
} finally {
  clearTimeout(timeout); await adapter.stop(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await mcp.close();
  await rm(directory, { recursive: true, force: true });
}
