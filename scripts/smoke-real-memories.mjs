import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { CodexAdapter } from "../src/adapters/codex.mjs";
import { ChatStore } from "../src/store.mjs";
import { CapabilityBroker } from "../src/capabilities.mjs";
import { loadConfig } from "../src/config.mjs";

// The only model endpoint is this loopback fixture. SQLite is read-only evidence
// of native thread contribution state, never an implementation of memory controls.
const directory = await mkdtemp("/tmp/relay-native-memories-smoke-");
const requests = [];
const consolidation = request => request.input?.some(item => item.role === "user" && item.content?.some?.(part => part.text?.startsWith("## Memory Writing Agent: Phase 2 (Consolidation)")));
const userRequests = () => requests.filter(request => !consolidation(request));
const server = http.createServer(async (request, response) => {
  if (request.method !== "POST" || !request.url.endsWith("/responses")) { response.writeHead(404); response.end(); return; }
  let body = ""; for await (const chunk of request) body += chunk;
  requests.push(JSON.parse(body)); const id = requests.length;
  const item = { type: "message", id: `msg_${id}`, role: "assistant", status: "completed", content: [{ type: "output_text", text: `Memory fixture response ${id}`, annotations: [] }] };
  response.writeHead(200, { "content-type": "text/event-stream" });
  for (const event of [{ type: "response.created", response: { id: `resp_${id}`, status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item }, { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { id: `resp_${id}`, status: "completed", output: [item], usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 } } }]) response.write(`data: ${JSON.stringify(event)}\n\n`);
  response.end();
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const config = loadConfig({ AGENT_DATA_DIR: directory, AGENT_DATABASE_MODE: "memory", AGENT_PROCESS_ISOLATION: "none", CODEX_AUTH_MODE: "gateway", OPENAI_API_KEY: "unused-fixture", CODEX_MODEL: "gpt-5.4" });
const store = new ChatStore(directory); await store.initialize();
const chat = await store.create({ agent: "codex", title: "Private memory fixture" }); await mkdir(chat.workspace, { recursive: true });
const profile = path.join(store.runtimeHome(chat.id), "codex"), memoryDirectory = path.join(profile, "memories");
const adapter = new CodexAdapter({ chat, store, config, broker: new CapabilityBroker({ ttlMs: 120000 }), gatewayOrigin: `http://127.0.0.1:${server.address().port}`, hooks: { onFatal: () => {}, onRequest: () => assert.fail("The fixture model must not request tools") } });
const timeout = setTimeout(() => { void adapter.stop(); server.closeAllConnections(); }, 60000);
const state = async threadId => {
  const file = (await readdir(profile)).find(name => /^state_.*\.sqlite$/.test(name)); assert.ok(file);
  const db = new DatabaseSync(path.join(profile, file), { readOnly: true });
  try { return db.prepare("select id,memory_mode,rollout_path from threads where id = ?").get(threadId); } finally { db.close(); }
};
try {
  await adapter.start(); let catalog = await adapter.memoryControls.list();
  const selected = id => catalog.controls.find(item => item.id === id);
  const change = async (id, action) => { catalog = await adapter.memoryControls.change({ id, action, confirm: true, threadId: catalog.threadId, revision: catalog.revision }); };
  const unchanged = async () => {
    const result = await adapter.rpc.request("config/read", { cwd: chat.workspace, includeLayers: false });
    return Object.fromEntries(["model", "model_provider", "approval_policy", "sandbox_mode", "sandbox_workspace_write", "mcp_servers"].map(key => [key, result.config[key]]));
  };
  const before = await unchanged(); assert.deepEqual(catalog.controls.map(item => item.enabled), [false, true, true]);
  await change("generate", "disable"); assert.equal((await state(adapter.threadId)).memory_mode, "disabled");
  await change("feature", "enable"); assert.equal((await state(adapter.threadId)).memory_mode, "disabled");
  await change("use", "disable"); assert.equal(selected("use").enabled, false);
  assert.deepEqual(await unchanged(), before); assert.equal(requests.length, 0);
  await mkdir(memoryDirectory, { recursive: true });
  await writeFile(path.join(memoryDirectory, "memory_summary.md"), "# Private fixture memory\nRELAY_MEMORY_CANARY_7291: prefer the teal fixture theme.\n");
  await writeFile(path.join(memoryDirectory, "MEMORY.md"), "# Fixture evidence\nRELAY_MEMORY_DETAIL_7291\n");
  await adapter.stop(); adapter.threadId = null; await adapter.start(); catalog = await adapter.memoryControls.list();
  assert.equal(selected("feature").enabled, true); assert.equal(selected("use").enabled, false); assert.equal(selected("generate").enabled, false);
  await adapter.send("Reply with the memory fixture response");
  assert.doesNotMatch(JSON.stringify(userRequests().at(-1)), /RELAY_MEMORY_CANARY_7291/);
  await change("use", "enable"); const old = catalog;
  await adapter.stop(); adapter.threadId = null; await adapter.start(); catalog = await adapter.memoryControls.list();
  await adapter.send("Reply with another fixture response");
  assert.match(JSON.stringify(userRequests().at(-1)), /RELAY_MEMORY_CANARY_7291/, "The real CLI should inject the existing local memory summary when enabled");
  const root = adapter.threadId;
  await assert.rejects(adapter.memoryControls.change({ id: "use", action: "disable", confirm: true, threadId: old.threadId, revision: old.revision }), /session changed/);
  await change("generate", "enable"); assert.equal((await state(root)).memory_mode, "enabled");
  await change("generate", "disable"); assert.equal((await state(root)).memory_mode, "disabled");
  const nativeBeforeReset = await state(root), transcriptBefore = await readFile(nativeBeforeReset.rollout_path, "utf8"), savedConfig = await readFile(path.join(profile, "config.toml"), "utf8");
  const sibling = path.join(directory, "unrelated-profile", "memories"); await mkdir(sibling, { recursive: true }); await writeFile(path.join(sibling, "MEMORY.md"), "Keep unrelated memory");
  await change("reset", "reset");
  assert.equal(catalog.reset, true); assert.equal(await readFile(path.join(profile, "config.toml"), "utf8"), savedConfig);
  assert.deepEqual((await readdir(memoryDirectory).catch(error => { if (error.code === "ENOENT") return []; throw error; })).filter(name => /memory_summary|MEMORY/.test(name)), []);
  assert.equal(await readFile(path.join(sibling, "MEMORY.md"), "utf8"), "Keep unrelated memory");
  assert.equal((await state(root)).memory_mode, "disabled");
  const transcriptAfter = await readFile(nativeBeforeReset.rollout_path, "utf8"); assert.ok(transcriptAfter.startsWith(transcriptBefore), "Reset must retain native conversation history");
  await adapter.stop(); await adapter.start(); catalog = await adapter.memoryControls.list();
  assert.equal(adapter.threadId, root); assert.equal(selected("generate").enabled, false); assert.equal((await state(root)).memory_mode, "disabled");
  await adapter.send("Continue the retained conversation");
  // Native generate_memories controls eligibility of chat inputs, not whether
  // already-existing memories can be consolidated on startup. Account for that
  // real native behavior explicitly instead of mistaking it for a user turn.
  assert.equal(userRequests().length, 3);
  assert.ok(requests.filter(request => consolidation(request)).length >= 1, "The seeded local-memory fixture should exercise native startup consolidation");
  assert.ok(userRequests().every(request => request.model === "gpt-5.4"));
  console.log("PASS: native memory opt-in/out, real summary injection, current-thread generation state, startup consolidation, restart persistence and scoped reset preserve config, unrelated memories and conversation history. Private profiles and loopback model responses only.");
} finally {
  clearTimeout(timeout); await adapter.stop(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true });
}
